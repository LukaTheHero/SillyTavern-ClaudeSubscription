// ──────────────────────────────────────────────
// Claude Subscription model catalog + request parsing
// ──────────────────────────────────────────────
//
// Two-layer model story (mirrors Meridian's proven mechanism rather than
// Marinara v2.0.8, which regressed 1M handling by stamping 1M context on the
// plain IDs without enabling anything):
//
//   1. The picker exposes full model IDs plus explicit "(1M context)"
//      variants suffixed `[1m]` — e.g. `claude-opus-4-8[1m]`.
//   2. For a base request we pass the full model ID straight to the SDK.
//      For a `[1m]` request we pass the CLI's tier alias with the 1M suffix
//      (`opus[1m]`, `fable[1m]`, `sonnet[1m]`) as `Options.model` and pin
//      the tier's concrete version via ANTHROPIC_DEFAULT_<TIER>_MODEL in the
//      subprocess env — that is exactly how the Claude Code CLI's own
//      "/model … [1m]" picker entries resolve, and how Meridian serves 1M.
//
// 1M context requires Extra Usage on some plans; failures are handled by the
// caller via stripExtendedContext + the 1-hour cooldown below (probe pattern
// copied from Meridian: one failed [1m] request arms the cooldown, base model
// serves in the meantime, a single probe retries after the hour).

const TIER_ENV = {
    fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

// Canonical tier defaults — pinned under the request-specific pin so the
// CLI's bundled (possibly stale) defaults never decide a tier we didn't pin
// explicitly (Meridian issue #419 class of bug).
export const CANONICAL_TIER_MODELS = {
    fable: 'claude-fable-5-1',
    opus: 'claude-opus-5',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5',
};

// `adaptiveOnly` = always-thinking model families; sampling params are
// rejected and `thinking: { type: 'enabled' | 'disabled' }` is invalid — only
// adaptive applies (Opus 4.7+, Fable, Mythos).
export const CLAUDE_SUBSCRIPTION_MODELS = [
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', tier: 'fable', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-fable-5', name: 'Claude Fable 5', tier: 'fable', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-opus-5', name: 'Claude Opus 5', tier: 'opus', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'opus', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', tier: 'opus', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'opus', oneM: true, adaptiveOnly: false, context: 200000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'sonnet', oneM: true, adaptiveOnly: false, context: 200000 },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', tier: 'opus', oneM: false, adaptiveOnly: false, context: 200000 },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', tier: 'sonnet', oneM: false, adaptiveOnly: false, context: 200000 },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'haiku', oneM: false, adaptiveOnly: false, context: 200000 },
];

const ONE_M_SUFFIX = '[1m]';

function catalogEntry(baseId) {
    const raw = String(baseId).toLowerCase();
    const normalized = raw.replace(/\./g, '-');
    return CLAUDE_SUBSCRIPTION_MODELS.find((m) => m.id === raw || m.id === normalized) || null;
}

/** Tier guess for model IDs not in the catalog (forward compatibility). */
function guessTier(id) {
    const s = String(id).toLowerCase();
    if (s.includes('fable') || s.includes('mythos')) return 'fable';
    if (s.includes('opus')) return 'opus';
    if (s.includes('haiku')) return 'haiku';
    return 'sonnet';
}

/** Always-thinking family detection, catalog first, regex for unknown IDs. */
export function isAdaptiveOnlyModel(id) {
    const s = String(id).toLowerCase();
    const entry = catalogEntry(s.replace(/\[1m\]$/, ''));
    if (entry) return entry.adaptiveOnly;
    return (
        /claude-opus-(?:4-(?:[7-9]|\d{2,})|[5-9]|\d{2,})/.test(s) ||
        s.includes('fable') ||
        s.includes('mythos')
    );
}

/**
 * Parse the model string from the request into everything the SDK call needs.
 *
 * @param {string} requested e.g. 'claude-opus-5', 'claude-fable-5-1[1m]'
 * @returns {{ requested: string, baseId: string, tier: string, oneM: boolean,
 *            sdkModel: string, envPins: Record<string,string>, adaptiveOnly: boolean }}
 */
export function parseModelRequest(requested) {
    const raw = String(requested).trim();
    const oneM = raw.endsWith(ONE_M_SUFFIX);
    const rawBaseId = oneM ? raw.slice(0, -ONE_M_SUFFIX.length) : raw;
    const entry = catalogEntry(rawBaseId);
    const baseId = entry ? entry.id : rawBaseId;
    const tier = entry ? entry.tier : guessTier(baseId);

    // Canonical pins for every tier first, then override the requested tier
    // with the exact version the user picked — the request's semantics MUST
    // win over both canonical defaults and any inherited shell env.
    const envPins = {};
    for (const [t, envVar] of Object.entries(TIER_ENV)) {
        envPins[envVar] = CANONICAL_TIER_MODELS[t];
    }
    envPins[TIER_ENV[tier]] = baseId;

    const effectiveOneM = oneM && (entry ? entry.oneM : true);
    // Base request → full model ID direct to the SDK (per-request exactness).
    // [1m] request → tier alias + [1m] suffix; env pin resolves the version.
    const sdkModel = effectiveOneM ? `${tier}${ONE_M_SUFFIX}` : baseId;

    return {
        requested: raw,
        baseId,
        tier,
        oneM: effectiveOneM,
        sdkModel,
        envPins,
        adaptiveOnly: isAdaptiveOnlyModel(baseId),
    };
}

// ──────────────────────────────────────────────
// Extra Usage / 1M cooldown (Meridian's probe pattern)
// ──────────────────────────────────────────────

const EXTRA_USAGE_RETRY_MS = 60 * 60 * 1000; // 1 hour
let extraUsageUnavailableAt = 0;

export function recordExtendedContextUnavailable() {
    extraUsageUnavailableAt = Date.now();
}

export function isExtendedContextKnownUnavailable() {
    return extraUsageUnavailableAt > 0 && Date.now() - extraUsageUnavailableAt < EXTRA_USAGE_RETRY_MS;
}

/** Test seam. */
export function resetExtendedContextUnavailable() {
    extraUsageUnavailableAt = 0;
}

// ──────────────────────────────────────────────
// /v1/models handler
// ──────────────────────────────────────────────

export function listModelsHandler(_req, res) {
    const data = [];
    for (const m of CLAUDE_SUBSCRIPTION_MODELS) {
        data.push({
            id: m.id,
            object: 'model',
            created: 0,
            owned_by: 'anthropic',
            display_name: m.name,
            context_window: m.context,
        });
        if (m.oneM) {
            data.push({
                id: `${m.id}${ONE_M_SUFFIX}`,
                object: 'model',
                created: 0,
                owned_by: 'anthropic',
                display_name: `${m.name} (1M context)`,
                context_window: 1000000,
            });
        }
    }
    res.json({ object: 'list', data });
}
