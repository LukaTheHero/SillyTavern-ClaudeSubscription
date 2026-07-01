// ──────────────────────────────────────────────
// Lazy import wrapper for @anthropic-ai/claude-agent-sdk
// ──────────────────────────────────────────────
//
// The SDK is heavy; keeping the import behind a cached promise avoids loading
// it until the first chat request. On failure the cache is cleared so the
// next request retries the import.
//
// NOTE on 0.2.x installs: the Claude Code CLI ships INSIDE the SDK as
// per-platform optionalDependencies (@anthropic-ai/claude-agent-sdk-win32-x64
// etc.). If npm installed with --omit=optional, the import succeeds but
// query() throws "Native CLI binary for <platform>-<arch> not found" — the
// fix is reinstalling without --omit=optional (or setting
// CLAUDE_SUBSCRIPTION_CLAUDE_PATH to a claude executable), NOT installing
// claude-code globally.

let cachedSdk = null;

export function loadSdk() {
    if (!cachedSdk) {
        cachedSdk = import('@anthropic-ai/claude-agent-sdk').catch((err) => {
            cachedSdk = null;
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                'Failed to load @anthropic-ai/claude-agent-sdk. Run `npm install` inside the plugin ' +
                'directory (plugins/SillyTavern-ClaudeSubscription) WITHOUT --omit=optional, restart ' +
                'SillyTavern, and make sure `claude login` has been run once on this host. ' +
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
