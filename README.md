# SillyTavern — Claude (Subscription) Proxy

A SillyTavern **Server Plugin** that lets you use your **Anthropic Pro / Max
subscription** for chat instead of paying for API credits. Routes requests
through the locally-installed [Claude Agent SDK][sdk], the same mechanism
Visual Studio Code, Cursor, and Zed use for subscription-billed access.

It exposes an OpenAI-compatible chat-completions endpoint under your
SillyTavern server, so you point SillyTavern's **Chat Completion → Custom
(OpenAI-compatible)** source at it.

[sdk]: https://docs.anthropic.com/en/docs/claude-code/sdk

---

## Prerequisites

On the same machine SillyTavern runs on:

1. **Install Claude Code** (the SDK shells out to its CLI):
   ```
   npm i -g @anthropic-ai/claude-code
   ```
2. **Sign in once** with your Pro / Max account:
   ```
   claude login
   ```
3. SillyTavern's `config.yaml` must have `enableServerPlugins: true` (already
   the default in recent versions).

---

## Install

From your SillyTavern install directory (the one containing `server.js`):

```
node plugins.js install https://github.com/<you>/sillytavern-claude-subscription
cd plugins/sillytavern-claude-subscription
npm install
```

…then restart SillyTavern. You should see this in the server log:

```
[claude-subscription] initialised — POST /api/plugins/claude-subscription/v1/chat/completions
```

> **Local development install:** if you cloned the repo into `plugins/`
> manually instead of using `node plugins.js install`, just run
> `npm install` inside the plugin directory and restart.

---

## Configure SillyTavern

1. Open SillyTavern in your browser.
2. **API Connections** → set **Chat Completion Source** to
   **Custom (OpenAI-compatible)**.
3. **Custom Endpoint (Base URL):**
   ```
   http://localhost:8000/api/plugins/claude-subscription/v1
   ```
   *(replace host/port if your SillyTavern listens elsewhere)*
4. **Custom API Key:** any non-empty placeholder — the proxy ignores it.
   `sk-no-key` works.
5. Click **Connect**. The model dropdown will populate from the curated
   subscription list (Opus 4.7, Opus 4.6, Sonnet 4.6, Opus 4.5, Sonnet 4.5,
   Haiku 4.5).
6. Pick a model. Send a message.

> Anthropic gates which models each plan tier can use; if your subscription
> can't run the model you picked, the SDK will return a clear error.

---

## Optional — opt into API billing as a fallback

If you set a real `sk-ant-*` API key in SillyTavern's Custom API Key field,
the proxy forwards it as `ANTHROPIC_API_KEY` to the SDK. The SDK then bills
that key instead of your subscription. Useful as a safety net when
subscription auth is unavailable. Leave the field blank (or set
`sk-no-key`) to use subscription billing.

---

## Endpoints

All under `/api/plugins/claude-subscription/`:

| Method | Path                  | Purpose                                       |
| ------ | --------------------- | --------------------------------------------- |
| GET    | `/status`             | SDK availability probe                        |
| GET    | `/v1/models`          | Curated Claude model list (OpenAI shape)      |
| POST   | `/v1/chat/completions`| Proxy → Claude Agent SDK (SSE + JSON)         |
| POST   | `/v1/embeddings`      | Returns `501` — embeddings not supported      |

Quick sanity check from the SillyTavern host:

```
curl http://localhost:8000/api/plugins/claude-subscription/status
```

---

## Behavior — what mirrors Marinara

This plugin is a near-1:1 port of the
[`ClaudeSubscriptionProvider`](https://github.com/Pasta-Devs/Marinara-Engine/blob/main/packages/server/src/services/llm/providers/claude-subscription.provider.ts)
introduced in Marinara PR #243, plus the follow-up fixes from #246, #294, and
#362. Concretely:

- **Lazy SDK load** with cached promise; failure throws a friendly "install
  Claude Code + `claude login`" error.
- **Transcript rendering** — system messages → `systemPrompt`, user/assistant
  turns folded into a labelled prompt. Empty-prompt safety net injects a
  minimal `User: [Start]` turn.
- **Built-in agent tools disabled** (`tools: []`,
  `permissionMode: 'bypassPermissions'`) — SillyTavern owns the conversation
  surface.
- **No `maxTurns`** — see Marinara PR #294: internal thinking steps consume
  turn budget alongside the assistant response, so capping at 1 caused
  `error_max_turns`.
- **Adaptive thinking** auto-enabled for Opus 4.7+ (always-thinking family);
  honored for other models when the request includes a `reasoning_effort`.
- **API-key fallback** via `ANTHROPIC_API_KEY` env when an
  `Authorization: Bearer <key>` header is supplied with a real key.
- **Embeddings rejected** — configure a separate embedding source.

OpenAI-format streaming SSE is emitted for `stream: true` (the SillyTavern
default for chat completions); `stream: false` returns a single JSON
response.

---

## Troubleshooting

**`Failed to load @anthropic-ai/claude-agent-sdk` on first request**
You skipped `npm install` inside the plugin directory, or Claude Code isn't
installed on the host. Re-run the prerequisites and restart SillyTavern.

**`Claude (Subscription) request failed: ... not authenticated`**
Run `claude login` on the SillyTavern host (the one running `server.js`),
not on your remote / browsing machine. The credentials live in the SDK's
local store on that host.

**SillyTavern reports `model not found`**
The SillyTavern UI may cache the model list. Click **Connect** again or
reload the page. The plugin's `/v1/models` endpoint always returns the
curated list.

**`error_max_turns`**
You're on an older version of the plugin that still sets `maxTurns: 1`.
Pull the latest — internal thinking steps consume turn budget so the cap
needs to be removed (see Marinara PR #294).

---

## License

[GNU Affero General Public License v3.0 or later](LICENSE).
