// ──────────────────────────────────────────────
// /status handler — SDK availability + credential health
// ──────────────────────────────────────────────
//
// Cheap, no-query status: does the SDK import, which version is it, and does
// a subscription credential exist / look unexpired. A real query is the only
// way to fully verify auth (the CLI may refresh a stale token itself), so
// `credential.expired: true` is a warning, not a verdict.

import { SDK_VERSION } from './jsonl-entries.js';
import { credentialSummary } from './oauth.js';

export async function handleStatus(_req, res) {
    const start = Date.now();
    try {
        await import('@anthropic-ai/claude-agent-sdk');
        return res.json({
            ok: true,
            plugin: 'claude-subscription',
            version: '2.0.0',
            sdk: 'loaded',
            sdkVersion: SDK_VERSION,
            credential: credentialSummary(),
            note: 'Credential expiry is advisory — the CLI can refresh a stale token on the next chat.',
            latencyMs: Date.now() - start,
        });
    } catch (err) {
        return res.status(503).json({
            ok: false,
            plugin: 'claude-subscription',
            version: '2.0.0',
            sdk: 'unavailable',
            message: err instanceof Error ? err.message : String(err),
            latencyMs: Date.now() - start,
        });
    }
}
