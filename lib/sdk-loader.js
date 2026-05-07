// ──────────────────────────────────────────────
// Lazy import wrapper for @anthropic-ai/claude-agent-sdk
// ──────────────────────────────────────────────
//
// The SDK is heavy and pulls in optional native pieces; keeping the import
// behind a cached promise avoids loading it until the first chat request.
// On failure the cache is cleared so the next request retries the import
// (e.g. after the user installs Claude Code and restarts SillyTavern).

let cachedSdk = null;

export function loadSdk() {
    if (!cachedSdk) {
        cachedSdk = import('@anthropic-ai/claude-agent-sdk').catch((err) => {
            cachedSdk = null;
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                'Failed to load @anthropic-ai/claude-agent-sdk. Install Claude Code on this host ' +
                '(npm i -g @anthropic-ai/claude-code) and run `claude login` once. ' +
                `Underlying error: ${msg}`,
            );
        });
    }
    return cachedSdk;
}

// Test seam — replace the cached SDK module with a fake or clear it.
export function __setSdkForTesting(mod) {
    cachedSdk = mod ? Promise.resolve(mod) : null;
}
