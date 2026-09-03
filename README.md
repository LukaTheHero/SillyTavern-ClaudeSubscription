# SillyTavern — Claude (Subscription) Proxy

Use your **Anthropic Pro / Max subscription** for SillyTavern chat instead of
paying for API credits. A SillyTavern **Server Plugin** routes requests
through the locally-installed [Claude Agent SDK][sdk] — the same subscription
mechanism VS Code, Cursor, and Zed use — and ships with a companion
**"Claude Max" UI extension** for one-click connection and Claude-native
settings.

<img width="954" height="1736" alt="Screenshot 2026-07-01 195136" src="https://github.com/user-attachments/assets/34199be7-9d69-402e-ac98-8589ab40c955" />


[sdk]: https://docs.anthropic.com/en/docs/claude-code/sdk

## What v2 gives you

- **Current models** — Claude Fable 5.1/5, Opus 5/4.8/4.7/4.6/4.5, Sonnet 4.6/4.5,
  Haiku 4.5, plus explicit **"(1M context)"** variants for the tiers that
  support extended context.
- **One-click connect** — the Claude Max panel (Extensions drawer) configures
  SillyTavern's Custom endpoint for you. No URLs to paste.
- **Claude-native reasoning effort** — `low / medium / high / xhigh / max`,
  set in the Claude Max panel. SillyTavern's built-in Reasoning Effort
  dropdown does **not** work for Claude models on Custom endpoints (its
  "Maximum" is downgraded to `high` client-side, and the field is dropped
  server-side for non-OpenAI model IDs) — this panel bypasses all of that.
- **Thinking display** — Claude's reasoning streams into SillyTavern's native
  collapsible "thoughts" block (`reasoning_content`). Toggle in the panel;
  also enable "Show model thoughts" in ST's settings.
- **Real multi-turn context** — chat history is replayed as a genuine Claude
  session (synthetic session resume), not folded into one giant string:
  proper role separation, working prompt caching, better long-RP quality.
- **Roleplay isolation** — no coding system prompt, no host CLAUDE.md /
  settings / MCP connectors leaking into your scenes, no agent tools. Your
  character card and world info are the entire system prompt.
- **Stop sequences enforced** — the Agent SDK has none, so the plugin scans
  the stream server-side (`\n{{user}}:` guards work as expected).
- **Resilience** — automatic OAuth token refresh, rate-limit retries,
  1M-context → base-model fallback with a one-hour probe cooldown.
- **Served-model guard** — an explicit Fable request is NEVER silently
  substituted: if the upstream resolves your `claude-fable-5-1` or `claude-fable-5` pick to
  anything else (e.g. Fable temporarily disabled on your plan), the request
  errors out with a clear message instead of quietly switching to Opus
  mid-roleplay.
- **Quota meter** — live 5-hour / 7-day subscription window utilization in
  the panel, so a long session never hits a surprise lockout.
- **Privacy sweep** — the transcript the Claude CLI writes for each live turn
  is deleted after the request; your roleplay does not persist in plaintext
  under `~/.claude/projects`.

## Prerequisites

On the same machine SillyTavern runs on:

1. **Sign in once** with your Pro / Max account (installs nothing into ST):
   ```
   npm i -g @anthropic-ai/claude-code
   claude login
   ```
   (Headless / Docker: generate a token with `claude setup-token` and set
   `CLAUDE_CODE_OAUTH_TOKEN` instead.)
2. SillyTavern `config.yaml`: `enableServerPlugins: true`.

## Install

From your SillyTavern install directory (the one containing `server.js`):

```
node plugins.js install https://github.com/LukaTheHero/SillyTavern-ClaudeSubscription
cd plugins/SillyTavern-ClaudeSubscription
npm install
```

Restart SillyTavern. The server log should show:

```
[claude-subscription] installed UI extension v2.0.1 at public/scripts/extensions/third-party/SillyTavern-ClaudeMax
[claude-subscription] standalone listener: http://127.0.0.1:8901/v1
[claude-subscription] initialised — endpoint http://127.0.0.1:8901/v1
```

> The companion **Claude Max** UI extension is installed/updated
> automatically on startup. Hard-refresh the browser (Ctrl+F5) after the
> first install so SillyTavern loads it. Opt out with
> `CLAUDE_SUBSCRIPTION_NO_UI_INSTALL=1`.

### Alternative: install the panel via the extension dialog

The repo doubles as a regular UI extension (`manifest.json` at the root), so
the **Claude Max panel** can also be installed from **Extensions → Install
extension** by pasting the same GitHub URL. The auto-installer detects a
dialog-installed copy and stands down (and a runtime guard dedupes if both
ever load).

> ⚠️ The dialog installs **only the panel**. The **server plugin** (the
> actual proxy) must still be installed into `plugins/` as above — without
> it, Connect has nothing to connect to.

## Connect

1. Open the **Extensions** drawer → **Claude Max**.
2. Click **Connect to Claude Max**.
3. Pick a model from the normal model dropdown (e.g. *Claude Fable 5.1* or
   *Claude Opus 5 (1M context)*).
4. Chat.

Set effort/thinking in the same panel — changes apply from the next message,
no reconnect needed.

### Settings reference (Claude Max panel)

| Setting | Default | What it does |
| --- | --- | --- |
| Reasoning effort | Auto | How hard Claude reasons before replying, `low → max`. Auto sends nothing (model default, ≈high). Higher = better consistency on complex scenes, slower replies, more quota. |
| Thinking mode | Adaptive | Whether extended thinking happens at all. **Adaptive**: model thinks only when the message warrants it. **Always on**: every reply. **Off**: none — except Fable 5/5.1 and Opus 4.7+ / Opus 5 *always* think (can't be disabled), and thinking is auto-disabled on other models when Max response length < 2048 tokens. |
| Show reasoning | On | **Display only** — doesn't change whether thinking happens. On: the thinking summary streams into ST's collapsible "thoughts" box (enable "Show model thoughts" in ST too). Never added to chat history or re-sent as context. |
| Identity mode | Off | Off: your character card is the *entire* system prompt. On: prepends Anthropic's Claude Code preamble (the framing the `claude` CLI uses) — fixes model self-identification ("are you Opus or Sonnet?") at the cost of extra tokens and a coding-assistant flavor. Leave off for RP. |
| Session resume | On | How history reaches Claude. On: replayed as a real multi-turn session — better turn awareness, working prompt caching (faster + less quota burned re-reading context); swipes/edits handled naturally. Off: history flattened to one `User:/Assistant:` text block (troubleshooting only). |

### Known limitations (Agent SDK)

- **Temperature / Top-P / Top-K are not supported** on the subscription path
  — the Agent SDK exposes no sampling controls. (Adaptive-thinking models
  reject them anyway.)
- **Assistant prefill is emulated**: a trailing assistant message ("Start
  Reply With", continue) becomes a continuation instruction rather than true
  Messages-API prefill. Works well in practice; the model occasionally
  paraphrases instead of continuing verbatim.
- Embeddings return `501` — use a separate embedding source.

## Environment overrides

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_SUBSCRIPTION_PORT` | `8901` | Listener port |
| `CLAUDE_SUBSCRIPTION_HOST` | `127.0.0.1` | Listener host |
| `CLAUDE_SUBSCRIPTION_USE_RESUME` | `1` | `0` forces the fold path |
| `CLAUDE_SUBSCRIPTION_MAX_TURNS` | `1` | SDK maxTurns |
| `CLAUDE_SUBSCRIPTION_CLAUDE_PATH` | – | Explicit `claude` executable path |
| `CLAUDE_SUBSCRIPTION_NO_UI_INSTALL` | – | `1` skips UI-extension auto-install |

> Changing the port or host? Update **Endpoint (advanced)** in the Claude Max
> panel to the new `http://<host>:<port>/v1` before clicking **Connect** —
> the panel's Connect button, per-request settings injection, and quota meter
> all use that stored endpoint.

## Endpoints

| Method | URL | Purpose |
| --- | --- | --- |
| GET | `http://127.0.0.1:8901/status` | SDK + credential health |
| GET | `http://127.0.0.1:8901/v1/models` | Model list (incl. 1M variants) |
| GET | `http://127.0.0.1:8901/v1/usage/quota` | Subscription window utilization |
| POST | `http://127.0.0.1:8901/v1/chat/completions` | Chat (SSE + JSON) |
| POST | `http://127.0.0.1:8901/v1/embeddings` | Always `501` |
| GET | `http://<sillytavern>/api/plugins/claude-subscription/status` | Browser health check |

Direct API users: the plugin accepts the standard `reasoning_effort` body
field, or a `claude_subscription: { effort, thinking, thinking_budget,
show_reasoning, identity_mode, use_resume }` object for full control.
`thinking_budget` (tokens) only applies when `thinking: "on"` and the model
is not adaptive-only (Opus 4.7+/Opus 5/Fable ignore it); it is clamped to ≥ 1024
and ≤ `max_tokens − 512`.

## API-billing fallback (optional)

Enter a real `sk-ant-*` key as the Custom API key and the plugin forwards it
as `ANTHROPIC_API_KEY` — billing that key instead of the subscription.
Anything else in the key field is ignored (subscription auth).

## Troubleshooting

**"Failed to load @anthropic-ai/claude-agent-sdk"** — run `npm install`
inside the plugin directory (without `--omit=optional`; the Claude CLI ships
inside the SDK as a platform package) and restart SillyTavern.

**Auth errors mid-chat** — the plugin auto-refreshes the OAuth token once per
request; if it still fails, run `claude login` on the SillyTavern host **as
the same OS user** that runs `server.js`.

**Model list didn't populate** — click Connect again; check
`http://127.0.0.1:8901/status` in a browser.

**1M variant quietly serving 200k** — extended context needs Extra Usage on
some plans; after one failure the plugin serves the base model for an hour,
then probes again. Watch the server log for the cooldown message.

## License

[GNU AGPL v3.0 or later](LICENSE).
