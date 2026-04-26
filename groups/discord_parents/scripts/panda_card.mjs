// panda_card.mjs — render the pinned `panda_heart` card for partial state.
//
// Used by scripts/qotd-slash.mjs after each /qotd answer when only one
// partner has answered (or the partial state changed). Full reveals are
// authored by the agent because they need theatrical prose; the partial
// card is mechanical and ships from the host.
//
// Format mirrors the historical agent-authored card (see logs/tool-calls.jsonl):
//
//   💌 PANDA — Day {N} · {phase}
//   Today's question:
//   "{question text}"
//
//     Paden  💭 ✅ answered    (or ⏳ waiting)
//     Brenda 💭 ✅ answered    (or ⏳ waiting)
//
//   ─────────────────
//   🗺️ Love Map: {count} entries
//   Last reveal: {date}

function formatPhase(phase) {
  if (!phase) return '';
  if (phase === '36_questions') return '36 Questions';
  if (phase === 'daily_pulse') return 'Daily Pulse';
  return phase;
}

function statusLine(name, answered) {
  const status = answered ? '✅ answered' : '⏳ waiting';
  return `  ${name.padEnd(7)}💭 ${status}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  // Expect either ISO timestamp or YYYY-MM-DD; render as YYYY-MM-DD.
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // sv-SE → "YYYY-MM-DD HH:MM:SS"; we just want the date piece.
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  } catch {
    return iso;
  }
}

// buildPandaPartialCard({ qNum, question, padenAnswered, brendaAnswered,
//                        day, phase, loveMapCount, lastRevealAt })
// Returns the full card body (string).
export function buildPandaPartialCard({
  qNum,
  question,
  padenAnswered,
  brendaAnswered,
  day,
  phase,
  loveMapCount,
  lastRevealAt,
} = {}) {
  void qNum; // qNum isn't shown in the card per the spec — kept for future use.
  const phaseStr = formatPhase(phase);
  const headerRight = phaseStr ? ` · ${phaseStr}` : '';
  const dayStr = day != null ? `Day ${day}` : 'Day ?';

  const lines = [`💌 PANDA — ${dayStr}${headerRight}`];
  lines.push(`Today's question:`);
  lines.push(`"${question || ''}"`);
  lines.push('');
  lines.push(statusLine('Paden', !!padenAnswered));
  lines.push(statusLine('Brenda', !!brendaAnswered));
  lines.push('');
  lines.push('─────────────────');
  const count = Number.isFinite(loveMapCount) ? loveMapCount : 0;
  lines.push(`🗺️ Love Map: ${count} entries`);
  lines.push(`Last reveal: ${formatDate(lastRevealAt)}`);

  return lines.join('\n');
}
