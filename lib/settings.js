// ──────────────────────────────────────────────
// Per-request settings extraction
// ──────────────────────────────────────────────
//
// The companion UI extension injects a `claude_subscription` object into the
// request body via SillyTavern's `custom_include_body` channel — the only
// per-request path that survives ST's backend unconditionally (its native
// reasoning_effort field is dropped for non-OpenAI model IDs at
// src/endpoints/backends/chat-completions.js:2507-2513, and its "Maximum"
// dropdown value is downgraded to "high" client-side before that).
//
// Direct API users (curl, other frontends) can send the same object, or the
// standard OpenAI `reasoning_effort` field, or nothing at all.

export const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const VALID_THINKING = ['off', 'adaptive', 'on'];

/** Gate effort to the SDK's closed vocabulary; anything else → undefined
 *  (model default) instead of erroring the whole request. Case-sensitive on
 *  purpose — the SDK wants lowercase. */
export function normalizeEffort(value) {
    return VALID_EFFORTS.includes(value) ? value : undefined;
}

/**
 * @param {object} body OpenAI chat completions request body
 * @returns {{
 *   effort: string|undefined,
 *   thinking: 'off'|'adaptive'|'on',
 *   thinkingBudget: number|undefined,
 *   showReasoning: boolean,
 *   identityMode: boolean,
 *   useResume: boolean,
 *   maxTokens: number|undefined,
 *   stops: string[],
 * }}
 */
export function extractSettings(body) {
    const ns = (body.claude_subscription && typeof body.claude_subscription === 'object')
        ? body.claude_subscription
        : {};

    const effort = normalizeEffort(ns.effort)
        ?? normalizeEffort(body.reasoning_effort)
        ?? normalizeEffort(body.reasoning?.effort);

    // Default adaptive: the model decides when to think (and adaptive-only
    // families always think regardless).
    const thinking = VALID_THINKING.includes(ns.thinking) ? ns.thinking : 'adaptive';

    const thinkingBudget = Number.isFinite(ns.thinking_budget) && ns.thinking_budget > 0
        ? Math.floor(ns.thinking_budget)
        : undefined;

    const maxTokens = Number.isFinite(body.max_tokens) && body.max_tokens > 0
        ? Math.floor(body.max_tokens)
        : (Number.isFinite(body.max_completion_tokens) && body.max_completion_tokens > 0
            ? Math.floor(body.max_completion_tokens)
            : undefined);

    let stops = [];
    if (Array.isArray(body.stop)) stops = body.stop.filter((s) => typeof s === 'string' && s.length > 0);
    else if (typeof body.stop === 'string' && body.stop.length > 0) stops = [body.stop];
    // Anthropic caps stop sequences at 4 upstream; we enforce client-side
    // anyway, but keep the list sane.
    stops = stops.slice(0, 16);

    return {
        effort,
        thinking,
        thinkingBudget,
        showReasoning: ns.show_reasoning !== false, // default ON — ST renders reasoning_content natively
        identityMode: ns.identity_mode === true,     // claude_code preset + append (self-ID fix, coding framing)
        useResume: ns.use_resume !== false,          // synthetic-session resume (fold fallback when off/failed)
        maxTokens,
        stops,
    };
}
