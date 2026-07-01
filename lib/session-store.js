// ──────────────────────────────────────────────
// SessionStore adapter + scratch cwd + transcript privacy sweep
// ──────────────────────────────────────────────
//
// The SDK's `resume` + `sessionStore` combo lets us inject prior turns
// without touching the filesystem: the SDK calls `load()` once before
// spawning the subprocess, materializes the entries to its own temp JSONL,
// and resumes from there. `load()` matches on sessionId alone — we mint a
// fresh UUID per request, so no cwd→projectKey path math is needed
// (the part Marinara's earlier hand-rolled approach got wrong on Windows).
//
// PRIVACY: the subprocess still writes each live turn's transcript to a real
// session file under ~/.claude/projects/<scratch-key>/ (`sessionStore` cannot
// be combined with `persistSession: false`). Marinara leaves those roleplay
// transcripts on disk until Claude Code's cleanupPeriodDays reaps them — we
// don't: after each request the plugin best-effort deletes the session file
// via the SDK's own deleteSession(). Roleplay content should not persist in
// plaintext outside SillyTavern.

import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_TAG = '[claude-subscription]';

/** One-shot in-process SessionStore holding the synthetic history for a
 *  single query() call. `append()` is a required part of the contract but a
 *  deliberate no-op — SillyTavern owns chat persistence. */
export class ResumeSessionStore {
    #sessionId;
    #entries;

    constructor(sessionId, entries) {
        this.#sessionId = sessionId;
        this.#entries = entries;
    }

    load(key) {
        return Promise.resolve(key.sessionId === this.#sessionId ? this.#entries : null);
    }

    append(_key, _entries) {
        return Promise.resolve();
    }
}

// Scratch working directory for SDK subprocess cwd — keeps the live-turn
// transcripts in their own project bucket instead of intermingling with the
// user's real `claude` CLI sessions. Recreated on demand if pruned.
let cachedScratchCwd = null;

export function resumeScratchCwd() {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = cachedScratchCwd ?? resolve(here, '..', '.scratch-cwd');
    mkdirSync(dir, { recursive: true });
    cachedScratchCwd = dir;
    return dir;
}

/**
 * Best-effort removal of the live-turn transcript the subprocess wrote for
 * this session. Fire-and-forget; failures only mean the file waits for
 * Claude Code's own cleanupPeriodDays sweep instead.
 */
export function sweepSessionTranscript(loadSdk, sessionId) {
    setTimeout(async () => {
        try {
            const sdk = await loadSdk();
            if (typeof sdk.deleteSession === 'function') {
                await sdk.deleteSession(sessionId);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // "not found" is fine — nothing was persisted for this session.
            if (!/not found/i.test(msg)) {
                console.warn(`${PLUGIN_TAG} transcript sweep for ${sessionId} skipped: ${msg}`);
            }
        }
    }, 2000).unref?.();
}
