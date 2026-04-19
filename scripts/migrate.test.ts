import { describe, it, expect } from 'vitest';
import {
  SshCreds,
  MigrateError,
  buildSshArgs,
  buildSystemdUnit,
  buildBashrcBlock,
  needsBashrcUpdate,
} from './migrate.js';

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

  it('handles projectRoot that contains NODE_PATH in its path', () => {
    const unit = buildSystemdUnit('/usr/bin/node', '/home/NODE_PATH/nanoclaw');
    expect(unit).toContain('WorkingDirectory=/home/NODE_PATH/nanoclaw');
    expect(unit).toContain('ExecStart=/usr/bin/node /home/NODE_PATH/nanoclaw/dist/index.js');
    expect(unit).not.toContain('PROJECT_ROOT');
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
