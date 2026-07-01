// ──────────────────────────────────────────────
// Standalone HTTP listener (separate from SillyTavern's Express app)
// ──────────────────────────────────────────────
//
// SillyTavern wraps its entire Express app in CSRF protection
// (server-main.js — csrfSync mounted before plugins load). When SillyTavern's
// chat-completions backend issues a server-side outbound fetch to whatever
// URL the user put in "Custom Endpoint", that loopback request has no CSRF
// token and gets a 403 Forbidden — even if the URL points at one of our own
// /api/plugins routes. The clean fix is a separate port outside SillyTavern's
// middleware stack.
//
// GET routes carry permissive CORS so the companion UI extension (running on
// the SillyTavern browser origin) can read /status and /v1/usage/quota
// directly. The listener binds 127.0.0.1 by default; POST /v1/chat/completions
// is only ever called server-side by SillyTavern itself.

import express from 'express';

import { handleChatCompletions, rejectEmbeddings } from './chat.js';
import { listModelsHandler } from './models.js';
import { handleStatus } from './status.js';
import { handleQuota } from './oauth.js';

let serverInstance = null;

// Reflect only loopback origins — a wildcard would let ANY web page the user
// visits read subscription/billing data off these unauthenticated GETs.
function allowCorsGet(req, res, next) {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
}

export function startStandaloneListener({ port, host }) {
    if (serverInstance) return Promise.resolve(serverInstance);

    const app = express();
    app.use(express.json({ limit: '100mb' }));

    app.get('/status', allowCorsGet, handleStatus);
    app.get('/v1/models', allowCorsGet, listModelsHandler);
    app.get('/v1/usage/quota', allowCorsGet, handleQuota);
    app.options(['/status', '/v1/models', '/v1/usage/quota'], allowCorsGet, (_req, res) => res.sendStatus(204));
    app.post('/v1/chat/completions', handleChatCompletions);
    app.post('/v1/embeddings', rejectEmbeddings);

    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            serverInstance = server;
            console.log(
                `[claude-subscription] standalone listener: http://${host}:${port}/v1 ` +
                '(the companion UI extension configures SillyTavern automatically)',
            );
            resolve(server);
        });

        server.on('error', (err) => {
            if (err && err.code === 'EADDRINUSE') {
                console.error(
                    `[claude-subscription] port ${port} is already in use. Set ` +
                    'CLAUDE_SUBSCRIPTION_PORT to a free port and restart SillyTavern — ' +
                    'then update "Endpoint (advanced)" in the Claude Max panel to match.',
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
