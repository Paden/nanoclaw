# Sheets MCP + Auth Re-home (Shape A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Sheets MCP server for the agent and re-home `sheets.mjs` auth from gcloud ADC onto the calendar-mcp OAuth client (expanded to include the Sheets scope). Eliminates the gcloud ADC dependency so `gcloud auth application-default login` stops clobbering work credentials.

**Architecture:**
- Reuse the existing calendar-mcp OAuth client (one GCP app) by expanding its consent screen to include `https://www.googleapis.com/auth/spreadsheets`. Single refresh token gets both scopes.
- Add a custom `sheets-mcp-stdio.ts` alongside `ollama-mcp-stdio.ts` that wraps `sheets.mjs` operations as MCP tools.
- Rewrite `sheets.mjs` to read client creds from `gcp-oauth.keys.json` and the refresh token from `tokens.json` (calendar-mcp's format).
- Remove the gcloud ADC mount from `container-runner.ts` and `task-scheduler.ts` entirely. Remove the `NANOCLAW_GCLOUD_ADC` env var added earlier in this session (now dead code).

**Tech Stack:** TypeScript, Node.js, `@modelcontextprotocol/sdk`, vitest.

---

## File Map

**New:**
- `container/agent-runner/src/sheets-mcp-stdio.ts` — custom MCP server exposing `readRange`/`appendRows`/`updateRange` as tools

**Modified:**
- `groups/global/scripts/lib/sheets.mjs` — auth path switches from single ADC file to `gcp-oauth.keys.json` + `tokens.json` pair
- `groups/global/scripts/lib/sheets.test.mjs` — test fixtures updated to match new auth shape
- `container/agent-runner/src/index.ts` — register `google-sheets` MCP server + allowlist
- `src/container-runner.ts` — remove gcloud ADC mount; add sheets MCP env vars (path reuses calendar creds/tokens)
- `src/task-scheduler.ts` — remove gcloud ADC path + `GOOGLE_APPLICATION_CREDENTIALS` env; gate scripts use calendar-mcp creds via new env vars
- `~/Library/LaunchAgents/com.nanoclaw.plist` — remove `NANOCLAW_GCLOUD_ADC` entry

**Unchanged (preserves domain logic):**
- `groups/global/scripts/lib/wordle.mjs`
- `groups/discord_family-fun/scripts/*.mjs` (resolve-day, compute-tiers, score-guess)

---

## Task 1: Expand OAuth consent + re-auth (USER, interactive)

**This is manual — the user does it. No code changes.**

- [ ] **Step 1: Add spreadsheets scope to OAuth consent screen**

  In GCP Console → APIs & Services → OAuth consent screen for the project whose OAuth client is at `data/google-calendar/gcp-oauth.keys.json`:
  1. Edit app → Scopes → Add `https://www.googleapis.com/auth/spreadsheets`
  2. Ensure "Test users" still includes the user's Google account
  3. Save

- [ ] **Step 2: Enable Sheets API**

  Same project → APIs & Services → Library → search "Google Sheets API" → Enable (if not already).

- [ ] **Step 3: Delete old tokens and re-auth**

  ```bash
  rm ~/.config/google-calendar-mcp/tokens.json
  ```

  Then trigger the calendar MCP's auth flow (it mints tokens when first invoked with no `tokens.json`). Simplest way: send a calendar-using message to the agent and let MCP prompt the browser consent. Approve both calendar AND sheets permissions at the consent screen.

- [ ] **Step 4: Verify tokens have both scopes**

  ```bash
  cat ~/.config/google-calendar-mcp/tokens.json | jq .normal.scope
  ```

  Expected output contains both `calendar` and `spreadsheets`.

---

## Task 2: Refactor sheets.mjs auth (TDD)

**Files:**
- Modify: `groups/global/scripts/lib/sheets.mjs`
- Modify: `groups/global/scripts/lib/sheets.test.mjs`

- [ ] **Step 1: Update tests to new auth shape (write failing tests)**

  Replace the ADC fixture with paired oauth-keys + tokens fixtures. Replace the existing `getAccessToken` tests with:

  ```js
  // Replace `fakeAdc` and `setUp` in sheets.test.mjs:
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
  ```

  Update `getAccessToken` tests to pass the new paths:

  ```js
  it('mints a token from oauth keys + tokens', async () => {
    const { fn, calls } = mockFetch({ access_token: 'fresh-token' }, {});
    const token = await getAccessToken({ fetchFn: fn, oauthKeysPath, tokensPath });
    expect(token).toBe('fresh-token');
    expect(calls[0].body.toString()).toContain('test-client');
    expect(calls[0].body.toString()).toContain('test-refresh');
  });

  it('throws on failed token mint', async () => {
    const { fn } = mockFetch({ error: 'invalid_grant' }, {});
    await expect(
      getAccessToken({ fetchFn: fn, oauthKeysPath, tokensPath })
    ).rejects.toThrow('Token mint failed');
  });
  ```

  Update the three `auto-mints token when none provided` tests to set both env vars:

  ```js
  process.env.GOOGLE_OAUTH_CREDENTIALS = oauthKeysPath;
  process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH = tokensPath;
  try {
    // ... existing test body ...
  } finally {
    delete process.env.GOOGLE_OAUTH_CREDENTIALS;
    delete process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH;
  }
  ```

- [ ] **Step 2: Run tests — expect them to fail**

  ```bash
  npx vitest run groups/global/scripts/lib/sheets.test.mjs
  ```

  Expected: Failures in `getAccessToken` tests (new signature not yet implemented).

- [ ] **Step 3: Rewrite sheets.mjs auth path**

  Replace `defaultAdcPath` and `getAccessToken` in `groups/global/scripts/lib/sheets.mjs`:

  ```js
  const defaultOauthKeysPath = () =>
    process.env.GOOGLE_OAUTH_CREDENTIALS
    || '/home/node/.config/google-calendar-mcp/gcp-oauth.keys.json';

  const defaultTokensPath = () =>
    process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH
    || '/home/node/.config/google-calendar-mcp/tokens.json';

  export async function getAccessToken({
    fetchFn = fetch,
    oauthKeysPath = defaultOauthKeysPath(),
    tokensPath = defaultTokensPath(),
  } = {}) {
    const keys = JSON.parse(fs.readFileSync(oauthKeysPath, 'utf8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    const installed = keys.installed || keys.web || keys;
    const refresh = tokens.normal?.refresh_token || tokens.refresh_token;
    if (!refresh) throw new Error(`No refresh token in ${tokensPath}`);
    const resp = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: installed.client_id,
        client_secret: installed.client_secret,
        refresh_token: refresh,
        grant_type: 'refresh_token',
      }),
    });
    const data = await resp.json();
    if (!data.access_token) throw new Error(`Token mint failed: ${JSON.stringify(data)}`);
    return data.access_token;
  }
  ```

  Leave `readRange`, `appendRows`, `updateRange` unchanged — they only consume tokens.

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  npx vitest run groups/global/scripts/lib/sheets.test.mjs
  ```

  Expected: all green.

- [ ] **Step 5: Run full test suite (regression check)**

  ```bash
  npm test
  ```

  Expected: all green. Pay attention to any test that imports `sheets.mjs` (wordle.test, compute-tiers.test if present).

- [ ] **Step 6: Commit**

  ```bash
  git add groups/global/scripts/lib/sheets.mjs groups/global/scripts/lib/sheets.test.mjs
  git commit -m "refactor(sheets): re-home auth from gcloud ADC to calendar-mcp OAuth"
  ```

---

## Task 3: Remove gcloud ADC from container-runner

**Files:**
- Modify: `src/container-runner.ts:334-346`

- [ ] **Step 1: Delete the gcloud ADC mount block**

  Remove this entire block from `src/container-runner.ts` (around lines 334-346):

  ```ts
  // Google Sheets — mount gcloud ADC so the sheets.mjs utility library can
  // mint access tokens inside the container (no MCP server needed).
  // Host path is overridable via NANOCLAW_GCLOUD_ADC so nanoclaw can use a
  // dedicated ADC file (with its own scopes) without clobbering the user's
  // default gcloud ADC.
  const gcloudAdcPath =
    process.env.NANOCLAW_GCLOUD_ADC ||
    path.join(
      process.env.HOME || os.homedir(),
      '.config',
      'gcloud',
      'application_default_credentials.json',
    );
  if (fs.existsSync(gcloudAdcPath)) {
    const containerAdcPath =
      '/home/node/.config/gcloud/application_default_credentials.json';
    args.push(...readonlyMountArgs(gcloudAdcPath, containerAdcPath));
  }
  ```

  Calendar MCP's mount block directly below stays. `sheets.mjs` now reads from the same calendar MCP paths already mounted.

- [ ] **Step 2: Verify build**

  ```bash
  npm run build
  ```

  Expected: clean compile.

- [ ] **Step 3: Commit**

  ```bash
  git add src/container-runner.ts
  git commit -m "refactor(container): drop gcloud ADC mount; sheets uses calendar-mcp OAuth"
  ```

---

## Task 4: Remove gcloud ADC from task-scheduler

**Files:**
- Modify: `src/task-scheduler.ts:89-155`

- [ ] **Step 1: Remove hostAdcPath and ADC rewrites**

  In `runGateScript`:

  Delete the `hostAdcPath` block (around lines 95-103):

  ```ts
  // Host path is overridable via NANOCLAW_GCLOUD_ADC so nanoclaw can use a
  // dedicated ADC file without clobbering the user's default gcloud ADC.
  const hostAdcPath =
    process.env.NANOCLAW_GCLOUD_ADC ||
    path.join(
      process.env.HOME || os.homedir(),
      '.config',
      'gcloud',
      'application_default_credentials.json',
    );
  ```

  Delete the two ADC-specific `.replaceAll` calls (around lines 123-127):

  ```ts
  .replaceAll(
    '/home/node/.config/gcloud/application_default_credentials.json',
    hostAdcPath,
  )
  .replaceAll('/home/node/.config/gcloud', path.dirname(hostAdcPath))
  ```

  Remove the `GOOGLE_APPLICATION_CREDENTIALS` env assignment (around line 151):

  ```ts
  GOOGLE_APPLICATION_CREDENTIALS: hostAdcPath,
  ```

- [ ] **Step 2: Add calendar-mcp env vars to gate script env**

  Gate scripts that use `sheets.mjs` on the host need the same env vars the container sets. Add to the `env:` block inside `runGateScript`:

  ```ts
  env: {
    ...process.env,
    TZ: TIMEZONE,
    GOOGLE_OAUTH_CREDENTIALS: gcalCredsPath,
    GOOGLE_CALENDAR_MCP_TOKEN_PATH: gcalTokenPath,
  },
  ```

  (`gcalCredsPath` and `gcalTokenPath` are already defined in `runGateScript` just above — no change needed there.)

- [ ] **Step 3: Build and run full tests**

  ```bash
  npm run build && npm test
  ```

  Expected: clean compile, all tests pass.

- [ ] **Step 4: Commit**

  ```bash
  git add src/task-scheduler.ts
  git commit -m "refactor(scheduler): drop gcloud ADC; gate scripts use calendar-mcp OAuth env"
  ```

---

## Task 5: Create sheets MCP stdio server

**Files:**
- Create: `container/agent-runner/src/sheets-mcp-stdio.ts`

- [ ] **Step 1: Write the MCP server**

  Create `container/agent-runner/src/sheets-mcp-stdio.ts`:

  ```ts
  /**
   * Sheets MCP Server for NanoClaw
   * Wraps sheets.mjs so the agent can read/append/update Google Sheets
   * without inline `node -e "import { readRange } ..."` shell-outs.
   * Reuses calendar-mcp's OAuth client (scopes include both calendar + sheets).
   */

  import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
  import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
  import { z } from 'zod';

  // Import the utility library that already knows how to mint tokens from
  // calendar-mcp's OAuth creds (GOOGLE_OAUTH_CREDENTIALS + GOOGLE_CALENDAR_MCP_TOKEN_PATH).
  // @ts-expect-error — untyped .mjs, worskpace mount maps this path
  import { readRange, appendRows, updateRange } from '/workspace/global/scripts/lib/sheets.mjs';

  function log(msg: string): void {
    console.error(`[SHEETS] ${msg}`);
  }

  const server = new McpServer({ name: 'google-sheets', version: '1.0.0' });

  server.tool(
    'read_range',
    'Read a range from a Google Sheet. Returns rows as a 2D array. Example range: "Sheet1!A2:D100".',
    {
      sheet_id: z.string().describe('The spreadsheet ID from the URL'),
      range: z.string().describe('A1 notation range, e.g. "Tab!A:Z"'),
    },
    async ({ sheet_id, range }) => {
      log(`read_range ${sheet_id} ${range}`);
      try {
        const rows = await readRange(sheet_id, range);
        return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'append_rows',
    'Append rows to a Google Sheet. Values is a 2D array of rows. Range should be like "Sheet1!A:D".',
    {
      sheet_id: z.string(),
      range: z.string(),
      values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))),
    },
    async ({ sheet_id, range, values }) => {
      log(`append_rows ${sheet_id} ${range} (${values.length} rows)`);
      try {
        const res = await appendRows(sheet_id, range, values);
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    'update_range',
    'Overwrite a range in a Google Sheet with the given values (2D array).',
    {
      sheet_id: z.string(),
      range: z.string(),
      values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))),
    },
    async ({ sheet_id, range, values }) => {
      log(`update_range ${sheet_id} ${range}`);
      try {
        const res = await updateRange(sheet_id, range, values);
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Sheets MCP server ready');
  ```

- [ ] **Step 2: Verify TypeScript build**

  ```bash
  cd container/agent-runner && npm run build 2>&1 | tail -20
  ```

  Expected: clean compile. The `.mjs` import may need a `// @ts-expect-error` or path tweak — adjust if tsc complains.

- [ ] **Step 3: Commit**

  ```bash
  git add container/agent-runner/src/sheets-mcp-stdio.ts
  git commit -m "feat(mcp): add sheets MCP server wrapping sheets.mjs"
  ```

---

## Task 6: Register sheets MCP in agent-runner

**Files:**
- Modify: `container/agent-runner/src/index.ts:521-545` (allowedTools), `:567-580` (mcpServers)

- [ ] **Step 1: Add to allowedTools**

  In the `allowedTools` array, after `'mcp__google-calendar__*',`:

  ```ts
  'mcp__google-sheets__*',
  ```

- [ ] **Step 2: Register the server**

  In the `mcpServers` object, after the `google-calendar` block:

  ```ts
  ...(process.env.GOOGLE_OAUTH_CREDENTIALS
    ? {
        'google-sheets': {
          command: 'node',
          args: [path.join(path.dirname(mcpServerPath), 'sheets-mcp-stdio.js')],
        },
      }
    : {}),
  ```

  Shares the `GOOGLE_OAUTH_CREDENTIALS` env presence check with google-calendar (same OAuth client). No extra env needed — the MCP imports `sheets.mjs` which reads env vars directly.

- [ ] **Step 3: Build container agent-runner**

  ```bash
  cd container/agent-runner && npm run build
  ```

  Expected: clean.

- [ ] **Step 4: Commit**

  ```bash
  git add container/agent-runner/src/index.ts
  git commit -m "feat(agent): register google-sheets MCP server"
  ```

---

## Task 7: Rebuild container image

**No file changes — rebuild step only.**

- [ ] **Step 1: Rebuild container**

  ```bash
  ./container/build.sh
  ```

  Expected: success. If COPY steps appear cached despite source changes, prune the builder per CLAUDE.md:

  ```bash
  docker buildx prune --builder nanoclaw-builder -f
  ./container/build.sh
  ```

- [ ] **Step 2: Purge agent sessions (required after MCP tool changes)**

  ```bash
  ./scripts/cleanup-sessions.sh --purge-db
  ```

---

## Task 8: Remove NANOCLAW_GCLOUD_ADC from plist

**Files:**
- Modify: `~/Library/LaunchAgents/com.nanoclaw.plist`

- [ ] **Step 1: Remove the env entry**

  Delete these two lines from the `EnvironmentVariables` dict:

  ```xml
  <key>NANOCLAW_GCLOUD_ADC</key>
  <string>/Users/paden.portillobrinqa.com/.config/gcloud/nanoclaw-adc.json</string>
  ```

- [ ] **Step 2: Reload service**

  ```bash
  launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
  ```

---

## Task 9: End-to-end verification

**No code changes — runtime verification only.**

- [ ] **Step 1: Send a test message to the agent that requires Sheets read**

  Via your normal channel (Discord), ask Claudio to read a cell from Portillo Games or Silverthorne.

- [ ] **Step 2: Verify it uses the new MCP tool**

  ```bash
  tail -n 100 groups/<group>/logs/tool-calls.jsonl | grep -i sheets
  ```

  Expected: entries with `"tool":"mcp__google-sheets__read_range"` (not inline `node -e "import { readRange } ..."`).

- [ ] **Step 3: Verify scheduled script still works**

  Run `node /workspace/group/scripts/compute-tiers.mjs` via the agent or trigger resolve-day. Expected: succeeds without gcloud ADC.

- [ ] **Step 4: Verify work gcloud ADC untouched**

  ```bash
  stat ~/.config/gcloud/application_default_credentials.json
  ```

  Should show an mtime from before this refactor started (not rewritten).

---

## Task 10: Remove unused nanoclaw-adc.json file (if created)

- [ ] **Step 1: Clean up the experimental ADC file**

  ```bash
  rm -f ~/.config/gcloud/nanoclaw-adc.json
  ```

---

## Task 11: Final commit + push

- [ ] **Step 1: Run full test suite**

  ```bash
  npm test
  ```

- [ ] **Step 2: Create PR (per CONTRIBUTING.md)**

  Branch name: `refactor/sheets-mcp-auth-rehome`.

  Title: `refactor: add sheets MCP + drop gcloud ADC dependency`

---

## Self-Review Notes

- **Spec coverage:** All four goals covered — MCP for agent (Task 5-6), sheets.mjs re-homed (Task 2), gcloud ADC removed from container-runner (Task 3), task-scheduler (Task 4), and plist (Task 8).
- **Domain logic preserved:** `wordle.mjs`, `resolve-day.mjs`, `compute-tiers.mjs`, `score-guess.mjs` unchanged.
- **Type consistency:** `getAccessToken` signature changes consistently — old `{adcPath}` → new `{oauthKeysPath, tokensPath}`. Callers in `sheets.mjs` itself need no change since they call `getAccessToken()` with no args.
- **Risk spots:**
  - Task 1 OAuth re-auth is interactive — if the google-calendar-mcp auth flow can't surface the new Sheets scope consent, fallback is a separate sheets OAuth client (Shape A-alt: two clients, two token files). Detect if Task 1 Step 4 shows only `calendar` scope — escalate before continuing.
  - `.mjs` import from `.ts` in `sheets-mcp-stdio.ts` may need tsconfig tweaks (`allowJs`, `moduleResolution`). If so, surface in Task 5 Step 2.
