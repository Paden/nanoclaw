import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAccessToken, readRange, appendRows, updateRange } from './sheets.mjs';

// Fake OAuth keys + tokens files (calendar-mcp format)
const fakeOauthKeys = {
  installed: {
    client_id: 'test-client',
    client_secret: 'test-secret',
  },
};
const fakeTokens = {
  normal: {
    refresh_token: 'test-refresh',
    access_token: 'stale',
    scope: 'https://www.googleapis.com/auth/spreadsheets',
  },
};
let oauthKeysPath, tokensPath;

function setUp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sheets-test-'));
  oauthKeysPath = path.join(tmp, 'gcp-oauth.keys.json');
  tokensPath = path.join(tmp, 'tokens.json');
  fs.writeFileSync(oauthKeysPath, JSON.stringify(fakeOauthKeys));
  fs.writeFileSync(tokensPath, JSON.stringify(fakeTokens));
  return tmp;
}

function tearDown(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Build a mock fetchFn that returns canned responses
function mockFetch(tokenResp, apiResp) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init?.method || 'GET', headers: init?.headers, body: init?.body });
    if (url.includes('oauth2.googleapis.com')) {
      return { ok: true, json: async () => tokenResp };
    }
    return {
      ok: apiResp.ok ?? true,
      status: apiResp.status ?? 200,
      json: async () => apiResp.body,
      text: async () => JSON.stringify(apiResp.body),
    };
  };
  return { fn, calls };
}

describe('getAccessToken', () => {
  let tmp;
  beforeEach(() => { tmp = setUp(); });
  afterEach(() => tearDown(tmp));

  it('mints a token from oauth-keys + tokens', async () => {
    const { fn, calls } = mockFetch({ access_token: 'fresh-token' }, {});
    const token = await getAccessToken({ fetchFn: fn, oauthKeysPath, tokensPath });
    expect(token).toBe('fresh-token');
    expect(calls[0].url).toContain('oauth2.googleapis.com/token');
    expect(calls[0].body.toString()).toContain('test-client');
    expect(calls[0].body.toString()).toContain('test-refresh');
  });

  it('throws Token mint failed when token endpoint returns error', async () => {
    const { fn } = mockFetch({ error: 'invalid_grant' }, {});
    await expect(getAccessToken({ fetchFn: fn, oauthKeysPath, tokensPath })).rejects.toThrow('Token mint failed');
  });
});

describe('readRange', () => {
  let tmp;
  beforeEach(() => { tmp = setUp(); });
  afterEach(() => tearDown(tmp));

  it('auto-mints token when none provided', async () => {
    const { fn, calls } = mockFetch(
      { access_token: 'auto-token' },
      { body: { values: [['a', 'b']] } },
    );
    process.env.GOOGLE_OAUTH_CREDENTIALS = oauthKeysPath;
    process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH = tokensPath;
    try {
      const rows = await readRange('sheet123', 'Tab!A:Z', { fetchFn: fn });
      expect(rows).toEqual([['a', 'b']]);
      // First call should be token mint, second the API call
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toContain('oauth2.googleapis.com');
      expect(calls[1].headers.Authorization).toBe('Bearer auto-token');
    } finally {
      delete process.env.GOOGLE_OAUTH_CREDENTIALS;
      delete process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH;
    }
  });

  it('uses provided token without minting', async () => {
    const { fn, calls } = mockFetch(
      {},
      { body: { values: [['x']] } },
    );
    const rows = await readRange('sheet123', 'Tab!A:Z', { token: 'pre-minted', fetchFn: fn });
    expect(rows).toEqual([['x']]);
    // Should only make the API call, no token mint
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('Bearer pre-minted');
  });

  it('returns empty array when no values', async () => {
    const { fn } = mockFetch({}, { body: {} });
    const rows = await readRange('s', 'r', { token: 'tok', fetchFn: fn });
    expect(rows).toEqual([]);
  });
});

describe('appendRows', () => {
  let tmp;
  beforeEach(() => { tmp = setUp(); });
  afterEach(() => tearDown(tmp));

  it('auto-mints token when none provided', async () => {
    const { fn, calls } = mockFetch(
      { access_token: 'append-token' },
      { body: { updatedRows: 1 } },
    );
    process.env.GOOGLE_OAUTH_CREDENTIALS = oauthKeysPath;
    process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH = tokensPath;
    try {
      await appendRows('sheet123', 'Tab!A:Z', [['val']], { fetchFn: fn });
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toContain('oauth2.googleapis.com');
      expect(calls[1].headers.Authorization).toBe('Bearer append-token');
      expect(calls[1].method).toBe('POST');
      expect(calls[1].url).toContain(':append');
    } finally {
      delete process.env.GOOGLE_OAUTH_CREDENTIALS;
      delete process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH;
    }
  });

  it('uses provided token without minting', async () => {
    const { fn, calls } = mockFetch({}, { body: { updatedRows: 1 } });
    await appendRows('sheet123', 'Tab!A:Z', [['val']], { token: 'given', fetchFn: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('Bearer given');
  });
});

describe('updateRange', () => {
  let tmp;
  beforeEach(() => { tmp = setUp(); });
  afterEach(() => tearDown(tmp));

  it('auto-mints token when none provided', async () => {
    const { fn, calls } = mockFetch(
      { access_token: 'update-token' },
      { body: { updatedCells: 1 } },
    );
    process.env.GOOGLE_OAUTH_CREDENTIALS = oauthKeysPath;
    process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH = tokensPath;
    try {
      await updateRange('sheet123', 'Tab!A1', [['val']], { fetchFn: fn });
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toContain('oauth2.googleapis.com');
      expect(calls[1].headers.Authorization).toBe('Bearer update-token');
      expect(calls[1].method).toBe('PUT');
    } finally {
      delete process.env.GOOGLE_OAUTH_CREDENTIALS;
      delete process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH;
    }
  });

  it('throws on API error', async () => {
    const { fn } = mockFetch({}, { ok: false, status: 403, body: { error: 'forbidden' } });
    await expect(
      updateRange('s', 'r', [['v']], { token: 'tok', fetchFn: fn }),
    ).rejects.toThrow('403');
  });
});
