// ──────────────────────────────────────────────
// /status handler — SDK availability + credential health
// ──────────────────────────────────────────────
//
// Cheap, no-query status: does the SDK import, which version is it, and does
// a subscription credential exist / look unexpired. A real query is the only
// way to fully verify auth (the CLI may refresh a stale token itself), so
// `credential.expired: true` is a warning, not a verdict.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SDK_VERSION } from './jsonl-entries.js';
import { credentialSummary } from './oauth.js';

let cachedPluginVersion = null;
function getPluginVersion() {
    if (cachedPluginVersion) return cachedPluginVersion;
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
        cachedPluginVersion = pkg.version || '2.2.0';
    } catch {
        cachedPluginVersion = '2.2.0';
    }
    return cachedPluginVersion;
}

export async function handleStatus(_req, res) {
    const start = Date.now();
    const version = getPluginVersion();
    try {
        await import('@anthropic-ai/claude-agent-sdk');
        return res.json({
            ok: true,
            plugin: 'claude-subscription',
            version,
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
            version,
            sdk: 'unavailable',
            message: err instanceof Error ? err.message : String(err),
            latencyMs: Date.now() - start,
        });
    }
}
