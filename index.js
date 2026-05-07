// ──────────────────────────────────────────────
// SillyTavern Server Plugin — Claude (Subscription) Proxy
// ──────────────────────────────────────────────
//
// Exposes an OpenAI-compatible chat-completions API backed by the local
// Claude Agent SDK. The chat endpoints run on a *separate* HTTP listener
// (default 127.0.0.1:8901) so they sit outside SillyTavern's CSRF
// middleware — SillyTavern's chat-completions backend issues a server-side
// outbound fetch to the configured Custom Endpoint, and that loopback fetch
// has no CSRF token, which would be rejected if the route lived under the
// SillyTavern Express app. See lib/listener.js for the rationale.
//
// Configure SillyTavern's "Chat Completion → Custom (OpenAI-compatible)" to:
//   http://localhost:8901/v1
//
// (Or whichever host:port the listener started on — see startup log.)
//
// Override the port/host with env vars before launching SillyTavern:
//   CLAUDE_SUBSCRIPTION_PORT=8901
//   CLAUDE_SUBSCRIPTION_HOST=127.0.0.1
//
// The plugin also registers /api/plugins/claude-subscription/status on
// SillyTavern's own router (GET is exempt from CSRF) — useful for a quick
// in-browser health check that the plugin loaded.

import express from 'express';

import { handleStatus } from './lib/status.js';
import { startStandaloneListener, stopStandaloneListener } from './lib/listener.js';

const DEFAULT_PORT = 8901;
const DEFAULT_HOST = '127.0.0.1';

export const info = {
    id: 'claude-subscription',
    name: 'Claude (Subscription) Proxy',
    description:
        'Routes chat through the local Claude Agent SDK so it bills against your Anthropic Pro / Max ' +
        'subscription instead of an sk-ant-* API key. Same auth mechanism Visual Studio Code, Cursor, ' +
        'and Zed use. Requires Claude Code on the host (`npm i -g @anthropic-ai/claude-code` + `claude login`).',
};

export async function init(router) {
    // /status is the only route on the SillyTavern-mounted router. Browser
    // can hit http://<sillytavern>/api/plugins/claude-subscription/status to
    // verify the plugin is loaded; GET is exempt from CSRF so this works.
    router.use(express.json({ limit: '50mb' }));
    router.get('/status', handleStatus);

    // Real proxy lives on a separate port outside SillyTavern's Express app.
    const port = parseInt(process.env.CLAUDE_SUBSCRIPTION_PORT, 10) || DEFAULT_PORT;
    const host = process.env.CLAUDE_SUBSCRIPTION_HOST || DEFAULT_HOST;

    try {
        await startStandaloneListener({ port, host });
        console.log(
            `[${info.id}] initialised — set SillyTavern Custom Endpoint to http://${host}:${port}/v1`,
        );
    } catch (err) {
        console.error(
            `[${info.id}] failed to start standalone listener — chat completions will not work. ` +
            'Status endpoint on /api/plugins/claude-subscription/status remains available.',
            err,
        );
    }
}

export async function exit() {
    await stopStandaloneListener();
    console.log(`[${info.id}] shut down`);
}

export default { info, init, exit };
