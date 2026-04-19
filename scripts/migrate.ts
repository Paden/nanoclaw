#!/usr/bin/env tsx
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
  return SYSTEMD_UNIT_TEMPLATE.replace(
    /PROJECT_ROOT|NODE_PATH/g,
    (token) => (token === 'PROJECT_ROOT' ? projectRoot : nodePath),
  );
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
  const output = [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim();
  if (result.status !== 0 || result.error) {
    throw new MigrateError(`Remote command failed: ${command}`, output);
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
  const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const sshCmd = `ssh ${buildSshArgs(creds).map(shellQuote).join(' ')}`;
  const result = spawnSync(
    'rsync',
    [
      '-avz',
      '--delete',
      '-e',
      sshCmd,
      ...excludeArgs,
      localPath,
      `${creds.user}@${creds.host}:${remotePath}`,
    ],
    { encoding: 'utf8' },
  );
  const rsyncOutput = [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim();
  if (result.status !== 0 || result.error) {
    throw new MigrateError('rsync failed', rsyncOutput);
  }
}

function scpTo(creds: SshCreds, localPath: string, remotePath: string): void {
  const result = spawnSync(
    'scp',
    ['-r', ...buildSshArgs(creds), localPath, `${creds.user}@${creds.host}:${remotePath}`],
    { encoding: 'utf8' },
  );
  const scpOutput = [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim();
  if (result.status !== 0 || result.error) {
    throw new MigrateError('scp failed', scpOutput);
  }
}

function checkRemoteCommand(creds: SshCreds, cmd: string): boolean {
  const result = spawnSync(
    'ssh',
    [
      ...buildSshArgs(creds),
      `${creds.user}@${creds.host}`,
      `command -v ${cmd} >/dev/null 2>&1 && echo ok || echo missing`,
    ],
    { encoding: 'utf8' },
  );
  return (result.stdout ?? '').trim() === 'ok';
}

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

// ─── Main ─────────────────────────────────────────────────────────────────────

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
    () => {
      runRemote(creds, 'echo ok');
    },
    summaries,
  );
  if (!cont) return finish(summaries);

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
      scpTo(
        creds,
        `${configDir}/mount-allowlist.json`,
        `~/.config/nanoclaw/mount-allowlist.json`,
      );
      // sender-allowlist is optional — may not exist
      const result = spawnSync('test', ['-f', `${configDir}/sender-allowlist.json`]);
      if (result.status === 0) {
        scpTo(
          creds,
          `${configDir}/sender-allowlist.json`,
          `~/.config/nanoclaw/sender-allowlist.json`,
        );
      }
    },
    summaries,
  );
  if (!cont2) return finish(summaries);

  // ── Step 6: Copy runtime state ────────────────────────────────────────────────
  await runStep(
    'Copy runtime state (store/ and data/)',
    () => {
      runRemote(
        creds,
        `mkdir -p ${creds.remoteProjectPath}/store ${creds.remoteProjectPath}/data`,
      );
      rsyncTo(creds, `${localRoot}/store/`, `${creds.remoteProjectPath}/store/`);
      rsyncTo(creds, `${localRoot}/data/`, `${creds.remoteProjectPath}/data/`);
    },
    summaries,
  );

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
          'secrets',
          'create',
          '--name',
          secret.name,
          '--type',
          secret.type,
          '--value',
          value.trim(),
          '--host-pattern',
          secret.hostPattern,
        ];
        if (secret.pathPattern) args.push('--path-pattern', secret.pathPattern);
        if (secret.injectionConfig?.headerName)
          args.push('--header-name', secret.injectionConfig.headerName);
        if (secret.injectionConfig?.valueFormat)
          args.push('--value-format', secret.injectionConfig.valueFormat);

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

  finish(summaries);
}

function finish(summaries: StepSummary[]): void {
  const lines = summaries.map((s) => {
    const icon = s.result === 'completed' ? '✓' : s.result === 'skipped' ? '⚠' : '✗';
    return `  ${icon} ${s.label}`;
  });
  outro(`Migration complete.\n${lines.join('\n')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
