// ──────────────────────────────────────────────
// Standalone HTTP listener (separate from SillyTavern's Express app)
// ──────────────────────────────────────────────
//
// SillyTavern wraps its entire Express app in CSRF protection
// (server-main.js — csrfSyncProtection.csrfSynchronisedProtection mounted
// before plugins load). When SillyTavern's chat-completions backend issues
// a server-side outbound fetch to whatever URL the user put in
// "Custom Endpoint", that loopback request has no CSRF token and gets a
// 403 Forbidden — even if the URL points at one of our own /api/plugins
// routes.
//
// The clean fix is to expose the chat-completions endpoints on a separate
// port that lives *outside* SillyTavern's Express app and therefore
// outside its CSRF middleware.

import express from 'express';

import { handleChatCompletions, rejectEmbeddings } from './chat.js';
import { listModelsHandler } from './models.js';
import { handleStatus } from './status.js';

let serverInstance = null;

export function startStandaloneListener({ port, host }) {
    if (serverInstance) return serverInstance;

    const app = express();
    app.use(express.json({ limit: '50mb' }));

    // Same routes as on the SillyTavern-mounted router, just under a /v1
    // prefix so the user can paste the listener URL directly into
    // "Custom Endpoint" in SillyTavern (which appends /chat/completions etc.).
    app.get('/status', handleStatus);
    app.get('/v1/models', listModelsHandler);
    app.post('/v1/chat/completions', handleChatCompletions);
    app.post('/v1/embeddings', rejectEmbeddings);

    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            serverInstance = server;
            console.log(
                `[claude-subscription] standalone listener: http://${host}:${port}/v1 ` +
                '(point SillyTavern Custom Endpoint here)',
            );
            resolve(server);
        });

        server.on('error', (err) => {
            if (err && err.code === 'EADDRINUSE') {
                console.error(
                    `[claude-subscription] port ${port} is already in use. Set ` +
                    'CLAUDE_SUBSCRIPTION_PORT to a free port and restart SillyTavern.',
                );
            } else {
                console.error('[claude-subscription] listener error:', err);
            }
            reject(err);
        });
    });
}

export function stopStandaloneListener() {
    if (!serverInstance) return Promise.resolve();
    return new Promise((resolve) => {
        serverInstance.close(() => {
            serverInstance = null;
            resolve();
        });
    });
}
