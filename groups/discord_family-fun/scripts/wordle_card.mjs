// wordle_card.mjs — render the pinned Saga Wordle progress card.
//
// Counts only — never tiles or letters. The reveal post (separate flow,
// agent-authored) is the only place letters appear before day resolution.
//
// Used by scripts/wordle-slash.mjs after each guess: takes the gate's
// summary + the persisted leaderboard and emits the card body to pin.

const PETS = {
  Paden: { emoji: '🌋', name: 'Voss' },
  Brenda: { emoji: '🌙', name: 'Nyx' },
  Danny: { emoji: '❄️', name: 'Zima' },
};

const PLAYER_ORDER = ['Paden', 'Brenda', 'Danny'];

function formatProgress({ guesses, solved, done }) {
  if (solved) return `${guesses}/6 ✅`;
  if (done) return `${guesses}/6 ❌`;
  if (guesses === 0) return 'not started';
  if (guesses === 1) return '1 guess';
  return `${guesses} guesses`;
}

function formatDate(dateStr) {
  // YYYY-MM-DD → "Apr 25"
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return dateStr;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}`;
}

function leaderboardLines(leaderboard) {
  if (!leaderboard || typeof leaderboard !== 'object') return [];
  return PLAYER_ORDER
    .filter((p) => leaderboard[p])
    .map((p) => {
      const stats = leaderboard[p];
      const wins = stats.wins ?? 0;
      const streak = stats.streak ?? 0;
      const avg = stats.avg_guesses != null ? stats.avg_guesses.toFixed(2) : '—';
      return `  ${p.padEnd(7)}${wins} wins · streak ${streak} · avg ${avg}`;
    });
}

// buildWordleCardText({ summary, day, genre, leaderboard, dateStr })
// Returns the full card body (string).
export function buildWordleCardText({ summary, day, genre, leaderboard, dateStr } = {}) {
  const dayStr = day != null ? `Day ${day}` : 'Day ?';
  const dateLine = [formatDate(dateStr), genre ? `Genre: ${genre}` : null]
    .filter(Boolean)
    .join(' · ');

  const playerLines = PLAYER_ORDER.map((p) => {
    const pet = PETS[p];
    const s = summary?.[p] ?? { guesses: 0, solved: false, done: false };
    const progress = formatProgress(s);
    return `  ${p.padEnd(7)}${pet.emoji} ${pet.name.padEnd(6)} ${progress}`;
  });

  const lb = leaderboardLines(leaderboard);

  const lines = [
    `🎯 SAGA WORDLE — ${dayStr}`,
  ];
  if (dateLine) lines.push(dateLine);
  lines.push('');
  lines.push(...playerLines);
  if (lb.length) {
    lines.push('');
    lines.push('─────────────────');
    lines.push('🏆 All-time');
    lines.push(...lb);
  }

  return lines.join('\n');
}
