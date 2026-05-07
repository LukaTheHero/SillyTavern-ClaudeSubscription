// ──────────────────────────────────────────────
// OpenAI Chat Completion messages → Claude Agent SDK prompt
// ──────────────────────────────────────────────
//
// The Agent SDK accepts a single-string `prompt` plus an optional
// `systemPrompt`. We extract system messages so they go through the
// dedicated systemPrompt option (preserving system/user separation) and
// fold the rest of the conversation into a labelled transcript so the
// model sees prior turns even though the SDK is one-shot per call.
//
// Mirrors `renderTranscript()` in Marinara's claude-subscription.provider.ts.

export function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        // OpenAI multi-part content: keep text parts, drop image_url etc.
        return content
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n');
    }
    return '';
}

export function renderTranscript(messages) {
    const systemBlocks = [];
    const turns = [];

    for (const message of messages) {
        const text = extractText(message?.content).trim();
        if (!text) continue;
        if (message.role === 'system') {
            systemBlocks.push(text);
            continue;
        }
        const label = message.role === 'user' ? 'User' : 'Assistant';
        turns.push(`${label}: ${text}`);
    }

    // The SDK rejects empty prompts; if the caller only supplied system
    // content (rare connection-test pings), inject a minimal user turn.
    if (turns.length === 0) turns.push('User: [Start]');

    return {
        systemPrompt: systemBlocks.length ? systemBlocks.join('\n\n') : undefined,
        prompt: turns.join('\n\n'),
    };
}
