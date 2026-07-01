// ──────────────────────────────────────────────
// /v1/chat/completions handler — v2 orchestrator
// ──────────────────────────────────────────────
//
// Accepts an OpenAI Chat Completions request, runs it through the local
// Claude Agent SDK, and emits OpenAI-format SSE chunks (or a single JSON
// response when stream=false).
//
// v2 pipeline per request:
//   1. Parse model ([1m] variants → tier alias + env pin), settings
//      (effort / thinking / stops / max_tokens from the request body, with
//      the companion UI extension's `claude_subscription` namespace).
//   2. System messages → SDK systemPrompt (plain client string by default —
//      the roleplay path; optional claude_code-preset "identity mode").
//   3. Prior turns → synthetic Claude Code JSONL session, replayed through a
//      one-shot SessionStore + `resume` so the model sees REAL multi-turn
//      context (role fidelity + prompt caching). Trailing-assistant prefill
//      becomes a continuation instruction. Falls back to the v1 transcript
//      fold on any resume-path failure.
//   4. Query with the roleplay isolation recipe: tools:[], skills:[],
//      settingSources:[], bypassPermissions + explicit opt-in, no MCP.
//   5. Stream translation: text deltas → delta.content (with server-side
//      stop-sequence enforcement — the SDK has none), thinking deltas →
//      delta.reasoning_content (SillyTavern renders these natively).
//   6. Resilience ladder (from Meridian, retries only before first output):
//      expired token → out-of-band OAuth refresh + one retry;
//      [1m] Extra-Usage failure → strip to base model + 1h cooldown + retry;
//      rate limit → up to 2 retries with 1s/2s backoff.
//   7. Privacy sweep: best-effort delete of the live-turn transcript the CLI
//      wrote under ~/.claude/projects (roleplay text shouldn't persist).

import { randomUUID } from 'node:crypto';

import { loadSdk } from './sdk-loader.js';
import { renderTranscript } from './transcript.js';
import { extractSettings } from './settings.js';
import { parseModelRequest, isExtendedContextKnownUnavailable, recordExtendedContextUnavailable } from './models.js';
import { buildSubprocessEnv, pickApiKeyFromAuthHeader } from './env.js';
import { buildSystemPrompt, extractSystemText } from './system-prompt.js';
import { assembleEntries, splitHistoryForResume, currentToSdkUserMessage, singleMessageStream, SDK_VERSION } from './jsonl-entries.js';
import { ResumeSessionStore, resumeScratchCwd, sweepSessionTranscript } from './session-store.js';
import { StopScanner } from './stops.js';
import { makeCompletionId, writeSse, chunkShell, roleChunk, contentChunk, reasoningChunk, finishChunk, errorEvent, toOpenAiUsage } from './sse.js';
import { isExpiredTokenError, isRateLimitError, isExtraUsageRequiredError, isStaleSessionError, refreshOAuthToken } from './oauth.js';

const PLUGIN_TAG = '[claude-subscription]';
const MAX_RATE_LIMIT_RETRIES = 2;
// Below this max_tokens, the CLI's derived thinking budget violates the
// API's >= 1024 floor on non-adaptive models (verified live).
const MIN_MAX_TOKENS_FOR_THINKING = 2048;
// Absolute deadline for non-streaming queries (no heartbeat exists between
// init and the finished assistant message, so idle-based detection is
// impossible; this only reaps a truly hung subprocess).
const NONSTREAM_DEADLINE_MS = 10 * 60 * 1000;
// No real upstream message for this long → abort (downstream keep-alives can
// mask a hung subprocess forever otherwise). Meridian uses the same figure.
const UPSTREAM_IDLE_MS = 90000;

const envFlag = (name, fallback) => {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return !/^(0|false|no|off)$/i.test(v);
};

function buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume }) {
    const options = {
        abortController,
        model: oneMActive ? modelInfo.sdkModel : modelInfo.baseId,
        systemPrompt: buildSystemPrompt(systemText, settings.identityMode),
        includePartialMessages: stream,
        env,

        // Roleplay isolation recipe — SillyTavern owns the conversation
        // surface; nothing from the host machine may leak into the context:
        tools: [],                    // no built-in agent tools (0.2.x enforces this)
        skills: [],                   // no skills
        settingSources: [],           // no ~/.claude settings, CLAUDE.md, hooks, output styles
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true, // required with bypassPermissions on 0.2.x

        // maxTurns: 1 is safe with tools:[] (no tool round-trips) and is what
        // Marinara ships in production on this SDK line. Overridable because
        // v1 removed it over thinking-steps-consume-turns (their PR #294).
        maxTurns: Number(process.env.CLAUDE_SUBSCRIPTION_MAX_TURNS) || 1,
    };

    if (process.env.CLAUDE_SUBSCRIPTION_CLAUDE_PATH) {
        options.pathToClaudeCodeExecutable = process.env.CLAUDE_SUBSCRIPTION_CLAUDE_PATH;
    }

    // Thinking / effort. ALWAYS set thinking explicitly — omitting it lets
    // the CLI auto-enable thinking with a budget derived from
    // CLAUDE_CODE_MAX_OUTPUT_TOKENS, which 400s below ~2048 max tokens
    // ("thinking.enabled.budget_tokens: Input should be >= 1024", verified
    // live). Rules:
    //   • Adaptive-only families (Opus 4.7+, Fable) natively adapt; no
    //     budget field is ever sent — safe at any max_tokens. Always adaptive.
    //   • Other models translate adaptive/enabled into a budgeted request;
    //     with max_tokens set below MIN_MAX_TOKENS_FOR_THINKING the budget
    //     is illegal, so thinking is forced off (raise SillyTavern's "Max
    //     response length" to re-enable).
    // `display` controls whether thinking CONTENT is emitted at all: without
    // it the CLI streams only a signature and delivers an EMPTY thinking
    // block (verified live on 0.2.141) — 'summarized' streams real
    // thinking_delta events; 'omitted' saves the bandwidth when the user
    // hides reasoning.
    const display = settings.showReasoning ? 'summarized' : 'omitted';
    if (modelInfo.adaptiveOnly) {
        options.thinking = { type: 'adaptive', display };
    } else {
        const wantsThinking = settings.thinking === 'adaptive' || settings.thinking === 'on';
        const roomForThinking = !settings.maxTokens || settings.maxTokens >= MIN_MAX_TOKENS_FOR_THINKING;
        if (wantsThinking && roomForThinking) {
            if (settings.thinking === 'on') {
                const budget = settings.thinkingBudget
                    ? Math.max(1024, Math.min(settings.thinkingBudget, (settings.maxTokens ?? Infinity) - 512))
                    : undefined;
                options.thinking = budget
                    ? { type: 'enabled', budgetTokens: budget, display }
                    : { type: 'enabled', display };
            } else {
                options.thinking = { type: 'adaptive', display };
            }
        } else {
            if (wantsThinking && !roomForThinking) {
                console.log(`${PLUGIN_TAG} thinking disabled: max_tokens ${settings.maxTokens} < ${MIN_MAX_TOKENS_FOR_THINKING} (raise Max response length in SillyTavern to enable thinking on ${modelInfo.baseId})`);
            }
            options.thinking = { type: 'disabled' };
        }
    }
    if (settings.effort) {
        options.effort = settings.effort;
    }

    // Always run the subprocess in the scratch bucket so any live-turn
    // transcript that escapes the best-effort sweep lands in the plugin's
    // own project dir instead of intermingling with the user's real
    // `claude` sessions for SillyTavern's working directory.
    try {
        options.cwd = resume ? resume.cwd : resumeScratchCwd();
    } catch { /* unwritable scratch dir — fall back to process cwd */ }

    if (resume) {
        options.resume = resume.sessionId;
        options.sessionStore = resume.store;
    }

    return options;
}

/**
 * Build the query configuration. Tries the resume path; falls back to the
 * v1 transcript fold when disabled or when scratch-dir setup fails.
 */
function buildQueryConfig({ messages, modelInfo, oneMActive, settings, abortController, stream, env }) {
    const systemText = extractSystemText(messages);

    if (settings.useResume && envFlag('CLAUDE_SUBSCRIPTION_USE_RESUME', true)) {
        try {
            const cwd = resumeScratchCwd();
            const sessionId = randomUUID();
            const split = splitHistoryForResume(messages);
            const meta = {
                sessionId,
                cwd,
                version: SDK_VERSION,
                gitBranch: '',
                permissionMode: 'bypassPermissions',
            };
            const entries = assembleEntries(split.history, meta, modelInfo.baseId);
            // Empty entry lists make the SDK reject the resume with "No
            // conversation found" — first turns can't resume.
            if (entries.length > 0) {
                const prompt = singleMessageStream(currentToSdkUserMessage(split.current));
                const resume = { sessionId, store: new ResumeSessionStore(sessionId, entries), cwd };
                const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume });
                return { prompt, options, path: 'resume', sessionId, shape: split.shape };
            }
            // No replayable history, but a string fold would drop image
            // blocks — use streaming-input mode without resume so images
            // survive turn one.
            const hasImages = Array.isArray(split.current?.content)
                && split.current.content.some((p) => p?.type === 'image_url');
            if (hasImages) {
                const prompt = singleMessageStream(currentToSdkUserMessage(split.current));
                const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume: null });
                return { prompt, options, path: 'stream-input', sessionId: null, shape: split.shape };
            }
        } catch (err) {
            console.warn(`${PLUGIN_TAG} resume path unavailable, folding transcript:`, err instanceof Error ? err.message : err);
        }
    }

    // Fold fallback: renderTranscript extracts the same system text we
    // already have in systemText (its systemPrompt return is redundant here)
    // and folds the non-system turns into a labelled string prompt.
    const { prompt } = renderTranscript(messages);
    const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume: null });
    return { prompt, options, path: 'fold', sessionId: null, shape: 'fold' };
}

/**
 * Run one SDK query attempt, normalizing SDK messages into simple events:
 *   { kind: 'text', text }        visible output delta (stream only)
 *   { kind: 'reasoning', text }   thinking delta (stream only)
 *   { kind: 'blocks', blocks }    full assistant content (non-stream)
 *   { kind: 'done', usage }       success terminator
 * Throws Error with .sdkErrorText on failure (classified by the caller).
 */
async function* runQuery({ sdk, prompt, options, stream }) {
    let idleTimer = null;
    const abort = options.abortController;
    // Idle guard: with includePartialMessages (stream) the SDK emits a
    // steady message flow, so per-message re-arming detects a hung upstream.
    // With stream=false NOTHING arrives between init and the finished
    // assistant message — a healthy long generation (xhigh + long RP reply)
    // easily exceeds 90s — so non-stream gets one long absolute deadline
    // instead. Idle aborts are tagged on the controller so the caller can
    // distinguish them from client-close / stop-sequence aborts.
    const idleMs = stream ? UPSTREAM_IDLE_MS : NONSTREAM_DEADLINE_MS;
    const fireIdleAbort = () => {
        console.warn(`${PLUGIN_TAG} upstream ${stream ? 'idle' : 'deadline exceeded'} after ${idleMs}ms — aborting query`);
        abort.idleAbort = true;
        abort.abort();
    };
    const armIdleGuard = () => {
        if (!stream) return; // absolute deadline armed once below
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(fireIdleAbort, idleMs);
        idleTimer.unref?.();
    };

    idleTimer = setTimeout(fireIdleAbort, idleMs);
    idleTimer.unref?.();
    try {
        const handle = sdk.query({ prompt, options });
        for await (const message of handle) {
            armIdleGuard();

            if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
                // The CLI-minted session id — needed to privacy-sweep the
                // live-turn transcript on the fold/stream-input paths where
                // no pre-minted resume sessionId exists.
                yield { kind: 'session', id: message.session_id };
            } else if (message.type === 'stream_event') {
                const event = message.event;
                // parent_tool_use_id != null would be subagent traffic; with
                // tools:[] there are no subagents, but filter defensively.
                if (message.parent_tool_use_id) continue;
                if (event?.type === 'content_block_delta' && event.delta) {
                    if (event.delta.type === 'text_delta' && event.delta.text) {
                        yield { kind: 'text', text: event.delta.text };
                    } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
                        yield { kind: 'reasoning', text: event.delta.thinking };
                    }
                }
            } else if (message.type === 'assistant') {
                // Assistant-level errors (auth failures, API 4xx) surface here
                // with the useful text in the content blocks, not in the enum —
                // extract both so the retry ladder can classify them.
                if (message.error) {
                    const blocks = message.message?.content ?? [];
                    const text = blocks
                        .filter((b) => b.type === 'text' && b.text)
                        .map((b) => b.text)
                        .join(' ');
                    const err = new Error(text || `assistant error: ${message.error}`);
                    err.sdkErrorText = `${message.error} ${text}`;
                    throw err;
                }
                if (!stream) {
                    yield { kind: 'blocks', blocks: message.message?.content ?? [] };
                } else {
                    // Streamed thinking arrives as a COMPLETE block on the
                    // assistant message, not as thinking_delta events — the
                    // CLI's summarized-thinking display only streams a
                    // signature_delta (verified live on 0.2.141 + Fable).
                    // The thinking-block assistant message lands before the
                    // text deltas start, so emitting here still renders ahead
                    // of the reply in SillyTavern.
                    for (const block of message.message?.content ?? []) {
                        if (block.type === 'thinking' && block.thinking) {
                            yield { kind: 'reasoning-block', text: block.thinking };
                        }
                    }
                }
            } else if (message.type === 'result') {
                if (message.subtype === 'success') {
                    yield { kind: 'done', usage: message.usage ?? null };
                    return;
                }
                const detail = (message.errors ?? []).join('; ');
                const err = new Error(`Claude (Subscription) request failed (${message.subtype})${detail ? ' — ' + detail : ''}`);
                err.sdkErrorText = `${message.subtype} ${detail}`;
                throw err;
            }
            // Everything else (system/init, status, rate_limit events, ...)
            // is bookkeeping; prompt_suggestion can arrive after result but
            // we return at result.
        }
        // Generator ended without a result message.
        yield { kind: 'done', usage: null };
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }
}

export async function handleChatCompletions(req, res) {
    const body = req.body || {};
    const messages = body.messages;
    const requestedModel = body.model;

    if (!Array.isArray(messages) || messages.length === 0 || !requestedModel) {
        return res.status(400).json({
            error: { message: 'messages[] (non-empty) and model are required', type: 'invalid_request_error' },
        });
    }

    const wantStream = body.stream !== false;
    const settings = extractSettings(body);
    const apiKey = pickApiKeyFromAuthHeader(req);
    const modelInfo = parseModelRequest(requestedModel);

    let sdk;
    try {
        sdk = await loadSdk();
    } catch (err) {
        return res.status(500).json({
            error: { message: err instanceof Error ? err.message : String(err), type: 'sdk_unavailable' },
        });
    }

    const completionId = makeCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const shell = chunkShell(completionId, created, modelInfo.requested);

    // Stream state shared across retry attempts.
    let didYieldContent = false;
    let sseStarted = false;
    let usage = null;
    let finishReason = 'stop';
    let collectedText = '';
    let collectedReasoning = '';
    const sweepIds = [];

    const startSse = () => {
        if (sseStarted) return;
        sseStarted = true;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        writeSse(res, roleChunk(shell));
    };

    // Fresh AbortController per attempt — an aborted controller (idle guard,
    // failed attempt) must never poison the retry. Client disconnect aborts
    // whichever attempt is current.
    let abortController = null;
    let clientClosed = false;
    const onClientClose = () => {
        clientClosed = true;
        abortController?.abort();
    };
    req.on('close', onClientClose);

    // Retry ladder state.
    let oneMActive = modelInfo.oneM && !isExtendedContextKnownUnavailable();
    let didTokenRefresh = false;
    let rateLimitRetries = 0;

    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (clientClosed) break;
            abortController = new AbortController();
            const env = buildSubprocessEnv({ envPins: modelInfo.envPins, maxTokens: settings.maxTokens, apiKey });
            const cfg = buildQueryConfig({
                messages, modelInfo, oneMActive, settings,
                abortController, stream: wantStream, env,
            });
            if (cfg.sessionId) sweepIds.push(cfg.sessionId);

            try {
                let stopMatched = false;
                let sawReasoningDeltas = false;
                // Per-attempt scanner — a shared one would leak held-back
                // text from a failed attempt into the retry's output.
                const scanner = new StopScanner(settings.stops);

                for await (const ev of runQuery({ sdk, prompt: cfg.prompt, options: cfg.options, stream: wantStream })) {
                    if (ev.kind === 'session') {
                        // CLI-minted session id (fold / stream-input paths)
                        // so the privacy sweep covers their transcripts too.
                        if (!sweepIds.includes(ev.id)) sweepIds.push(ev.id);
                    } else if (ev.kind === 'text') {
                        const { emit, matched } = scanner.feed(ev.text);
                        if (emit) {
                            didYieldContent = true;
                            if (wantStream) {
                                startSse();
                                writeSse(res, contentChunk(shell, emit));
                            }
                            collectedText += emit;
                        }
                        if (matched) {
                            stopMatched = true;
                            finishReason = 'stop';
                            abortController.abort();
                            break;
                        }
                    } else if (ev.kind === 'reasoning') {
                        if (!settings.showReasoning) continue;
                        didYieldContent = true;
                        sawReasoningDeltas = true;
                        if (wantStream) {
                            startSse();
                            writeSse(res, reasoningChunk(shell, ev.text));
                        }
                        collectedReasoning += ev.text;
                    } else if (ev.kind === 'reasoning-block') {
                        // Complete thinking block from the assistant message.
                        // Skip if raw deltas already streamed it (older CLIs).
                        if (!settings.showReasoning || sawReasoningDeltas) continue;
                        didYieldContent = true;
                        if (wantStream) {
                            startSse();
                            writeSse(res, reasoningChunk(shell, ev.text));
                        }
                        collectedReasoning += ev.text;
                    } else if (ev.kind === 'blocks') {
                        for (const block of ev.blocks) {
                            if (block.type === 'text' && block.text) {
                                const { emit, matched } = scanner.feed(block.text);
                                if (emit) collectedText += emit;
                                if (matched) { stopMatched = true; break; }
                            } else if (block.type === 'thinking' && block.thinking && settings.showReasoning) {
                                collectedReasoning += block.thinking;
                            }
                        }
                        if (collectedText || collectedReasoning) didYieldContent = true;
                    } else if (ev.kind === 'done') {
                        usage = ev.usage;
                    }
                }

                if (!stopMatched) {
                    const tail = scanner.flush();
                    if (tail) {
                        didYieldContent = true;
                        if (wantStream) {
                            startSse();
                            writeSse(res, contentChunk(shell, tail));
                        }
                        collectedText += tail;
                    }
                }
                break; // success
            } catch (err) {
                const errText = err?.sdkErrorText ?? (err instanceof Error ? err.message : String(err));

                // Client went away / stop-sequence abort → not an error.
                // Idle-guard aborts are excluded: a hang after partial output
                // must surface as an error, not a clean finish.
                if (abortController.signal.aborted && didYieldContent && !abortController.idleAbort) break;
                if (clientClosed) break;

                // Never retry into a stream that already has content.
                if (!didYieldContent) {
                    if (oneMActive && isExtraUsageRequiredError(errText)) {
                        console.warn(`${PLUGIN_TAG} 1M context unavailable (Extra Usage) — retrying on base model, cooldown 1h`);
                        recordExtendedContextUnavailable();
                        oneMActive = false;
                        continue;
                    }
                    if (isExpiredTokenError(errText) && !didTokenRefresh) {
                        didTokenRefresh = true;
                        console.warn(`${PLUGIN_TAG} auth expired — attempting OAuth refresh + one retry`);
                        const refreshed = await refreshOAuthToken();
                        if (refreshed) continue;
                    }
                    if (isRateLimitError(errText) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                        rateLimitRetries += 1;
                        if (oneMActive) {
                            // 1M quota is a separate bucket — drop to base, no cooldown.
                            oneMActive = false;
                        }
                        const delay = 1000 * rateLimitRetries;
                        console.warn(`${PLUGIN_TAG} rate limited — retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`);
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    if (isStaleSessionError(errText) && cfg.path === 'resume') {
                        console.warn(`${PLUGIN_TAG} stale resume session — retrying via transcript fold`);
                        settings.useResume = false;
                        continue;
                    }
                }
                throw err;
            }
        }
    } catch (err) {
        const friendly = err instanceof Error ? err.message : String(err);
        console.error(PLUGIN_TAG, 'SDK query failed:', friendly);
        const hint = isExpiredTokenError(friendly)
            ? ' — run `claude login` on the SillyTavern host, then retry.'
            : '';
        if (wantStream && sseStarted) {
            writeSse(res, errorEvent(`${friendly}${hint}`));
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        return res.status(500).json({ error: { message: `${friendly}${hint}`, type: 'server_error' } });
    } finally {
        req.off('close', onClientClose);
        for (const id of sweepIds) sweepSessionTranscript(loadSdk, id);
    }

    const openAiUsage = toOpenAiUsage(usage);

    if (wantStream) {
        startSse(); // ensure headers even for instant empty results
        writeSse(res, finishChunk(shell, finishReason, openAiUsage));
        res.write('data: [DONE]\n\n');
        return res.end();
    }

    const message = { role: 'assistant', content: collectedText };
    if (collectedReasoning) message.reasoning_content = collectedReasoning;
    const response = {
        id: completionId,
        object: 'chat.completion',
        created,
        model: modelInfo.requested,
        choices: [{ index: 0, message, finish_reason: finishReason }],
    };
    if (openAiUsage) response.usage = openAiUsage;
    return res.json(response);
}

// Embeddings are not supported on the subscription path.
export function rejectEmbeddings(_req, res) {
    return res.status(501).json({
        error: {
            message: 'The Claude (Subscription) proxy does not support embeddings. ' +
                'Configure a separate embedding source (OpenAI, Google, or local).',
            type: 'not_supported',
        },
    });
}
