// ──────────────────────────────────────────────
// Synthetic JSONL entry builder for Claude Code session replay
// ──────────────────────────────────────────────
//
// The Claude Agent SDK's `resume` option replays a JSONL transcript as the
// conversation history the model sees. We build these entries in-process from
// the OpenAI messages array and hand them to the SDK through a `SessionStore`
// adapter (see session-store.js), so prior turns reach the model as REAL
// multi-turn context — true user/assistant role separation and working
// prompt caching — instead of being folded into one labelled string.
//
// This is the single most valuable technique in Marinara's overhauled
// provider (their jsonl-entries.ts); ported here for OpenAI message shapes.
// Schema mirrors what the CLI writes, minus hook/UI noise entries
// (queue-operation, last-prompt, attachment, permission-mode,
// file-history-snapshot, ai-title) — not required for resume.

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PLUGIN_TAG = '[claude-subscription]';

// Constrain to the legal base64 alphabet so the regex fails fast on garbage
// instead of backtracking across multi-KB inputs.
const DATA_URL_RE = /^data:(image\/[^;]+);base64,([A-Za-z0-9+/]+=*)$/;

function shortHex() {
    return randomUUID().replace(/-/g, '').slice(0, 24);
}

function imageBlocksFromParts(parts) {
    const blocks = [];
    for (const p of parts) {
        if (!p || p.type !== 'image_url') continue;
        const url = p.image_url?.url ?? '';
        const match = url.match(DATA_URL_RE);
        if (!match) {
            console.warn(`${PLUGIN_TAG} dropping image: not a recognised base64 data URL`);
            continue;
        }
        blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
    }
    return blocks;
}

function textFromContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n');
    }
    return '';
}

/** OpenAI user/tool message content → Anthropic user content (string or blocks). */
function userContentFromMessage(message) {
    const text = textFromContent(message.content);

    if (message.role === 'tool') {
        return [{
            type: 'tool_result',
            tool_use_id: message.tool_call_id ?? '',
            content: text,
        }];
    }

    const images = Array.isArray(message.content) ? imageBlocksFromParts(message.content) : [];
    if (images.length > 0) {
        const blocks = [...images];
        if (text) blocks.push({ type: 'text', text });
        return blocks;
    }
    return text;
}

export function buildUserEntry({ message, parentUuid, meta }) {
    return {
        parentUuid,
        isSidechain: false,
        promptId: randomUUID(),
        type: 'user',
        message: { role: 'user', content: userContentFromMessage(message) },
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        permissionMode: meta.permissionMode,
        userType: 'external',
        entrypoint: 'cli',
        cwd: meta.cwd,
        sessionId: meta.sessionId,
        version: meta.version,
        gitBranch: meta.gitBranch,
    };
}

export function buildAssistantEntry({ message, parentUuid, meta, model }) {
    const text = textFromContent(message.content);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    const blocks = [];
    if (text) blocks.push({ type: 'text', text });
    for (const tc of toolCalls) {
        let input = {};
        try {
            const parsed = JSON.parse(tc.function?.arguments ?? '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
        } catch {
            console.warn(`${PLUGIN_TAG} failed to parse tool_use arguments for ${tc.function?.name}; substituting {}`);
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name ?? 'unknown', input });
    }
    // The Anthropic API rejects empty content; keep resume loadable.
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });

    return {
        parentUuid,
        isSidechain: false,
        message: {
            model,
            id: `msg_${shortHex()}`,
            type: 'message',
            role: 'assistant',
            content: blocks,
            stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
        },
        requestId: `req_${shortHex()}`,
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        userType: 'external',
        entrypoint: 'cli',
        cwd: meta.cwd,
        sessionId: meta.sessionId,
        version: meta.version,
        gitBranch: meta.gitBranch,
    };
}

/** A message with nothing renderable would replay as an empty content
 *  block, which the Messages API rejects ("text content blocks must be
 *  non-empty") — poisoning every subsequent resume of the chat. */
function hasRenderableContent(m) {
    if (m.role === 'tool') return true; // tool_result blocks are structurally non-empty
    if (textFromContent(m.content).trim()) return true;
    if (Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url')) return true;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
    return false;
}

/**
 * Build the parent-uuid-chained entry list the SDK's resume path replays.
 * System messages are excluded — they ride the SDK's `systemPrompt` option.
 * Blank messages (deleted text, empty swipe placeholders) are skipped.
 */
export function assembleEntries(history, meta, model) {
    const entries = [];
    let parentUuid = null;

    for (const m of history) {
        if (m.role === 'system') continue;
        if (!hasRenderableContent(m)) continue;
        const entry = (m.role === 'assistant')
            ? buildAssistantEntry({ message: m, parentUuid, meta, model })
            : buildUserEntry({ message: m, parentUuid, meta });
        entries.push(entry);
        parentUuid = entry.uuid;
    }
    return entries;
}

// ──────────────────────────────────────────────
// History split: prior turns → JSONL, trailing turn → SDK prompt
// ──────────────────────────────────────────────

const SYNTHETIC_START = '[Start]';

/**
 * Closest in-SDK approximation of Messages-API assistant prefill. The Agent
 * SDK prompt is user-only, and SillyTavern renders/keeps the prefill text
 * client-side, so the synthetic turn tells Claude to continue after the
 * prefilled text rather than repeat it. `</assistant_prefill>` inside the
 * prefill is escaped to prevent tag breakout (prompt-injection hardening
 * from Marinara).
 */
export function buildAssistantPrefillContinuationPrompt(prefill) {
    const normalized = String(prefill ?? '').trimEnd();
    if (!normalized.trim()) {
        return "Continue the assistant's reply.";
    }
    const safePrefill = normalized.replaceAll('</assistant_prefill>', '&lt;/assistant_prefill&gt;');
    return [
        "Continue the assistant's reply as if it already began with the prefill below.",
        'The prefill is already part of the assistant message, so do not repeat it.',
        'Start with the very next text that should follow it, preserving the same voice, format, and momentum.',
        '',
        '<assistant_prefill>',
        safePrefill,
        '</assistant_prefill>',
    ].join('\n');
}

/**
 * Split OpenAI messages into (history → JSONL) + (current → SDK prompt).
 *  - Trailing user/tool: history = rest; current = trailing.
 *  - Trailing assistant (prefill / "start reply with"): history = rest;
 *    current = synthetic continuation instruction.
 *  - Empty / system-only (connection-test pings): synthetic "[Start]".
 */
export function splitHistoryForResume(messages) {
    const nonSystem = messages.filter((m) => m?.role !== 'system');

    if (nonSystem.length === 0) {
        return {
            history: [],
            current: { role: 'user', content: SYNTHETIC_START },
            shape: 'synthetic-start',
        };
    }

    const trailing = nonSystem[nonSystem.length - 1];

    if (trailing.role === 'assistant') {
        return {
            history: nonSystem.slice(0, -1),
            current: { role: 'user', content: buildAssistantPrefillContinuationPrompt(textFromContent(trailing.content)) },
            shape: 'trailing-assistant-continue',
        };
    }

    return {
        history: nonSystem.slice(0, -1),
        current: trailing,
        shape: trailing.role === 'tool' ? 'trailing-tool' : 'trailing-user',
    };
}

/**
 * Convert the current turn into the SDKUserMessage shape accepted when
 * `prompt` is an AsyncIterable (required to carry image blocks; a plain
 * string prompt cannot).
 */
export function currentToSdkUserMessage(message) {
    return {
        type: 'user',
        message: { role: 'user', content: userContentFromMessage(message) },
        parent_tool_use_id: null,
    };
}

/** Single-element AsyncIterable wrapper for the SDK's streaming-input mode. */
export async function* singleMessageStream(sdkUserMessage) {
    yield sdkUserMessage;
}

// ──────────────────────────────────────────────
// SDK version stamp (telemetry only — resume accepts arbitrary versions)
// ──────────────────────────────────────────────

function detectSdkVersion() {
    try {
        const req = createRequire(import.meta.url);
        const mainPath = req.resolve('@anthropic-ai/claude-agent-sdk');
        const pkg = JSON.parse(readFileSync(join(dirname(mainPath), 'package.json'), 'utf8'));
        if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
        // fall through
    }
    return 'unknown';
}

export const SDK_VERSION = detectSdkVersion();
