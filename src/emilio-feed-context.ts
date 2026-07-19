// Reads Emilio's latest feeding and formats a "last fed Xoz (Yh Zm ago)"
// suffix for the nap-close chime subtext. Used by both the slash-command
// path (scripts/emilio-slash.mjs:runAwake) and the agent-driven path
// (src/channels/discord.ts subtext rendering for emilio-care). A single
// source of truth so the enrichment is consistent regardless of whether
// the user typed `/awake` or said "he's awake" to Claudio in chat.

import path from 'path';
import os from 'os';
import { log } from './log.js';

// sheets.mjs defaults to container-mount paths. Set host-side fallbacks
// once at module load (matches the wordle-coin-reconciliation pattern).
if (!process.env.GOOGLE_OAUTH_CREDENTIALS) {
  process.env.GOOGLE_OAUTH_CREDENTIALS = path.resolve(process.cwd(), 'data', 'google-calendar', 'gcp-oauth.keys.json');
}
if (!process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH) {
  process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH = path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json');
}

const EMILIO_SHEET = '1mt_C1qtDRvaiYuK-iOvmxnTgsrcO3Fx0w389kMgvQzM';

interface SheetsLib {
  getAccessToken(): Promise<string>;
  readRange(sheetId: string, range: string, opts: { token: string }): Promise<string[][]>;
}

let sheetsMod: Promise<SheetsLib> | null = null;
function loadSheetsMod(): Promise<SheetsLib> {
  if (!sheetsMod) {
    sheetsMod = import('../groups/global/scripts/lib/sheets.mjs' as string) as Promise<SheetsLib>;
  }
  return sheetsMod;
}

// Parse a Chicago-local timestamp like "2026-05-23 22:20:00" → epoch ms.
// Handles ISO inputs (with T/Z) directly, otherwise uses the live Chicago
// offset (CDT/CST per DST).
export function parseChicagoLocalTs(s: string): number {
  if (/[TZ]/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : NaN;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'shortOffset',
  });
  const parts = fmt.formatToParts(probe);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const offMatch = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!offMatch) return NaN;
  const sign = offMatch[1] === '+' ? 1 : -1;
  const offMin = sign * (parseInt(offMatch[2], 10) * 60 + parseInt(offMatch[3] || '0', 10));
  return Date.UTC(y, mo - 1, d, h, mi, se) - offMin * 60_000;
}

export function formatTimeDelta(fromMs: number, toMs: number): string {
  const deltaMin = Math.max(0, Math.round((toMs - fromMs) / 60_000));
  const h = Math.floor(deltaMin / 60);
  const m = deltaMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

interface LastFeed {
  timestamp: string;
  amount: string;
  source: string;
  ms: number;
}

export async function getLastFeed(): Promise<LastFeed | null> {
  const sheets = await loadSheetsMod();
  const token = await sheets.getAccessToken();
  const rows = await sheets.readRange(EMILIO_SHEET, 'Feedings!A:C', { token });
  if (!rows || rows.length < 2) return null;
  for (let i = rows.length - 1; i >= 1; i--) {
    const ts = String(rows[i][0] || '').trim();
    if (!ts) continue;
    const ms = parseChicagoLocalTs(ts);
    if (!Number.isFinite(ms)) continue;
    return {
      timestamp: ts,
      amount: String(rows[i][1] || '').trim(),
      source: String(rows[i][2] || '').trim(),
      ms,
    };
  }
  return null;
}

/**
 * Build the `· last fed Xoz (Yh Zm ago)` suffix to append to a nap-close
 * chime's subtext. Anchored to the wake moment (or now if not provided).
 * Returns empty string on any error (caller should treat as no-op).
 */
export async function buildLastFedSuffix(wakeMs: number = Date.now()): Promise<string> {
  try {
    const last = await getLastFeed();
    if (!last) return '';
    const oz = last.amount || '?';
    return ` · last fed ${oz}oz (${formatTimeDelta(last.ms, wakeMs)} ago)`;
  } catch (err) {
    log.warn('buildLastFedSuffix failed', { err: (err as Error).message });
    return '';
  }
}

/** True if the subtext already contains the last-fed enrichment. */
export function subtextAlreadyEnriched(subtext: string): boolean {
  return /last fed/i.test(subtext);
}

/**
 * True if the subtext matches a nap-close chime pattern (ends with or
 * contains a `Nm nap` marker). Used to decide whether to enrich.
 */
export function isNapCloseSubtext(subtext: string): boolean {
  return /\b\d+\s*m\s+nap\b/i.test(subtext);
}
