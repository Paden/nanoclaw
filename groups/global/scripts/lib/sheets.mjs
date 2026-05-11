// Minimal Google Sheets v4 client for in-container scripts.
//
// Token is minted from calendar-mcp OAuth credentials at runtime. All
// functions accept an optional `token` parameter so tests can inject a fake;
// the lower-level `request` helper accepts an optional `fetchFn` for the
// same reason.
//
// Used by group scripts (compute-tiers, score-guess, etc) to keep
// auth + URL construction out of the per-script code.

import fs from 'fs';

const defaultOauthKeysPath = () =>
  process.env.GOOGLE_OAUTH_CREDENTIALS ||
  '/home/node/.config/google-calendar-mcp/gcp-oauth.keys.json';

const defaultTokensPath = () =>
  process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
  '/home/node/.config/google-calendar-mcp/tokens.json';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function getAccessToken({
  fetchFn = fetch,
  oauthKeysPath = defaultOauthKeysPath(),
  tokensPath = defaultTokensPath(),
} = {}) {
  const keysRaw = JSON.parse(fs.readFileSync(oauthKeysPath, 'utf8'));
  // Support both "installed" and "web" OAuth client shapes
  const keys = keysRaw.installed || keysRaw.web;
  const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
  const body = new URLSearchParams({
    client_id: keys.client_id,
    client_secret: keys.client_secret,
    refresh_token: tokens.normal.refresh_token,
    grant_type: 'refresh_token',
  });

  // Retry on transient network failures. Host-side slash commands run on a
  // residential network where Wifi/DNS blips cause ETIMEDOUT/ECONNRESET on
  // the OAuth endpoint, killing the whole command with a stack trace.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetchFn('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      if (!data.access_token) throw new Error(`Token mint failed: ${JSON.stringify(data)}`);
      return data.access_token;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function request(method, url, body, token, fetchFn) {
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const resp = await fetchFn(url, init);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Sheets ${method} ${url}: ${resp.status} ${text}`);
  }
  return resp.json();
}

export async function readRange(sheetId, range, { token, fetchFn = fetch } = {}) {
  if (!token) token = await getAccessToken({ fetchFn });
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}`;
  const data = await request('GET', url, undefined, token, fetchFn);
  return data.values || [];
}

/**
 * Normalize any string value that looks like an unpadded `YYYY-MM-DD H:M[:S]`
 * timestamp into the canonical `YYYY-MM-DD HH:MM:SS` form. Other strings
 * (and non-strings) pass through untouched.
 *
 * Sheets API USER_ENTERED parses datetimes and re-renders them using the
 * cell's display format, which silently strips leading zeros on hours for
 * some Emilio-tracking columns. Pre-padding the input string forces the
 * canonical form regardless of cell format.
 */
export function normalizeTimestamp(v) {
  if (typeof v !== 'string') return v;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return v;
  const [, y, mo, d, h, mi, se] = m;
  const pad = (n) => String(parseInt(n, 10)).padStart(2, '0');
  return `${y}-${mo}-${d} ${pad(h)}:${pad(mi)}:${pad(se || '0')}`;
}

function normalizeValues(values) {
  if (!Array.isArray(values)) return values;
  return values.map((row) => Array.isArray(row) ? row.map(normalizeTimestamp) : row);
}

export async function appendRows(sheetId, range, values, { token, fetchFn = fetch } = {}) {
  if (!token) token = await getAccessToken({ fetchFn });
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  return request('POST', url, { values: normalizeValues(values) }, token, fetchFn);
}

export async function updateRange(sheetId, range, values, { token, fetchFn = fetch } = {}) {
  if (!token) token = await getAccessToken({ fetchFn });
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  return request('PUT', url, { values: normalizeValues(values) }, token, fetchFn);
}
