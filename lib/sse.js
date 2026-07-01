// ──────────────────────────────────────────────
// OpenAI chat-completions wire helpers (SSE + JSON)
// ──────────────────────────────────────────────
//
// Thinking deltas are emitted as `delta.reasoning_content` — the DeepSeek
// convention SillyTavern parses natively for Custom sources (its streaming
// reader takes choices[0].delta.reasoning_content into the collapsible
// reasoning block, gated by the user's "Show model thoughts" setting). The
// non-streaming shape mirrors it via message.reasoning_content.

export function makeCompletionId() {
    return 'chatcmpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function writeSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function chunkShell(id, created, model) {
    return { id, object: 'chat.completion.chunk', created, model };
}

export function roleChunk(shell) {
    return { ...shell, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
}

export function contentChunk(shell, text) {
    return { ...shell, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

export function reasoningChunk(shell, text) {
    return { ...shell, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] };
}

export function finishChunk(shell, finishReason, usage) {
    const chunk = { ...shell, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
    if (usage) chunk.usage = usage;
    return chunk;
}

export function errorEvent(message) {
    return { error: { message, type: 'server_error' } };
}

/** Map SDK result usage → OpenAI usage, keeping cache accounting visible. */
export function toOpenAiUsage(usage) {
    if (!usage) return undefined;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreate = usage.cache_creation_input_tokens ?? 0;
    return {
        prompt_tokens: input + cacheRead + cacheCreate,
        completion_tokens: output,
        total_tokens: input + cacheRead + cacheCreate + output,
        prompt_tokens_details: {
            cached_tokens: cacheRead,
            cache_creation_tokens: cacheCreate,
        },
    };
}
