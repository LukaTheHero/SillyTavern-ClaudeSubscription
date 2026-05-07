// ──────────────────────────────────────────────
// /v1/chat/completions handler
// ──────────────────────────────────────────────
//
// Accepts an OpenAI Chat Completions request, runs it through the local
// Claude Agent SDK, and emits OpenAI-format SSE chunks (or a single JSON
// response when stream=false). Mirrors Marinara's ClaudeSubscriptionProvider:
//   • lazy SDK load (sdk-loader.js)
//   • renderTranscript collapses messages into systemPrompt + prompt
//   • tools: [], permissionMode: bypassPermissions
//   • no maxTurns (PR #294 — internal thinking steps consume turn budget
//     and cause error_max_turns when capped at 1)
//   • adaptive thinking on Opus 4.7+ (claude-opus-4-(?:[7-9]|\d{2,}))
//   • opt-in API-billing fallback via ANTHROPIC_API_KEY env when an
//     Authorization: Bearer <key> header is supplied

import { loadSdk } from './sdk-loader.js';
import { renderTranscript } from './transcript.js';

const PLUGIN_TAG = '[claude-subscription]';

function makeCompletionId() {
    return 'chatcmpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function isAdaptiveOnlyModel(model) {
    // Opus 4.7+ is adaptive-only — sampling parameters are rejected and the
    // model always thinks, so we always set thinking: { type: 'adaptive' }.
    return /claude-opus-4-(?:[7-9]|\d{2,})/.test(String(model).toLowerCase());
}

function pickApiKeyFromAuthHeader(req) {
    const auth = req.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const key = match[1].trim();
    // Only forward genuine Anthropic API keys (sk-ant-*). SillyTavern always
    // sends `Authorization: Bearer <key>` for Custom OpenAI sources, even when
    // the user left the field blank or typed a placeholder — and the SDK will
    // try to authenticate against whatever value lands in ANTHROPIC_API_KEY,
    // which fails for anything that isn't a real key. Treating non-sk-ant-*
    // values as "no key" keeps subscription auth working regardless of what
    // junk SillyTavern's secret store happens to contain.
    if (!/^sk-ant-/i.test(key)) return null;
    return key;
}

function buildSdkOptions({ model, systemPrompt, abortController, stream, reasoningEffort, apiKey }) {
    const options = {
        abortController,
        model,
        systemPrompt,
        includePartialMessages: stream,
        // Disable agent tooling — SillyTavern owns the conversation surface.
        tools: [],
        permissionMode: 'bypassPermissions',
        // Intentionally no maxTurns — see Marinara PR #294: internal thinking
        // steps consume turn budget and cause error_max_turns when capped.
    };

    if (reasoningEffort) {
        options.thinking = { type: 'adaptive' };
        options.effort = reasoningEffort;
    } else if (isAdaptiveOnlyModel(model)) {
        // Opus 4.7+ always thinks; let the SDK pick a default effort.
        options.thinking = { type: 'adaptive' };
    }

    if (apiKey) {
        // Opt-in API-billing fallback — overrides subscription auth.
        options.env = { ...process.env, ANTHROPIC_API_KEY: apiKey };
    }

    return options;
}

function writeSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function handleChatCompletions(req, res) {
    const body = req.body || {};
    const messages = body.messages;
    const model = body.model;

    if (!Array.isArray(messages) || messages.length === 0 || !model) {
        return res.status(400).json({
            error: {
                message: 'messages[] (non-empty) and model are required',
                type: 'invalid_request_error',
            },
        });
    }

    // Default to streaming to match OpenAI behavior; SillyTavern explicitly
    // sets stream: true for streaming requests anyway.
    const wantStream = body.stream !== false;
    const reasoningEffort = body.reasoning_effort || body.reasoning?.effort || null;
    const apiKey = pickApiKeyFromAuthHeader(req);

    const { systemPrompt, prompt } = renderTranscript(messages);

    let query;
    try {
        ({ query } = await loadSdk());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({
            error: { message, type: 'sdk_unavailable' },
        });
    }

    const abortController = new AbortController();
    const onClientClose = () => abortController.abort();
    req.on('close', onClientClose);

    const sdkOptions = buildSdkOptions({
        model,
        systemPrompt,
        abortController,
        stream: wantStream,
        reasoningEffort,
        apiKey,
    });

    const completionId = makeCompletionId();
    const created = Math.floor(Date.now() / 1000);

    if (wantStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        // Initial chunk announces the assistant role (matches OpenAI behavior).
        writeSse(res, {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });

        let usage = null;
        let finishReason = 'stop';
        let errorMessage = null;

        try {
            const handle = query({ prompt, options: sdkOptions });
            for await (const message of handle) {
                if (message.type === 'stream_event') {
                    const event = message.event;
                    if (event && event.type === 'content_block_delta' && event.delta) {
                        if (event.delta.type === 'text_delta' && event.delta.text) {
                            writeSse(res, {
                                id: completionId,
                                object: 'chat.completion.chunk',
                                created,
                                model,
                                choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
                            });
                        }
                        // thinking_delta is intentionally not forwarded — OpenAI
                        // chat.completion.chunk has no standard slot for thinking
                        // and SillyTavern would treat it as visible content.
                    }
                } else if (message.type === 'result') {
                    if (message.subtype === 'success') {
                        usage = message.usage || null;
                    } else {
                        finishReason = 'stop';
                        const detail = (message.errors || []).join('; ');
                        errorMessage = `Claude (Subscription) request failed (${message.subtype})${detail ? ' — ' + detail : ''}`;
                    }
                }
            }
        } catch (err) {
            const friendly = err instanceof Error ? err.message : String(err);
            errorMessage = `Claude (Subscription) request failed: ${friendly}`;
            console.error(PLUGIN_TAG, 'SDK query failed:', err);
        } finally {
            req.off('close', onClientClose);
        }

        if (errorMessage) {
            writeSse(res, { error: { message: errorMessage, type: 'server_error' } });
        } else {
            const finalChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            };
            if (usage) {
                finalChunk.usage = {
                    prompt_tokens: usage.input_tokens || 0,
                    completion_tokens: usage.output_tokens || 0,
                    total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
                };
            }
            writeSse(res, finalChunk);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
    }

    // ── Non-streaming path ──
    let content = '';
    let usage = null;
    try {
        const handle = query({
            prompt,
            options: { ...sdkOptions, includePartialMessages: false },
        });
        for await (const message of handle) {
            if (message.type === 'assistant') {
                const blocks = (message.message && message.message.content) || [];
                for (const block of blocks) {
                    if (block.type === 'text' && block.text) content += block.text;
                }
            } else if (message.type === 'result') {
                if (message.subtype === 'success') {
                    usage = message.usage || null;
                } else {
                    const detail = (message.errors || []).join('; ');
                    return res.status(500).json({
                        error: {
                            message: `Claude (Subscription) request failed (${message.subtype})${detail ? ' — ' + detail : ''}`,
                            type: 'server_error',
                        },
                    });
                }
            }
        }
    } catch (err) {
        const friendly = err instanceof Error ? err.message : String(err);
        console.error(PLUGIN_TAG, 'SDK query failed:', err);
        return res.status(500).json({
            error: {
                message: `Claude (Subscription) request failed: ${friendly}`,
                type: 'server_error',
            },
        });
    } finally {
        req.off('close', onClientClose);
    }

    const response = {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
            },
        ],
    };
    if (usage) {
        response.usage = {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        };
    }
    return res.json(response);
}

// Embeddings are not supported on the subscription path — surface a clear
// error so the user routes embedding work to a separate connection
// (mirrors Marinara's ClaudeSubscriptionProvider.embed override).
export function rejectEmbeddings(_req, res) {
    return res.status(501).json({
        error: {
            message:
                'The Claude (Subscription) proxy does not support embeddings. ' +
                'Configure a separate embedding source (OpenAI, Google, or local).',
            type: 'not_supported',
        },
    });
}
