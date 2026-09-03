// ──────────────────────────────────────────────
// OAuth credential refresh + quota polling + error classification
// ──────────────────────────────────────────────
//
// The Claude Code CLI attempts its own silent token refresh, but when a login
// elsewhere rotates the refresh token or the access token expires mid-idle,
// queries start failing with auth errors. Meridian's fix — replicated here —
// is an out-of-band refresh against the platform token endpoint followed by
// ONE retry of the query. Same client_id the CLI itself uses.
//
// Quota: Anthropic exposes GET https://api.anthropic.com/api/oauth/usage for
// OAuth (subscription) tokens — continuous utilization percentages for the
// 5-hour/7-day windows plus Extra Usage credit state. Surfaced at
// /v1/usage/quota so the UI extension can show "5h window: 62%, resets 18:40"
// and prevent mid-scene lockouts.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PLUGIN_TAG = '[claude-subscription]';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_BETA_HEADER = 'oauth-2025-04-20';
const USAGE_CACHE_TTL_MS = 30000;

export function credentialsPath() {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(configDir, '.credentials.json');
}

export function readCredentials() {
    try {
        const raw = readFileSync(credentialsPath(), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// ── Error classifiers (regex sets validated by Meridian in production) ──

export function isExpiredTokenError(text) {
    const s = String(text ?? '').toLowerCase();
    return (
        s.includes('oauth token has expired') ||
        s.includes('token_expired') ||
        s.includes('invalid_token') ||
        s.includes('not logged in') ||
        s.includes('authentication expired') ||
        s.includes('authentication_failed') ||
        (s.includes('401') && (s.includes('authentication') || s.includes('unauthorized') || s.includes('invalid')))
    );
}

export function isRateLimitError(text) {
    const s = String(text ?? '').toLowerCase();
    return s.includes('429') || s.includes('rate limit') || s.includes('too many requests');
}

export function isExtraUsageRequiredError(text) {
    const s = String(text ?? '').toLowerCase();
    return (s.includes('extra usage') && s.includes('1m')) || s.includes('out of extra usage');
}

export function isStaleSessionError(text) {
    const s = String(text ?? '').toLowerCase();
    return s.includes('no conversation found');
}

// ── Out-of-band token refresh (in-flight dedup) ──

let inflightRefresh = null;

export function refreshOAuthToken() {
    if (inflightRefresh) return inflightRefresh;
    inflightRefresh = doRefresh().finally(() => { inflightRefresh = null; });
    return inflightRefresh;
}

async function doRefresh() {
    const path = credentialsPath();
    const creds = readCredentials();
    const refreshToken = creds?.claudeAiOauth?.refreshToken;
    if (!refreshToken) {
        console.warn(`${PLUGIN_TAG} token refresh skipped: no refresh token at ${path}`);
        return false;
    }
    try {
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                client_id: OAUTH_CLIENT_ID,
                refresh_token: refreshToken,
            }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            console.warn(`${PLUGIN_TAG} token refresh failed: HTTP ${res.status}. Run \`claude login\` on this host.`);
            return false;
        }
        const data = await res.json();
        const now = Date.now();
        // The Claude CLI manages the same file and refresh tokens ROTATE —
        // re-read before writing: if another process already rotated the
        // token, its copy is authoritative and clobbering it would break
        // auth everywhere. Write atomically (temp + rename) so a concurrent
        // reader never sees a half-written file.
        const latest = readCredentials() ?? creds;
        const onDiskToken = latest?.claudeAiOauth?.refreshToken;
        if (onDiskToken && onDiskToken !== refreshToken) {
            console.log(`${PLUGIN_TAG} credentials rotated by another process — keeping the on-disk copy`);
            return true;
        }
        latest.claudeAiOauth = {
            ...latest.claudeAiOauth,
            accessToken: data.access_token ?? latest.claudeAiOauth?.accessToken,
            refreshToken: data.refresh_token ?? refreshToken,
            expiresAt: data.expires_at ?? (data.expires_in ? now + data.expires_in * 1000 : now + 8 * 3600 * 1000),
        };
        const tmpPath = `${path}.${process.pid}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(latest, null, 2));
        renameSync(tmpPath, path);
        console.log(`${PLUGIN_TAG} OAuth token refreshed`);
        return true;
    } catch (err) {
        console.warn(`${PLUGIN_TAG} token refresh error:`, err instanceof Error ? err.message : err);
        return false;
    }
}

// ── Quota polling ──

const WINDOW_TYPES = [
    'five_hour',
    'seven_day',
    'seven_day_opus',
    'seven_day_sonnet',
    'seven_day_fable',
    'seven_day_oauth_apps',
];

let quotaCache = null;

export async function fetchQuota({ force = false } = {}) {
    if (!force && quotaCache && Date.now() - quotaCache.fetchedAt < USAGE_CACHE_TTL_MS) {
        return quotaCache;
    }

    const token = readCredentials()?.claudeAiOauth?.accessToken;
    if (!token) return null;

    let res;
    try {
        res = await fetch(USAGE_URL, {
            headers: {
                Authorization: `Bearer ${token}`,
                'anthropic-beta': USAGE_BETA_HEADER,
                Accept: 'application/json',
            },
            signal: AbortSignal.timeout(10000),
        });
    } catch (err) {
        console.warn(`${PLUGIN_TAG} quota fetch failed:`, err instanceof Error ? err.message : err);
        return null;
    }

    if (res.status === 401) {
        const refreshed = await refreshOAuthToken();
        if (!refreshed) return null;
        return fetchQuota({ force: true });
    }
    if (!res.ok) {
        console.warn(`${PLUGIN_TAG} quota endpoint returned HTTP ${res.status} (429 = transient rate limit; retry later)`);
        return null;
    }

    let raw;
    try {
        raw = await res.json();
    } catch {
        return null;
    }

    const windows = [];
    for (const key of WINDOW_TYPES) {
        const w = raw[key];
        if (!w) continue;
        const utilization = typeof w.utilization === 'number' && Number.isFinite(w.utilization)
            ? Math.max(0, w.utilization / 100)
            : null;
        const resetsAt = w.resets_at ? Date.parse(w.resets_at) || null : null;
        if (utilization === null && resetsAt === null) continue;
        windows.push({ type: key, utilization, resetsAt });
    }

    const extra = raw.extra_usage;
    const extraUsage = extra
        ? {
            isEnabled: !!extra.is_enabled,
            monthlyLimit: extra.monthly_limit ?? 0,
            usedCredits: extra.used_credits ?? 0,
            currency: extra.currency ?? 'USD',
        }
        : null;

    quotaCache = { windows, extraUsage, fetchedAt: Date.now() };
    return quotaCache;
}

export async function handleQuota(_req, res) {
    const snapshot = await fetchQuota();
    if (!snapshot) {
        return res.status(503).json({ ok: false, message: 'Quota unavailable (no OAuth credentials or upstream error).' });
    }
    return res.json({ ok: true, ...snapshot });
}

/** Lightweight credential summary for /status. No secrets, and no absolute
 *  path — /status is an unauthenticated GET and the credentials path leaks
 *  the OS username. */
export function credentialSummary() {
    const path = credentialsPath();
    const source = process.env.CLAUDE_CONFIG_DIR ? 'CLAUDE_CONFIG_DIR' : 'home';
    if (!existsSync(path)) return { present: false, source };
    const creds = readCredentials();
    const oauth = creds?.claudeAiOauth;
    if (!oauth) return { present: false, source };
    const expiresAt = Number(oauth.expiresAt) || 0;
    return {
        present: true,
        source,
        subscriptionType: oauth.subscriptionType ?? 'unknown',
        expiresAt,
        expired: expiresAt > 0 && expiresAt < Date.now(),
        hasRefreshToken: !!oauth.refreshToken,
    };
}
