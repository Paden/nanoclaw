import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const root = process.env.WORKSPACE_PROJECT;
const groupsDir = join(root, 'groups');
const cutoff = Date.now() - 24 * 60 * 60 * 1000;
const targets = [
  '/workspace/global/sheets.md',
  '/workspace/global/date_time_convention.md',
];

const byGroup = {};
let first = null;
let total = 0;

for (const entry of readdirSync(groupsDir)) {
  if (!entry.startsWith('discord_')) continue;
  const logPath = join(groupsDir, entry, 'logs', 'tool-calls.jsonl');
  if (!existsSync(logPath)) continue;
  const size = statSync(logPath).size;
  const start = Math.max(0, size - 2 * 1024 * 1024);
  const buf = readFileSync(logPath, 'utf8').slice(start);
  const lines = buf.split('\n');
  for (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.tool !== 'Read') continue;
    if (!rec.input_preview) continue;
    const hit = targets.find((t) => rec.input_preview.includes(t));
    if (!hit) continue;
    const ts = new Date(rec.t).getTime();
    if (isNaN(ts) || ts < cutoff) continue;
    total++;
    byGroup[entry] = (byGroup[entry] || 0) + 1;
    if (!first || ts < new Date(first.t).getTime()) {
      first = {
        t: rec.t,
        group: entry,
        target: hit,
        input_preview: rec.input_preview,
      };
    }
  }
}

if (total === 0) {
  console.log(JSON.stringify({ wakeAgent: false }));
  process.exit(0);
}

console.log(
  JSON.stringify({
    wakeAgent: true,
    data: {
      total,
      byGroup,
      first,
      cutoffUtc: new Date(cutoff).toISOString(),
    },
  }),
);
