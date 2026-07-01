// ──────────────────────────────────────────────
// Claude Max — companion UI extension for the claude-subscription server plugin
// ──────────────────────────────────────────────
//
// What it does:
//   • One-click Connect: pilots SillyTavern's Custom (OpenAI-compatible)
//     source at the plugin's local endpoint — no URL typing. Uses the same
//     jQuery val()/trigger() path as ST's own /api-url slash command, so the
//     model list populates exactly like a manual connect.
//   • Claude-native settings (effort low..max, thinking mode, reasoning
//     display, identity mode, session resume) injected per-request through
//     `custom_include_body` — the only channel ST's backend forwards
//     unconditionally for Custom sources. ST's own Reasoning Effort dropdown
//     is bypassed entirely (it downgrades max→high client-side and drops the
//     field for Claude model IDs server-side); leave it on "Auto".
//   • Quota meter: reads the plugin's /v1/usage/quota (5-hour / 7-day
//     subscription windows) so long roleplay sessions don't hit a surprise
//     lockout.
//
// Injection is scoped: it only fires when the active connection actually
// points at this plugin's endpoint, so other Custom endpoints (Meridian,
// llama.cpp, etc.) are untouched.

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE = 'claude_max';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8901/v1';

const VALID_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
const VALID_THINKING = ['adaptive', 'on', 'off'];

const defaultSettings = {
    enabled: true,
    endpoint: DEFAULT_ENDPOINT,
    effort: 'auto',          // 'auto' = don't send → model default
    thinking: 'adaptive',
    showReasoning: true,
    identityMode: false,
    useResume: true,
};

function getSettings() {
    if (extension_settings[MODULE] === undefined) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key in defaultSettings) {
        if (extension_settings[MODULE][key] === undefined) {
            extension_settings[MODULE][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE];
}

function normalizeEndpoint(url) {
    return String(url ?? '').trim().replace(/\/+$/, '');
}

function isOurEndpoint(customUrl, settings) {
    const a = normalizeEndpoint(customUrl);
    const b = normalizeEndpoint(settings.endpoint);
    return a !== '' && a === b;
}

// ──────────────────────────────────────────────
// One-click connect (same selector path as ST's /api-url command)
// ──────────────────────────────────────────────

function connect(settings) {
    try {
        $('#main_api').val('openai').trigger('change');
        // Endpoint + key MUST be set before the source change: ST's change
        // handler auto-reconnects immediately, and firing it with the stale
        // custom_url would race a status check against the wrong endpoint
        // (whichever fetch resolves last populates the model dropdown).
        $('#custom_api_url_text').val(settings.endpoint).trigger('input');
        // Key is optional for Custom; a placeholder keeps ST's UI quiet. The
        // plugin ignores non-sk-ant values (subscription auth).
        const keyField = $('#api_key_custom');
        if (keyField.length && !String(keyField.val() ?? '').trim()) {
            keyField.val('sk-no-key-needed');
        }
        $('#chat_completion_source').val('custom').trigger('change');
        $('#api_button_openai').trigger('click');
        toastr?.success?.('Connecting to Claude Max — the model list will populate in a moment.', 'Claude Max');
    } catch (err) {
        console.error('[claude-max] connect failed', err);
        toastr?.error?.(String(err), 'Claude Max');
    }
}

// ──────────────────────────────────────────────
// Per-request injection (CHAT_COMPLETION_SETTINGS_READY)
// ──────────────────────────────────────────────

function buildIncludeBodyYaml(settings) {
    // YAML the backend merges into the request body root. Nested mapping
    // arrives as body.claude_subscription on the plugin listener.
    const lines = ['claude_subscription:'];
    if (settings.effort !== 'auto') lines.push(`  effort: ${settings.effort}`);
    lines.push(`  thinking: ${settings.thinking}`);
    lines.push(`  show_reasoning: ${settings.showReasoning}`);
    lines.push(`  identity_mode: ${settings.identityMode}`);
    lines.push(`  use_resume: ${settings.useResume}`);
    return lines.join('\n');
}

function onSettingsReady(data) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;
        if (!data || data.chat_completion_source !== 'custom') return;
        if (!isOurEndpoint(data.custom_url, settings)) return;

        // Strip any previous block we injected (or a stale manual one), then
        // append the current settings. Only the transient request payload is
        // touched — the user's saved Additional Parameters stay intact.
        const existing = typeof data.custom_include_body === 'string' ? data.custom_include_body : '';
        const cleaned = existing
            .replace(/^claude_subscription:[\s\S]*?(?=^\S|\s*$(?![\s\S]))/m, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        data.custom_include_body = (cleaned ? cleaned + '\n' : '') + buildIncludeBodyYaml(settings);
    } catch (err) {
        console.error('[claude-max] failed to inject settings', err);
    }
}

// ──────────────────────────────────────────────
// Quota meter
// ──────────────────────────────────────────────

const WINDOW_LABELS = {
    five_hour: '5-hour window',
    seven_day: '7-day (all models)',
    seven_day_opus: '7-day (Opus)',
    seven_day_sonnet: '7-day (Sonnet)',
    seven_day_oauth_apps: '7-day (apps)',
};

async function refreshQuota() {
    const settings = getSettings();
    const box = document.getElementById('claude_max_quota');
    if (!box) return;
    box.textContent = 'Loading…';
    try {
        // Same-origin ST plugin route first — a direct fetch to the listener
        // resolves 127.0.0.1 to the CLIENT device and fails whenever the ST
        // UI is opened from a phone or another PC. Fall back to the direct
        // listener URL for custom-endpoint setups.
        let res = null;
        try {
            res = await fetch('/api/plugins/claude-subscription/quota', { signal: AbortSignal.timeout(12000) });
        } catch { /* ST route unavailable — fall back below */ }
        if (!res || !res.ok) {
            const base = normalizeEndpoint(settings.endpoint).replace(/\/v1$/, '');
            res = await fetch(`${base}/v1/usage/quota`, { signal: AbortSignal.timeout(12000) });
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        box.innerHTML = '';
        if (!data.windows?.length) {
            box.textContent = 'No quota data returned.';
            return;
        }
        for (const w of data.windows) {
            const pct = w.utilization !== null ? Math.round(w.utilization * 100) : null;
            const row = document.createElement('div');
            row.classList.add('claude-max-quota-row');
            const label = document.createElement('span');
            label.textContent = WINDOW_LABELS[w.type] ?? w.type;
            const bar = document.createElement('div');
            bar.classList.add('claude-max-quota-bar');
            const fill = document.createElement('div');
            fill.classList.add('claude-max-quota-fill');
            fill.style.width = `${Math.min(100, pct ?? 0)}%`;
            if ((pct ?? 0) >= 90) fill.classList.add('critical');
            else if ((pct ?? 0) >= 70) fill.classList.add('warning');
            bar.append(fill);
            const value = document.createElement('span');
            const resets = w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
            value.textContent = pct !== null ? `${pct}%${resets}` : `–${resets}`;
            row.append(label, bar, value);
            box.append(row);
        }
        if (data.extraUsage?.isEnabled) {
            const extra = document.createElement('div');
            extra.classList.add('claude-max-quota-extra');
            extra.textContent = `Extra Usage: ${data.extraUsage.usedCredits} / ${data.extraUsage.monthlyLimit} ${data.extraUsage.currency}`;
            box.append(extra);
        }
    } catch (err) {
        box.textContent = `Quota unavailable (${err instanceof Error ? err.message : err}). Is the server plugin running?`;
    }
}

// ──────────────────────────────────────────────
// Settings UI
// ──────────────────────────────────────────────

function makeSelectRow(labelText, id, values, current, onChange, labels = {}) {
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    label.classList.add('claude-max-label');
    const select = document.createElement('select');
    select.id = id;
    select.classList.add('text_pole');
    for (const v of values) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = labels[v] ?? v;
        if (v === current) opt.selected = true;
        select.append(opt);
    }
    select.addEventListener('change', () => onChange(select.value));
    return [label, select];
}

function makeCheckboxRow(labelText, id, checked, onChange, hint) {
    const wrap = document.createElement('label');
    wrap.classList.add('checkbox_label');
    wrap.htmlFor = id;
    const box = document.createElement('input');
    box.id = id;
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    const text = document.createElement('span');
    text.textContent = labelText;
    if (hint) text.title = hint;
    wrap.append(box, text);
    return wrap;
}

function addExtensionSettings(settings) {
    const container = document.getElementById('extensions_settings') ?? document.body;

    const drawer = document.createElement('div');
    drawer.classList.add('inline-drawer');
    container.append(drawer);

    const toggle = document.createElement('div');
    toggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');
    const title = document.createElement('b');
    title.textContent = 'Claude Max';
    const icon = document.createElement('div');
    icon.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');
    toggle.append(title, icon);

    const content = document.createElement('div');
    content.classList.add('inline-drawer-content');
    drawer.append(toggle, content);

    // Connect button + endpoint
    const connectBtn = document.createElement('div');
    connectBtn.classList.add('menu_button', 'claude-max-connect');
    connectBtn.textContent = 'Connect to Claude Max';
    connectBtn.title = 'Switches the API to Chat Completion → Custom and points it at the local Claude subscription proxy. Pick a model from the regular model dropdown afterwards.';
    connectBtn.addEventListener('click', () => connect(getSettings()));
    content.append(connectBtn);

    const endpointLabel = document.createElement('label');
    endpointLabel.classList.add('claude-max-label');
    endpointLabel.textContent = 'Endpoint (advanced)';
    const endpointInput = document.createElement('input');
    endpointInput.type = 'text';
    endpointInput.classList.add('text_pole');
    endpointInput.value = settings.endpoint;
    endpointInput.addEventListener('input', () => {
        settings.endpoint = endpointInput.value || DEFAULT_ENDPOINT;
        saveSettingsDebounced();
    });
    content.append(endpointLabel, endpointInput);

    content.append(makeCheckboxRow('Enabled (inject Claude settings into requests)', 'claudeMaxEnabled', settings.enabled, (v) => {
        settings.enabled = v; saveSettingsDebounced();
    }));

    // Effort
    const [effortLabel, effortSelect] = makeSelectRow(
        'Reasoning effort (Claude-native)', 'claudeMaxEffort', VALID_EFFORTS, settings.effort,
        (v) => { settings.effort = VALID_EFFORTS.includes(v) ? v : 'auto'; saveSettingsDebounced(); },
        { auto: 'Auto (model default)', xhigh: 'xhigh (deeper)', max: 'max (deepest)' },
    );
    content.append(effortLabel, effortSelect);

    // Thinking
    const [thinkLabel, thinkSelect] = makeSelectRow(
        'Thinking mode', 'claudeMaxThinking', VALID_THINKING, settings.thinking,
        (v) => { settings.thinking = VALID_THINKING.includes(v) ? v : 'adaptive'; saveSettingsDebounced(); },
        { adaptive: 'Adaptive (model decides — recommended)', on: 'Always on', off: 'Off (ignored by always-thinking models)' },
    );
    content.append(thinkLabel, thinkSelect);

    content.append(makeCheckboxRow('Show reasoning (collapsible thinking box)', 'claudeMaxShowReasoning', settings.showReasoning, (v) => {
        settings.showReasoning = v; saveSettingsDebounced();
    }, 'Streams thinking as reasoning_content. Also enable "Show model thoughts" in ST settings.'));

    content.append(makeCheckboxRow('Identity mode (Claude Code preamble)', 'claudeMaxIdentity', settings.identityMode, (v) => {
        settings.identityMode = v; saveSettingsDebounced();
    }, 'Keeps the coding system prompt so the model self-identifies correctly. Costs tokens and adds coding framing — leave OFF for roleplay.'));

    content.append(makeCheckboxRow('Session resume (multi-turn context + caching)', 'claudeMaxResume', settings.useResume, (v) => {
        settings.useResume = v; saveSettingsDebounced();
    }, 'Replays chat history as a real Claude session instead of one folded string. Disable only for troubleshooting.'));

    // Quota
    const quotaHeader = document.createElement('div');
    quotaHeader.classList.add('claude-max-quota-header');
    const quotaTitle = document.createElement('b');
    quotaTitle.textContent = 'Subscription quota';
    const quotaRefresh = document.createElement('div');
    quotaRefresh.classList.add('menu_button', 'fa-solid', 'fa-rotate', 'claude-max-quota-refresh');
    quotaRefresh.title = 'Refresh quota';
    quotaRefresh.addEventListener('click', refreshQuota);
    quotaHeader.append(quotaTitle, quotaRefresh);
    const quotaBox = document.createElement('div');
    quotaBox.id = 'claude_max_quota';
    quotaBox.textContent = 'Press refresh to load.';
    content.append(quotaHeader, quotaBox);

    const hint = document.createElement('small');
    hint.classList.add('claude-max-hint');
    hint.textContent = 'Set SillyTavern\'s native "Reasoning Effort" dropdown to Auto — this panel replaces it for Claude ' +
        '(the native one downgrades Maximum to "high" and is dropped for Claude models anyway). ' +
        'Temperature/Top-P are not supported on the subscription path (Agent SDK limitation).';
    content.append(hint);
}

// ──────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────

(function () {
    const settings = getSettings();
    addExtensionSettings(settings);
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
    console.log('[claude-max] UI extension loaded');
})();
