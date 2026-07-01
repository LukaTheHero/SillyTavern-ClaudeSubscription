// ──────────────────────────────────────────────
// System prompt assembly — roleplay-first
// ──────────────────────────────────────────────
//
// The single most consequential option for roleplay quality. The SDK's
// behavior matrix (verified against @anthropic-ai/claude-agent-sdk 0.2.141):
//
//   • systemPrompt OMITTED          → CLI default = the FULL ~28KB Claude Code
//                                     coding system prompt. Never acceptable
//                                     for RP — "no option" is not neutral.
//   • systemPrompt: '<string>'      → REPLACES the coding preamble entirely.
//                                     Pure client prompt (character card,
//                                     persona, world info). The RP path.
//   • systemPrompt: ''              → explicitly empty system prompt.
//   • { type:'preset', preset:'claude_code', append } → coding preamble kept,
//                                     client text appended after. Fixes model
//                                     self-identification (without the preset
//                                     every model answers "Sonnet" when asked
//                                     what it is — empirical finding from v1)
//                                     at the cost of coding framing bleeding
//                                     into the roleplay. Exposed as the
//                                     opt-in "identity mode".
//
// In Meridian's terms: "Client Prompt" (the connecting app's system prompt —
// for SillyTavern that's the character card) is hardcoded ON here; "Claude
// Code Prompt" is OFF unless identityMode is set.

/**
 * @param {string|undefined} clientSystemPrompt joined system-message text from the request
 * @param {boolean} identityMode
 * @returns {string | { type: 'preset', preset: 'claude_code', append?: string }}
 */
export function buildSystemPrompt(clientSystemPrompt, identityMode) {
    if (identityMode) {
        return clientSystemPrompt
            ? { type: 'preset', preset: 'claude_code', append: clientSystemPrompt }
            : { type: 'preset', preset: 'claude_code' };
    }
    // Plain string replaces the coding preamble; empty string keeps it
    // explicitly empty rather than falling back to the CLI default.
    return clientSystemPrompt ?? '';
}

/** Extract and join system-role messages from an OpenAI messages array. */
export function extractSystemText(messages) {
    const parts = [];
    for (const m of messages) {
        if (m?.role !== 'system') continue;
        const text = contentToText(m.content);
        if (text) parts.push(text);
    }
    return parts.length ? parts.join('\n\n') : undefined;
}

/** Flatten OpenAI content (string or multi-part array) to plain text. */
export function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n');
    }
    return '';
}
