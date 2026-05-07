// ──────────────────────────────────────────────
// SillyTavern Server Plugin — Claude (Subscription) Proxy
// ──────────────────────────────────────────────
//
// Exposes an OpenAI-compatible chat-completions API backed by the local
// Claude Agent SDK. Configure SillyTavern's "Chat Completion → Custom
// (OpenAI-compatible)" to point at:
//   http://<sillytavern-host>:<port>/api/plugins/claude-subscription/v1
//
// Routes registered under /api/plugins/claude-subscription/:
//   GET  /status                — SDK availability probe
//   GET  /v1/models             — curated Claude model list (OpenAI shape)
//   POST /v1/chat/completions   — proxy to Claude Agent SDK (stream + JSON)
//   POST /v1/embeddings         — explicit 501 (mirrors Marinara behavior)

import express from 'express';

import { handleChatCompletions, rejectEmbeddings } from './lib/chat.js';
import { handleStatus } from './lib/status.js';
import { listModelsHandler } from './lib/models.js';

export const info = {
    id: 'claude-subscription',
    name: 'Claude (Subscription) Proxy',
    description:
        'Routes chat through the local Claude Agent SDK so it bills against your Anthropic Pro / Max ' +
        'subscription instead of an sk-ant-* API key. Same auth mechanism Visual Studio Code, Cursor, ' +
        'and Zed use. Requires Claude Code on the host (`npm i -g @anthropic-ai/claude-code` + `claude login`).',
};

export async function init(router) {
    // SillyTavern hands plugins a fresh express.Router with no body parser;
    // attach JSON parsing locally. 50mb matches the limit ST uses for chat
    // completion requests so very long conversations don't get rejected.
    router.use(express.json({ limit: '50mb' }));

    router.get('/status', handleStatus);
    router.get('/v1/models', listModelsHandler);
    router.post('/v1/chat/completions', handleChatCompletions);
    router.post('/v1/embeddings', rejectEmbeddings);

    console.log(`[${info.id}] initialised — POST /api/plugins/${info.id}/v1/chat/completions`);
}

export async function exit() {
    console.log(`[${info.id}] shutting down`);
}

export default { info, init, exit };
