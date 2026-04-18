# Ubuntu Migration Wizard — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-time interactive terminal wizard (`scripts/migrate.ts`) that migrates NanoClaw from macOS to an Ubuntu home server over SSH.

**Architecture:** Single TypeScript file with three layers — `@clack/prompts` UI, thin SSH/rsync shell-out wrappers, and a sequential step runner with retry/skip/abort on failure. Runs on the Mac, operates on the remote server via `ssh`, `rsync`, and `scp`.

**Tech Stack:** TypeScript, `@clack/prompts`, Node.js `child_process`, standard POSIX tools (`ssh`, `rsync`, `scp`), systemd on the server.

---

## Context

Current setup (macOS):
- NanoClaw runs as a launchd service
- OneCLI is a locally-running proxy on the Mac; `ONECLI_URL` in `.env` points at `localhost`
- The Ubuntu server already has Node.js, Docker, and the `claude` CLI installed
- Agent containers use Ollama Pro (via OneCLI) for all model calls (`ANTHROPIC_MODEL=gemini-3-flash-preview:cloud`)

Target setup (Ubuntu):
- NanoClaw runs as a systemd user service
- OneCLI runs on the Ubuntu server; `ONECLI_URL` updated to `http://localhost:<port>`
- Dev sessions (SSH) use Ollama Pro directly via `~/.bashrc` env vars
- NanoClaw bot continues to use Ollama Pro via OneCLI (same as today)

---

## Wizard Steps

The wizard runs sequentially. Each step shows a spinner and resolves to ✓ or ✗.

1. **Collect SSH credentials** — host, port, user, key file path or password
2. **Verify SSH connection** — test connection; fail fast before doing anything
3. **Verify server prereqs** — confirm Node.js ≥20, Docker, and `claude` CLI are present; warn if missing but don't block
4. **Sync repo** — `rsync` project directory to server, excluding `node_modules/`, `dist/`, `logs/`
5. **Copy secrets** — `scp` `.env` to `<project>/` and `~/.config/nanoclaw/` (both `mount-allowlist.json` and `sender-allowlist.json`) to server
6. **Copy runtime state** — `rsync` `store/` (SQLite DB, sessions) and `data/` (IPC queue, container env files)
7. **Set up OneCLI** — install the `onecli` CLI binary on the server (`npm install -g onecli` or equivalent), start the OneCLI proxy daemon (the local HTTP gateway that containers route through), replay secrets and agent configs from local `onecli` CLI output, patch `ONECLI_URL` in remote `.env` to the local proxy address
8. **Install dependencies & build** — SSH: `npm install && npm run build`
9. **Build agent container** — SSH: `./container/build.sh`
10. **Install systemd service** — generate `nanoclaw.service` unit from embedded template, write to `~/.config/systemd/user/nanoclaw.service`, run `systemctl --user daemon-reload && systemctl --user enable nanoclaw`
11. **Configure dev Claude CLI** — append Ollama Pro env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`) to `~/.bashrc` on server, guarded by a `# nanoclaw-dev` comment block to prevent duplicate appends
12. **Start service & verify** — `systemctl --user start nanoclaw`, tail `logs/nanoclaw.log` for ~5 seconds to confirm startup

---

## Components

### `scripts/migrate.ts`

Single file, ~300 lines. Three internal layers:

**UI layer**
- `@clack/prompts`: `intro`, `text`, `password`, `confirm`, `spinner`, `outro`
- Each step runs inside a spinner; failure shows raw error output from the failing command

**SSH/transfer layer**
- `runRemote(creds, command)` — wraps `spawnSync('ssh', [...])`, throws `MigrateError` with stdout+stderr on non-zero exit
- `rsyncTo(creds, localPath, remotePath, excludes?)` — wraps `spawnSync('rsync', ['-avz', '--exclude=...', ...])`
- `scpTo(creds, localPath, remotePath)` — wraps `spawnSync('scp', [...])`
- SSH args built once from collected creds; key file auth via `-i` flag (strongly preferred). Password auth requires `sshpass` which is not installed by default on macOS — wizard warns and recommends key-based auth if no key file is provided

**Step runner**
- `runStep(label, fn)` — runs `fn()`, catches `MigrateError`, prompts retry/skip/abort
- Steps are an ordered array of `{ label, fn }` objects; executed sequentially
- No state file; wizard restarts from step 1 if restarted (rsync/scp/systemd steps are safe to re-run)

### Systemd unit template (embedded string in `migrate.ts`)

```ini
[Unit]
Description=NanoClaw
After=network.target

[Service]
Type=simple
WorkingDirectory=<PROJECT_ROOT>
ExecStart=<NODE_PATH> <PROJECT_ROOT>/dist/index.js
Restart=always
RestartSec=5
StandardOutput=append:<PROJECT_ROOT>/logs/nanoclaw.log
StandardError=append:<PROJECT_ROOT>/logs/nanoclaw.error.log

[Install]
WantedBy=default.target
```

Placeholders filled from SSH session (resolved via `which node` and the synced project path).

### OneCLI migration

The wizard runs these locally then replays on the server:
```
onecli secrets list  →  onecli secrets create (for each)
onecli agents list   →  onecli agents create (for each)
```
Skips secrets/agents that already exist by name (idempotent). Updates `ONECLI_URL` in remote `.env` using `sed` over SSH once OneCLI is confirmed running.

---

## Error Handling

- **Failure prompt:** retry / skip / abort
- **Retry:** re-runs the same step function
- **Skip:** marks step as skipped, continues — useful for steps already done manually
- **Abort:** exits with a printed summary of completed, skipped, and failed steps
- **Idempotency:** rsync and scp are safe to re-run; systemd install checks for existing unit; OneCLI replay skips existing names; `~/.bashrc` append guarded by `# nanoclaw-dev` block check

---

## Running the Wizard

```bash
npx tsx scripts/migrate.ts
```

No flags, no subcommands. Collects SSH creds interactively at the start.

---

## Out of Scope

- Rollback on failure
- Dry-run mode
- Config file / saved state between runs
- Automatic OneCLI install (if `onecli` binary is not already available on the server, the wizard will print instructions and skip that step)
