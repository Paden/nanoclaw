# Ubuntu Migration Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/migrate.ts` — a one-time interactive terminal wizard that migrates NanoClaw from macOS to a Ubuntu home server over SSH, including repo, secrets, runtime state, OneCLI setup, systemd service, and dev CLI configuration.

**Architecture:** Single TypeScript file with three layers — `@clack/prompts` for interactive UI, thin `spawnSync` wrappers for `ssh`/`rsync`/`scp`, and a sequential step runner with retry/skip/abort. Pure helper functions (SSH arg building, systemd template filling, bashrc guard) are exported for unit testing. Run with `npx tsx scripts/migrate.ts`.

**Tech Stack:** TypeScript, `@clack/prompts`, Node.js `child_process.spawnSync`, system `ssh`/`rsync`/`scp`, `vitest` for unit tests.

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `scripts/migrate.ts` | **Create** | The entire wizard — types, primitives, steps, main |
| `scripts/migrate.test.ts` | **Create** | Unit tests for exported pure functions |
| `package.json` | **Modify** | Add `@clack/prompts` to `devDependencies` |
| `vitest.config.ts` | **Modify** | Add `scripts/**/*.test.ts` to test include list |

**Key exported symbols from `scripts/migrate.ts`** (the rest is private to main):
- `SshCreds` — interface
- `MigrateError` — class
- `buildSshArgs(creds: SshCreds): string[]` — pure, testable
- `buildSystemdUnit(nodePath: string, projectRoot: string): string` — pure, testable
- `buildBashrcBlock(baseUrl: string, apiKey: string, model: string): string` — pure, testable
- `needsBashrcUpdate(content: string): boolean` — pure, testable

---

## Task 1: Add dependency, update vitest config, create skeleton

**Files:**
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Create: `scripts/migrate.ts`

- [ ] **Step 1: Install `@clack/prompts`**

```bash
npm install --save-dev @clack/prompts
```

Expected: package appears in `devDependencies` in `package.json`.

- [ ] **Step 2: Add `scripts/**/*.test.ts` to vitest config**

Edit `vitest.config.ts`. The `include` array currently has three entries. Add a fourth:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'groups/**/*.test.mjs',
      'scripts/**/*.test.ts',
    ],
  },
});
```

- [ ] **Step 3: Write the skeleton file**

Create `scripts/migrate.ts` with just enough to verify it runs:

```typescript
#!/usr/bin/env node
import { intro, outro } from '@clack/prompts';

async function main() {
  intro('NanoClaw → Ubuntu Migration Wizard');
  outro('Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Verify skeleton runs**

```bash
npx tsx scripts/migrate.ts
```

Expected output: `NanoClaw → Ubuntu Migration Wizard` intro header, then `Done!` outro. No errors.

- [ ] **Step 5: Run tests to confirm vitest picks up the new glob**

```bash
npm test
```

Expected: 25 test files pass (no new test file yet, just confirming config change doesn't break anything).

- [ ] **Step 6: Commit**

```bash
git add package.json vitest.config.ts scripts/migrate.ts
git commit -m "feat(migrate): scaffold wizard with @clack/prompts"
```

---

## Task 2: Types, SSH primitives, and unit tests

**Files:**
- Modify: `scripts/migrate.ts`
- Create: `scripts/migrate.test.ts`

These are the most testable parts of the wizard. Write tests first.

- [ ] **Step 1: Write the failing tests**

Create `scripts/migrate.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  SshCreds,
  MigrateError,
  buildSshArgs,
  buildSystemdUnit,
  buildBashrcBlock,
  needsBashrcUpdate,
} from './migrate.js';

vi.mock('child_process');

const creds: SshCreds = {
  host: 'myserver.local',
  port: 22,
  user: 'paden',
  remoteProjectPath: '/home/paden/nanoclaw',
};

describe('buildSshArgs', () => {
  it('includes port and StrictHostKeyChecking', () => {
    const args = buildSshArgs(creds);
    expect(args).toContain('-p');
    expect(args).toContain('22');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
  });

  it('adds -i flag when keyFile provided', () => {
    const args = buildSshArgs({ ...creds, keyFile: '/home/user/.ssh/id_ed25519' });
    expect(args).toContain('-i');
    expect(args).toContain('/home/user/.ssh/id_ed25519');
  });

  it('omits -i flag when no keyFile', () => {
    const args = buildSshArgs(creds);
    expect(args).not.toContain('-i');
  });
});

describe('buildSystemdUnit', () => {
  it('fills in node path and project root', () => {
    const unit = buildSystemdUnit('/usr/bin/node', '/home/paden/nanoclaw');
    expect(unit).toContain('ExecStart=/usr/bin/node /home/paden/nanoclaw/dist/index.js');
    expect(unit).toContain('WorkingDirectory=/home/paden/nanoclaw');
    expect(unit).toContain('StandardOutput=append:/home/paden/nanoclaw/logs/nanoclaw.log');
  });

  it('does not contain placeholder strings', () => {
    const unit = buildSystemdUnit('/usr/bin/node', '/home/paden/nanoclaw');
    expect(unit).not.toContain('PROJECT_ROOT');
    expect(unit).not.toContain('NODE_PATH');
  });
});

describe('buildBashrcBlock', () => {
  it('includes the guard comment and all three env vars', () => {
    const block = buildBashrcBlock('http://example.com', 'key123', 'my-model');
    expect(block).toContain('# nanoclaw-dev');
    expect(block).toContain('ANTHROPIC_BASE_URL="http://example.com"');
    expect(block).toContain('ANTHROPIC_API_KEY="key123"');
    expect(block).toContain('ANTHROPIC_MODEL="my-model"');
  });
});

describe('needsBashrcUpdate', () => {
  it('returns true when guard comment is absent', () => {
    expect(needsBashrcUpdate('export PATH="$HOME/.local/bin:$PATH"\n')).toBe(true);
  });

  it('returns false when guard comment is present', () => {
    expect(needsBashrcUpdate('# nanoclaw-dev\nexport ANTHROPIC_BASE_URL="x"\n')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- scripts/migrate.test.ts
```

Expected: fails with `Cannot find module './migrate.js'` or similar — the exports don't exist yet.

- [ ] **Step 3: Add types, exported functions, and SSH primitives to `scripts/migrate.ts`**

Replace the skeleton content (keep the main function at the bottom) with:

```typescript
#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { intro, outro, text, password, confirm, spinner, select, log } from '@clack/prompts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SshCreds {
  host: string;
  port: number;
  user: string;
  keyFile?: string; // undefined → warn about sshpass, ask user to use key auth
  remoteProjectPath: string;
}

export class MigrateError extends Error {
  constructor(
    message: string,
    public readonly output: string,
  ) {
    super(message);
    this.name = 'MigrateError';
  }
}

// ─── Pure helpers (exported for tests) ────────────────────────────────────────

export function buildSshArgs(creds: SshCreds): string[] {
  const args = ['-o', 'StrictHostKeyChecking=accept-new', '-p', String(creds.port)];
  if (creds.keyFile) args.push('-i', creds.keyFile);
  return args;
}

const SYSTEMD_UNIT_TEMPLATE = `[Unit]
Description=NanoClaw
After=network.target

[Service]
Type=simple
WorkingDirectory=PROJECT_ROOT
ExecStart=NODE_PATH PROJECT_ROOT/dist/index.js
Restart=always
RestartSec=5
StandardOutput=append:PROJECT_ROOT/logs/nanoclaw.log
StandardError=append:PROJECT_ROOT/logs/nanoclaw.error.log

[Install]
WantedBy=default.target
`;

export function buildSystemdUnit(nodePath: string, projectRoot: string): string {
  return SYSTEMD_UNIT_TEMPLATE
    .replaceAll('PROJECT_ROOT', projectRoot)
    .replace('NODE_PATH', nodePath);
}

export function buildBashrcBlock(baseUrl: string, apiKey: string, model: string): string {
  return [
    '',
    '# nanoclaw-dev — managed by migrate.ts, do not edit manually',
    `export ANTHROPIC_BASE_URL="${baseUrl}"`,
    `export ANTHROPIC_API_KEY="${apiKey}"`,
    `export ANTHROPIC_MODEL="${model}"`,
    '# end nanoclaw-dev',
    '',
  ].join('\n');
}

export function needsBashrcUpdate(content: string): boolean {
  return !content.includes('# nanoclaw-dev');
}

// ─── SSH/transfer layer ────────────────────────────────────────────────────────

function runRemote(creds: SshCreds, command: string): string {
  const result = spawnSync(
    'ssh',
    [...buildSshArgs(creds), `${creds.user}@${creds.host}`, command],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new MigrateError(
      `Remote command failed: ${command}`,
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim(),
    );
  }
  return result.stdout ?? '';
}

function rsyncTo(
  creds: SshCreds,
  localPath: string,
  remotePath: string,
  excludes: string[] = [],
): void {
  const excludeArgs = excludes.flatMap((e) => ['--exclude', e]);
  const sshCmd = `ssh ${buildSshArgs(creds).join(' ')}`;
  const result = spawnSync(
    'rsync',
    ['-avz', '--delete', '-e', sshCmd, ...excludeArgs, localPath, `${creds.user}@${creds.host}:${remotePath}`],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new MigrateError('rsync failed', `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim());
  }
}

function scpTo(creds: SshCreds, localPath: string, remotePath: string): void {
  const result = spawnSync(
    'scp',
    ['-r', ...buildSshArgs(creds), localPath, `${creds.user}@${creds.host}:${remotePath}`],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new MigrateError('scp failed', `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim());
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  intro('NanoClaw → Ubuntu Migration Wizard');
  outro('Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- scripts/migrate.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all 26 test files (was 25) pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate.ts scripts/migrate.test.ts
git commit -m "feat(migrate): add types, SSH primitives, and pure helpers with tests"
```

---

## Task 3: Step runner

**Files:**
- Modify: `scripts/migrate.ts`

The step runner wraps each wizard step: runs the function, shows a spinner, and on failure prompts retry/skip/abort.

- [ ] **Step 1: Add the step runner before the `main` function**

Insert this block between the `scpTo` function and the `main` function:

```typescript
// ─── Step runner ──────────────────────────────────────────────────────────────

interface StepSummary {
  label: string;
  result: 'completed' | 'skipped' | 'aborted';
}

async function runStep(
  label: string,
  fn: () => void | Promise<void>,
  summaries: StepSummary[],
): Promise<boolean> {
  const s = spinner();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    s.start(label);
    try {
      await fn();
      s.stop(`${label}`);
      summaries.push({ label, result: 'completed' });
      return true;
    } catch (err) {
      const output =
        err instanceof MigrateError ? err.output : String(err);
      s.stop(`${label} — FAILED`);
      if (output) log.error(output);

      const action = await select({
        message: 'What would you like to do?',
        options: [
          { value: 'retry', label: 'Retry this step' },
          { value: 'skip', label: 'Skip and continue' },
          { value: 'abort', label: 'Abort migration' },
        ],
      });

      if (action === 'retry') continue;
      if (action === 'skip') {
        summaries.push({ label, result: 'skipped' });
        return true;
      }
      // abort
      summaries.push({ label, result: 'aborted' });
      return false;
    }
  }
}
```

- [ ] **Step 2: Verify the file still runs**

```bash
npx tsx scripts/migrate.ts
```

Expected: same output as before — intro and outro, no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate.ts
git commit -m "feat(migrate): add step runner with retry/skip/abort"
```

---

## Task 4: Credential collection and SSH verification (Steps 1–2)

**Files:**
- Modify: `scripts/migrate.ts`

- [ ] **Step 1: Replace the `main` function with credential collection and SSH verify step**

```typescript
async function main() {
  intro('NanoClaw → Ubuntu Migration Wizard');

  const summaries: StepSummary[] = [];

  // ── Step 1: Collect SSH credentials ─────────────────────────────────────────
  log.step('Collecting SSH credentials');

  const host = await text({ message: 'Server hostname or IP:', placeholder: '192.168.1.100' });
  if (typeof host !== 'string') process.exit(0);

  const portRaw = await text({ message: 'SSH port:', placeholder: '22', initialValue: '22' });
  if (typeof portRaw !== 'string') process.exit(0);
  const port = parseInt(portRaw, 10) || 22;

  const user = await text({ message: 'SSH username:', placeholder: 'ubuntu' });
  if (typeof user !== 'string') process.exit(0);

  const keyFile = await text({
    message: 'Path to SSH private key (leave blank for password auth — requires sshpass):',
    placeholder: `${process.env.HOME}/.ssh/id_ed25519`,
  });
  if (typeof keyFile !== 'string') process.exit(0);

  const remoteProjectPath = await text({
    message: 'Remote path to install NanoClaw:',
    placeholder: `/home/${user}/nanoclaw`,
    initialValue: `/home/${user}/nanoclaw`,
  });
  if (typeof remoteProjectPath !== 'string') process.exit(0);

  const creds: SshCreds = {
    host,
    port,
    user,
    keyFile: keyFile.trim() || undefined,
    remoteProjectPath,
  };

  if (!creds.keyFile) {
    log.warn(
      'No key file provided. Password auth requires sshpass (not installed by default on macOS). ' +
      'Key-based auth is strongly recommended.',
    );
  }

  // ── Step 2: Verify SSH connection ────────────────────────────────────────────
  const cont = await runStep(
    'Verify SSH connection',
    () => { runRemote(creds, 'echo ok'); },
    summaries,
  );
  if (!cont) return finish(summaries);

  outro('Connected! Continuing with migration steps...');
  // More steps will be added in subsequent tasks
  finish(summaries);
}

function finish(summaries: StepSummary[]): void {
  const lines = summaries.map((s) => {
    const icon = s.result === 'completed' ? '✓' : s.result === 'skipped' ? '⚠' : '✗';
    return `  ${icon} ${s.label}`;
  });
  outro(`Migration complete.\n${lines.join('\n')}`);
}
```

- [ ] **Step 2: Verify it runs and prompts**

```bash
npx tsx scripts/migrate.ts
```

Expected: prompts for host, port, user, key file, remote path. After entering values, attempts SSH and either shows "Connected!" or the failure prompt.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate.ts
git commit -m "feat(migrate): add credential collection and SSH verification steps"
```

---

## Task 5: Prereq check step (Step 3)

**Files:**
- Modify: `scripts/migrate.ts`

- [ ] **Step 1: Add a helper function and the prereq step**

Add this helper after `scpTo` and before the step runner:

```typescript
function checkRemoteCommand(creds: SshCreds, cmd: string): boolean {
  const result = spawnSync(
    'ssh',
    [...buildSshArgs(creds), `${creds.user}@${creds.host}`, `command -v ${cmd} >/dev/null 2>&1 && echo ok || echo missing`],
    { encoding: 'utf8' },
  );
  return (result.stdout ?? '').trim() === 'ok';
}
```

- [ ] **Step 2: Add the prereq step to `main`, after the SSH verify step**

Insert after the SSH verify step (before `outro`):

```typescript
  // ── Step 3: Verify server prereqs ────────────────────────────────────────────
  await runStep(
    'Verify server prerequisites',
    () => {
      const missing: string[] = [];
      for (const cmd of ['node', 'docker', 'claude']) {
        if (!checkRemoteCommand(creds, cmd)) missing.push(cmd);
      }
      const nodeVersion = runRemote(creds, 'node --version 2>/dev/null || echo none').trim();
      if (nodeVersion !== 'none') {
        const major = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);
        if (major < 20) missing.push(`node>=20 (found ${nodeVersion})`);
      }
      if (missing.length > 0) {
        log.warn(`Missing on server (continuing anyway): ${missing.join(', ')}`);
      }
    },
    summaries,
  );
```

- [ ] **Step 3: Run a quick smoke test**

```bash
npx tsx scripts/migrate.ts
```

Walk through prompts (can use `Ctrl+C` after confirming the new step appears).

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate.ts
git commit -m "feat(migrate): add server prereq check step"
```

---

## Task 6: Repo sync, secrets copy, and runtime state copy (Steps 4–6)

**Files:**
- Modify: `scripts/migrate.ts`

- [ ] **Step 1: Add steps 4–6 to `main` after the prereq step**

```typescript
  // ── Step 4: Sync repo ─────────────────────────────────────────────────────────
  const localRoot = process.cwd();
  let cont2 = await runStep(
    'Sync repo to server',
    () => {
      runRemote(creds, `mkdir -p ${creds.remoteProjectPath}`);
      rsyncTo(creds, `${localRoot}/`, `${creds.remoteProjectPath}/`, [
        'node_modules',
        'dist',
        'logs',
        '.git',
        'store',
        'data',
      ]);
    },
    summaries,
  );
  if (!cont2) return finish(summaries);

  // ── Step 5: Copy secrets and config ──────────────────────────────────────────
  cont2 = await runStep(
    'Copy .env and ~/.config/nanoclaw/',
    () => {
      scpTo(creds, `${localRoot}/.env`, `${creds.remoteProjectPath}/.env`);
      runRemote(creds, `mkdir -p ~/.config/nanoclaw`);
      const configDir = `${process.env.HOME}/.config/nanoclaw`;
      scpTo(creds, `${configDir}/mount-allowlist.json`, `~/.config/nanoclaw/mount-allowlist.json`);
      // sender-allowlist is optional — may not exist
      const result = spawnSync('test', ['-f', `${configDir}/sender-allowlist.json`]);
      if (result.status === 0) {
        scpTo(creds, `${configDir}/sender-allowlist.json`, `~/.config/nanoclaw/sender-allowlist.json`);
      }
    },
    summaries,
  );
  if (!cont2) return finish(summaries);

  // ── Step 6: Copy runtime state ────────────────────────────────────────────────
  await runStep(
    'Copy runtime state (store/ and data/)',
    () => {
      runRemote(creds, `mkdir -p ${creds.remoteProjectPath}/store ${creds.remoteProjectPath}/data`);
      rsyncTo(creds, `${localRoot}/store/`, `${creds.remoteProjectPath}/store/`);
      rsyncTo(creds, `${localRoot}/data/`, `${creds.remoteProjectPath}/data/`);
    },
    summaries,
  );
```

Note: `store/` and `data/` may not exist locally if the bot hasn't run yet — that's fine, rsync of an empty/missing dir is a no-op. The `mkdir -p` ensures the remote dirs exist.

- [ ] **Step 2: Verify smoke test**

```bash
npx tsx scripts/migrate.ts
```

Walk through to confirm the three new steps appear in sequence.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate.ts
git commit -m "feat(migrate): add repo sync, secrets copy, and runtime state steps"
```

---

## Task 7: OneCLI setup (Step 7)

**Files:**
- Modify: `scripts/migrate.ts`

OneCLI is a local HTTP gateway that proxies API calls and injects credentials. It must be installed and running on Ubuntu before NanoClaw starts. Secret values cannot be exported from OneCLI (only metadata), so the user is prompted to re-enter them.

- [ ] **Step 1: Add a helper to run onecli commands locally and parse JSON**

Add before the step runner:

```typescript
function localOnecliJson<T>(args: string[]): T {
  const result = spawnSync('onecli', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new MigrateError(
      `onecli ${args.join(' ')} failed`,
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim(),
    );
  }
  return JSON.parse(result.stdout ?? '{}') as T;
}
```

- [ ] **Step 2: Add the OneCLI setup step to `main`**

```typescript
  // ── Step 7: Set up OneCLI ─────────────────────────────────────────────────────
  await runStep(
    'Set up OneCLI on server',
    async () => {
      // Install OneCLI gateway and CLI on server
      runRemote(
        creds,
        'curl -fsSL onecli.sh/install | sh && curl -fsSL onecli.sh/cli/install | sh',
      );
      // Ensure ~/.local/bin is in PATH for subsequent remote commands
      runRemote(creds, 'export PATH="$HOME/.local/bin:$PATH" && onecli version');

      // Determine the port OneCLI listens on by checking local ONECLI_URL
      const localOnecliUrl = process.env.ONECLI_URL || 'http://127.0.0.1:10254';
      const onecliPort = new URL(localOnecliUrl).port || '10254';
      const remoteOnecliUrl = `http://127.0.0.1:${onecliPort}`;

      // Point the remote onecli CLI at its local instance
      runRemote(
        creds,
        `export PATH="$HOME/.local/bin:$PATH" && onecli config set api-host ${remoteOnecliUrl}`,
      );

      // Wait for the gateway to become healthy (up to 15s)
      runRemote(
        creds,
        `for i in $(seq 1 15); do curl -sf ${remoteOnecliUrl}/health && break; sleep 1; done`,
      );

      // Get local secrets list (metadata only — values are NOT exposed)
      type SecretMeta = {
        name: string;
        type: string;
        hostPattern: string;
        pathPattern?: string | null;
        injectionConfig?: { headerName?: string; valueFormat?: string } | null;
      };
      const { data: secrets } = localOnecliJson<{ data: SecretMeta[] }>(['secrets', 'list']);

      log.info(`Found ${secrets.length} secret(s) to migrate. You will be prompted for each value.`);
      for (const secret of secrets) {
        log.info(`Secret: "${secret.name}" (type: ${secret.type}, host: ${secret.hostPattern})`);
        const value = await password({ message: `Enter value for "${secret.name}":` });
        if (typeof value !== 'string' || !value.trim()) {
          log.warn(`Skipping "${secret.name}" — no value entered.`);
          continue;
        }
        // Build create command
        const args = [
          'secrets', 'create',
          '--name', secret.name,
          '--type', secret.type,
          '--value', value.trim(),
          '--host-pattern', secret.hostPattern,
        ];
        if (secret.pathPattern) args.push('--path-pattern', secret.pathPattern);
        if (secret.injectionConfig?.headerName) args.push('--header-name', secret.injectionConfig.headerName);
        if (secret.injectionConfig?.valueFormat) args.push('--value-format', secret.injectionConfig.valueFormat);

        // Run the create command on the remote server via SSH
        const escapedArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
        runRemote(
          creds,
          `export PATH="$HOME/.local/bin:$PATH" && onecli ${escapedArgs}`,
        );
        log.success(`Migrated secret: "${secret.name}"`);
      }

      // Patch ONECLI_URL in remote .env
      runRemote(
        creds,
        `sed -i 's|^ONECLI_URL=.*|ONECLI_URL=${remoteOnecliUrl}|' ${creds.remoteProjectPath}/.env`,
      );
      log.success(`ONECLI_URL set to ${remoteOnecliUrl} in remote .env`);
    },
    summaries,
  );
```

- [ ] **Step 3: Verify smoke test**

```bash
npx tsx scripts/migrate.ts
```

Walk through to confirm the OneCLI step appears after runtime state.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate.ts
git commit -m "feat(migrate): add OneCLI install and secret migration step"
```

---

## Task 8: Install dependencies and build container (Steps 8–9)

**Files:**
- Modify: `scripts/migrate.ts`

- [ ] **Step 1: Add build steps to `main`**

```typescript
  // ── Step 8: Install dependencies and build ────────────────────────────────────
  await runStep(
    'npm install && npm run build on server',
    () => {
      runRemote(creds, `cd ${creds.remoteProjectPath} && npm install`);
      runRemote(creds, `cd ${creds.remoteProjectPath} && npm run build`);
    },
    summaries,
  );

  // ── Step 9: Build agent container ─────────────────────────────────────────────
  await runStep(
    'Build agent container (./container/build.sh)',
    () => {
      runRemote(creds, `cd ${creds.remoteProjectPath} && bash ./container/build.sh`);
    },
    summaries,
  );
```

Note: the container build can take 5–10 minutes. The spinner will block until it completes — that's expected.

- [ ] **Step 2: Verify smoke test**

```bash
npx tsx scripts/migrate.ts
```

Walk through to confirm both build steps appear in sequence.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate.ts
git commit -m "feat(migrate): add npm build and container build steps"
```

---

## Task 9: Install systemd service (Step 10)

**Files:**
- Modify: `scripts/migrate.ts`

- [ ] **Step 1: Add the systemd install step to `main`**

```typescript
  // ── Step 10: Install systemd service ─────────────────────────────────────────
  await runStep(
    'Install systemd service',
    () => {
      const nodePath = runRemote(creds, 'which node').trim();
      const unit = buildSystemdUnit(nodePath, creds.remoteProjectPath);
      const unitDir = '~/.config/systemd/user';
      const unitPath = `${unitDir}/nanoclaw.service`;

      runRemote(creds, `mkdir -p ${unitDir}`);
      // Write unit file via heredoc
      const escaped = unit.replace(/'/g, "'\\''");
      runRemote(creds, `printf '%s' '${escaped}' > ${unitPath}`);
      runRemote(
        creds,
        'systemctl --user daemon-reload && systemctl --user enable nanoclaw',
      );
      log.success(`systemd unit installed at ${unitPath}`);
    },
    summaries,
  );
```

- [ ] **Step 2: Verify smoke test**

```bash
npx tsx scripts/migrate.ts
```

Walk through to confirm systemd step appears.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate.ts
git commit -m "feat(migrate): add systemd service install step"
```

---

## Task 10: Configure dev Claude CLI (Step 11)

**Files:**
- Modify: `scripts/migrate.ts`

This step appends Ollama Pro environment variables to `~/.bashrc` on the server so dev sessions (SSH + Claude Code) route model calls through Ollama Pro instead of Anthropic directly. It reads the current `.env` values for `ANTHROPIC_BASE_URL`, `OLLAMA_API_KEY`, and `ANTHROPIC_MODEL` as the source of truth.

- [ ] **Step 1: Add the bashrc config step to `main`**

```typescript
  // ── Step 11: Configure dev Claude CLI ────────────────────────────────────────
  await runStep(
    'Configure dev Claude CLI (~/.bashrc Ollama Pro env vars)',
    async () => {
      // Read current .env to get values — these are already on disk locally
      const { readFileSync } = await import('fs');
      const envContent = readFileSync('.env', 'utf8');
      const getEnvVal = (key: string): string => {
        const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
        return match ? match[1].trim() : '';
      };

      // ANTHROPIC_BASE_URL: derived from ONECLI_URL (that's what containers use)
      // For dev sessions on the server, point at the Ollama Pro endpoint directly
      // by using the same ONECLI_URL value as ANTHROPIC_BASE_URL.
      const onecliUrl = getEnvVal('ONECLI_URL');
      const ollamaApiKey = getEnvVal('OLLAMA_API_KEY');
      const anthropicModel = getEnvVal('ANTHROPIC_MODEL');

      if (!onecliUrl || !ollamaApiKey) {
        log.warn('Could not read ONECLI_URL or OLLAMA_API_KEY from local .env — skipping bashrc update.');
        return;
      }

      const bashrcContent = runRemote(creds, 'cat ~/.bashrc 2>/dev/null || echo ""');
      if (!needsBashrcUpdate(bashrcContent)) {
        log.info('~/.bashrc already contains nanoclaw-dev block — skipping.');
        return;
      }

      const block = buildBashrcBlock(onecliUrl, ollamaApiKey, anthropicModel);
      const escaped = block.replace(/'/g, "'\\''");
      runRemote(creds, `printf '%s' '${escaped}' >> ~/.bashrc`);
      log.success('Appended Ollama Pro dev config to ~/.bashrc');
    },
    summaries,
  );
```

- [ ] **Step 2: Verify smoke test**

```bash
npx tsx scripts/migrate.ts
```

Walk through to confirm the bashrc step appears.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate.ts
git commit -m "feat(migrate): add dev Claude CLI bashrc config step"
```

---

## Task 11: Start service, verify, and wire `main()` into its final shape (Step 12)

**Files:**
- Modify: `scripts/migrate.ts`

This is the final step and also the cleanup pass — verify the wizard flows cleanly end-to-end and that the `finish()` summary is clear.

- [ ] **Step 1: Add the start-and-verify step to `main`**

```typescript
  // ── Step 12: Start service and verify ─────────────────────────────────────────
  await runStep(
    'Start nanoclaw service and check logs',
    () => {
      runRemote(creds, 'systemctl --user start nanoclaw');
      // Tail logs for 5 seconds to check for startup errors
      const logs = runRemote(
        creds,
        `sleep 3 && journalctl --user -u nanoclaw -n 20 --no-pager 2>/dev/null || tail -20 ${creds.remoteProjectPath}/logs/nanoclaw.log 2>/dev/null || echo "(no logs yet)"`,
      );
      log.info('Recent logs:\n' + logs);
      // Check if the service is running
      const status = runRemote(
        creds,
        'systemctl --user is-active nanoclaw 2>/dev/null || echo inactive',
      ).trim();
      if (status !== 'active') {
        throw new MigrateError(
          `Service not active (status: ${status})`,
          'Check logs above for errors.',
        );
      }
    },
    summaries,
  );

  finish(summaries);
```

- [ ] **Step 2: Update `finish()` to print a final tip**

```typescript
function finish(summaries: StepSummary[]): void {
  const lines = summaries.map((s) => {
    const icon = s.result === 'completed' ? '✓' : s.result === 'skipped' ? '⚠' : '✗';
    return `  ${icon} ${s.label} — ${s.result}`;
  });
  const skipped = summaries.filter((s) => s.result === 'skipped').length;
  const tip = skipped > 0
    ? '\nTip: Re-run the wizard to retry skipped steps — rsync/scp/systemd are safe to re-run.'
    : '';
  outro(`Migration summary:\n${lines.join('\n')}${tip}`);
}
```

- [ ] **Step 3: Run full end-to-end smoke test against a real server (if available)**

```bash
npx tsx scripts/migrate.ts
```

Enter real server credentials and walk through all 12 steps. Verify:
- Service is active after step 12: `ssh user@host systemctl --user is-active nanoclaw`
- Logs show NanoClaw started: `ssh user@host tail -20 ~/nanoclaw/logs/nanoclaw.log`
- ONECLI_URL in remote .env is updated: `ssh user@host grep ONECLI_URL ~/nanoclaw/.env`
- `~/.bashrc` has the nanoclaw-dev block: `ssh user@host grep -A4 "nanoclaw-dev" ~/.bashrc`

- [ ] **Step 4: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Final commit**

```bash
git add scripts/migrate.ts
git commit -m "feat(migrate): add start/verify step and wire complete wizard"
```

---

## Self-Review Checklist

Verified against spec (`docs/superpowers/specs/2026-04-18-ubuntu-migration-design.md`):

- [x] Step 1: Collect SSH credentials ✓ (Task 4)
- [x] Step 2: Verify SSH connection ✓ (Task 4)
- [x] Step 3: Verify server prereqs — warn but don't block ✓ (Task 5)
- [x] Step 4: Sync repo excluding node_modules/dist/logs ✓ (Task 6)
- [x] Step 5: Copy .env + both allowlist files ✓ (Task 6)
- [x] Step 6: Copy store/ and data/ ✓ (Task 6)
- [x] Step 7: OneCLI install + secrets replay + ONECLI_URL patch ✓ (Task 7)
- [x] Step 8: npm install && npm run build ✓ (Task 8)
- [x] Step 9: ./container/build.sh ✓ (Task 8)
- [x] Step 10: systemd install ✓ (Task 9)
- [x] Step 11: ~/.bashrc dev Claude config ✓ (Task 10)
- [x] Step 12: Start + verify ✓ (Task 11)
- [x] Retry/skip/abort on failure ✓ (Task 3)
- [x] Idempotency — rsync/scp safe, bashrc guard, systemd check ✓
- [x] sshpass warning ✓ (Task 4)
- [x] sender-allowlist.json included ✓ (Task 6)
- [x] vitest config updated to pick up scripts tests ✓ (Task 1)
