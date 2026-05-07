// ──────────────────────────────────────────────
// /status handler — does the SDK load?
// ──────────────────────────────────────────────
//
// Mirrors the short-circuit behavior of Marinara's connections.routes.ts
// /test endpoint: import the SDK, return success with a hint that the first
// chat will fail if `claude login` hasn't been run on this host. We can't
// verify login without actually issuing a query, which would be wasteful.

export async function handleStatus(_req, res) {
    const start = Date.now();
    try {
        await import('@anthropic-ai/claude-agent-sdk');
        return res.json({
            ok: true,
            sdk: 'loaded',
            note: 'The first chat will fail if `claude login` has not been run on this host.',
            latencyMs: Date.now() - start,
        });
    } catch (err) {
        return res.status(503).json({
            ok: false,
            sdk: 'unavailable',
            message: err instanceof Error ? err.message : String(err),
            latencyMs: Date.now() - start,
        });
    }
}
