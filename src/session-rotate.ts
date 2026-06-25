/**
 * Session rotation — recovers a session from the compaction-empty-output
 * trap by clearing SDK-side state without touching long-term memory.
 *
 * The trap: when an SDK conversation grows past ~5 MB of JSONL transcript,
 * a compaction event produces empty output on the first turn after it
 * fires. The agent-runner marks the message completed without sending,
 * the message vanishes silently. This repeats every turn until something
 * resets the SDK session.
 *
 * The recipe (verified 3x — silverthorne once, emilio-care twice):
 *   1. Kill the running container if any
 *   2. Move *.jsonl transcripts under .claude-shared/projects/-workspace-agent/
 *      to _archived/ so the SDK can't pick them up via `resumeAt: latest`
 *   3. Delete `continuation:claude` from outbound.db session_state so the
 *      next spawn starts a brand-new SDK session id
 *
 * Per-group long-term memory (CLAUDE.local.md, conversations/, custom .md
 * notes in /workspace/agent/) is intentionally preserved — those live
 * outside .claude-shared/projects and survive rotation.
 */
import fs from 'fs';
import path from 'path';

import { log } from './log.js';
import { killContainer } from './container-runner.js';
import { sessionDir } from './session-manager.js';
import { openOutboundDbRw } from './session-manager.js';

const JSONL_PROJECTS_REL = path.join('..', '.claude-shared', 'projects', '-workspace-agent');
const ARCHIVE_SUBDIR = '_archived';

export interface RotationOutcome {
  containerKilled: boolean;
  archivedJsonls: string[];
  continuationDeleted: boolean;
  reason: string;
}

/**
 * Total bytes of *.jsonl transcript files under
 *  .claude-shared/projects/-workspace-agent/ for this session.
 * Returns 0 if the dir doesn't exist (first-spawn agent groups).
 */
export function jsonlBytesForSession(agentGroupId: string, sessionId: string): number {
  const dir = path.join(sessionDir(agentGroupId, sessionId), JSONL_PROJECTS_REL);
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      total += fs.statSync(path.join(dir, entry.name)).size;
    } catch {
      /* file vanished between readdir and stat — ignore */
    }
  }
  return total;
}

/**
 * Execute the rotation recipe. Safe to call when no container is running
 * (skips the kill step) and when no JSONLs exist (no-op archive).
 * Returns details for logging/auditing.
 */
export function rotateSession(agentGroupId: string, sessionId: string, reason: string): RotationOutcome {
  const outcome: RotationOutcome = {
    containerKilled: false,
    archivedJsonls: [],
    continuationDeleted: false,
    reason,
  };

  try {
    killContainer(sessionId, `session-rotate: ${reason}`);
    outcome.containerKilled = true;
  } catch (err) {
    log.warn('rotateSession: killContainer threw (continuing)', { sessionId, err: (err as Error).message });
  }

  const projectsDir = path.join(sessionDir(agentGroupId, sessionId), JSONL_PROJECTS_REL);
  if (fs.existsSync(projectsDir)) {
    const archiveDir = path.join(projectsDir, ARCHIVE_SUBDIR);
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
    } catch (err) {
      log.warn('rotateSession: archive mkdir failed', { agentGroupId, sessionId, err: (err as Error).message });
    }
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const src = path.join(projectsDir, entry.name);
      const dst = path.join(archiveDir, entry.name);
      try {
        fs.renameSync(src, dst);
        outcome.archivedJsonls.push(entry.name);
      } catch (err) {
        log.warn('rotateSession: archive rename failed', { src, err: (err as Error).message });
      }
    }
  }

  try {
    const db = openOutboundDbRw(agentGroupId, sessionId);
    try {
      const info = db.prepare("DELETE FROM session_state WHERE key = 'continuation:claude'").run();
      outcome.continuationDeleted = info.changes > 0;
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn('rotateSession: continuation delete failed', { sessionId, err: (err as Error).message });
  }

  log.info('Session rotated', {
    sessionId,
    agentGroupId,
    reason,
    containerKilled: outcome.containerKilled,
    archivedCount: outcome.archivedJsonls.length,
    continuationDeleted: outcome.continuationDeleted,
  });

  return outcome;
}
