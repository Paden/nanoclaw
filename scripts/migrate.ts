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
  outro('Done!');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
