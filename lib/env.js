// ──────────────────────────────────────────────
// SDK subprocess environment builder
// ──────────────────────────────────────────────
//
// The Claude Code CLI resolves auth and model aliases from its environment.
// Getting this env exactly right is what keeps subscription billing working:
//
//   • ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL are
//     SCRUBBED unless the caller explicitly opted into API billing —
//     any stray key in SillyTavern's process env would silently flip
//     billing off the subscription (Meridian scrubs identically).
//   • ANTHROPIC_DEFAULT_<TIER>_MODEL pins resolve tier aliases (and the
//     [1m] alias forms) to exact versions — request pins win over both
//     canonical defaults and inherited shell env.
//   • CLAUDE_CODE_MAX_OUTPUT_TOKENS carries SillyTavern's "Max response
//     length" to the CLI (the SDK has no per-query output cap option).
//   • ENABLE_CLAUDEAI_MCP_SERVERS=false kills claude.ai account connectors
//     (Notion/Gmail/etc.) that would otherwise reach the model
//     (Marinara's isolation hardening).

const SCRUB_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
];

/**
 * @param {object} args
 * @param {Record<string,string>} args.envPins ANTHROPIC_DEFAULT_* pins from parseModelRequest
 * @param {number|undefined} args.maxTokens
 * @param {string|null} args.apiKey explicit sk-ant-* API-billing opt-in (or null for subscription)
 * @returns {Record<string,string|undefined>}
 */
export function buildSubprocessEnv({ envPins, maxTokens, apiKey }) {
    const env = { ...process.env };
    for (const key of SCRUB_KEYS) delete env[key];

    // Request pins win over inherited shell env (the picked model version IS
    // the request's meaning; a stale shell pin must not redirect it).
    Object.assign(env, envPins);

    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';

    if (maxTokens) {
        env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
    }

    if (apiKey) {
        // Opt-in API-billing fallback — overrides subscription auth.
        env.ANTHROPIC_API_KEY = apiKey;
    }

    return env;
}

/** Only forward genuine Anthropic API keys (sk-ant-*). SillyTavern always
 *  sends `Authorization: Bearer <key>` for Custom sources, even placeholders,
 *  so anything else is treated as "no key" to keep subscription auth intact. */
export function pickApiKeyFromAuthHeader(req) {
    const auth = req.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const key = match[1].trim();
    if (!/^sk-ant-/i.test(key)) return null;
    return key;
}
