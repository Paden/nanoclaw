// Pure formatter for /qotd-status. Renders the open-Q list as an ephemeral
// reply so the user can see which days they still owe answers for.
//
// Input shape mirrors scripts/qotd-status-slash.mjs output.

export interface QotdOpenQ {
  qNum: number;
  day: number;
  date: string; // YYYY-MM-DD, assumed America/Chicago
  question: string;
}

export interface QotdStatusReplyInput {
  status: string; // 'status' | 'error'
  message?: string;
  currentQNum?: number;
  currentDay?: number;
  today?: string; // YYYY-MM-DD
  open?: QotdOpenQ[];
  skippedOpen?: QotdOpenQ[];
  totalAnswered?: number;
}

const MAX_ITEMS = 12; // keep reply under Discord's 2000-char limit
const QUESTION_TRUNCATE = 200; // per-question soft cap

// "Mon Apr 14" from a YYYY-MM-DD string. Uses UTC to stay stable across hosts.
export function formatDateLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

function renderQList(open: QotdOpenQ[], today: string | undefined): string[] {
  const shown = open.slice(0, MAX_ITEMS);
  const remaining = open.length - shown.length;
  const lines: string[] = [];
  for (const q of shown) {
    const dateLabel = formatDateLabel(q.date);
    const isToday = today && q.date === today;
    const dayMark = isToday ? `${dateLabel} (today)` : dateLabel;
    lines.push(`**Day ${q.day}** · ${dayMark} — Q${q.qNum}`);
    lines.push(`> ${truncate(q.question, QUESTION_TRUNCATE)}`);
    lines.push('');
  }
  if (remaining > 0) {
    lines.push(`…plus ${remaining} more.`);
    lines.push('');
  }
  return lines;
}

export function formatQotdStatusReply(r: QotdStatusReplyInput): string {
  if (r.status !== 'status') {
    return r.message || `(${r.status})`;
  }
  const open = r.open ?? [];
  const skippedOpen = r.skippedOpen ?? [];
  const today = r.today;

  if (open.length === 0 && skippedOpen.length === 0) {
    return `💌 All caught up — no panda questions waiting for you.`;
  }

  const lines: string[] = [];

  if (open.length > 0) {
    const header =
      open.length === 1
        ? `💌 1 panda question waiting for you:`
        : `💌 ${open.length} panda questions waiting for you:`;
    lines.push(header, '');
    lines.push(...renderQList(open, today));
  } else {
    lines.push('💌 All caught up on current questions.', '');
  }

  if (skippedOpen.length > 0) {
    lines.push('---');
    lines.push('📝 Skipped days — answer if you want:');
    lines.push('');
    lines.push(...renderQList(skippedOpen, today));
  }

  lines.push('Use `/qotd <answer>` to catch up.');
  return lines.join('\n');
}
