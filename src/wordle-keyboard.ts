// Pure formatters for the /wordle slash command reply.
//
// Inputs come from scoreGuessForPlayer: `history` is an array of
// `{ guess, grid }` where grid is a 5-emoji string (🟩/🟨/⬜).
//
// The reply has two parts:
//   1. Guess stack — one row per guess, emoji grid + the guessed word
//   2. QWERTY keyboard — per-letter state folded across all of today's guesses
//
// Keyboard letter states (best-of across all guesses today):
//   green  → **L** (bold)
//   yellow → *L*  (italic)
//   miss   → ||L|| (spoiler — hidden until clicked, so misses don't clutter the row)
//   unused → L    (plain)

export type LetterState = 'green' | 'yellow' | 'miss' | 'unused';

export interface WordleHistoryEntry {
  guess: string;
  grid: string; // "🟩🟨⬜⬜🟩" — always 5 emoji codepoints
}

const QWERTY_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];

// Priority: green > yellow > miss > unused. Upgrading a letter from miss to
// yellow (a later guess puts it in a different spot) is legitimate — Wordle's
// own app behaves the same way.
const PRIORITY: Record<LetterState, number> = {
  green: 3,
  yellow: 2,
  miss: 1,
  unused: 0,
};

function emojiToState(cell: string): LetterState {
  if (cell === '🟩') return 'green';
  if (cell === '🟨') return 'yellow';
  return 'miss';
}

export function accumulateLetterStates(
  history: WordleHistoryEntry[],
): Map<string, LetterState> {
  const states = new Map<string, LetterState>();
  for (const entry of history) {
    const cells = Array.from(entry.grid); // codepoints, handles surrogate pairs
    const letters = entry.guess.toUpperCase().split('');
    for (let i = 0; i < letters.length; i++) {
      const letter = letters[i];
      if (!/^[A-Z]$/.test(letter)) continue;
      const newState = emojiToState(cells[i] ?? '');
      const prev = states.get(letter) ?? 'unused';
      if (PRIORITY[newState] > PRIORITY[prev]) {
        states.set(letter, newState);
      }
    }
  }
  return states;
}

export function renderKeyboard(history: WordleHistoryEntry[]): string {
  const states = accumulateLetterStates(history);
  const lines: string[] = [];
  for (const row of QWERTY_ROWS) {
    const rendered = row
      .split('')
      .map((letter) => {
        const state = states.get(letter) ?? 'unused';
        if (state === 'green') return `**${letter}**`;
        if (state === 'yellow') return `*${letter}*`;
        if (state === 'miss') return `||${letter}||`;
        return letter;
      })
      .join(' ');
    lines.push(rendered);
  }
  return lines.join('\n');
}

export function renderGuessStack(history: WordleHistoryEntry[]): string {
  return history
    .map((h) => `${h.grid} \`${h.guess.toUpperCase()}\``)
    .join('\n');
}

export interface WordleReplyInput {
  status: string; // 'scored' | 'invalid' | 'duplicate' | 'done' | 'no_puzzle' | 'error'
  message?: string;
  history?: WordleHistoryEntry[];
  solved?: boolean;
  guess_num?: number;
  budget?: number;
  word?: string;
}

export function formatWordleReply(r: WordleReplyInput): string {
  if (r.status !== 'scored') {
    // Non-scoring statuses: just the one-liner explanation.
    return r.message || `(${r.status})`;
  }
  const history = r.history ?? [];
  const parts: string[] = [];
  parts.push(renderGuessStack(history));
  parts.push('');
  parts.push(renderKeyboard(history));
  parts.push('');
  if (r.solved) {
    parts.push(`🎉 Solved in ${r.guess_num}/${r.budget}.`);
  } else if (r.word) {
    parts.push(`Out of guesses. The word was **${r.word}**.`);
  } else {
    parts.push(`Guess ${r.guess_num}/${r.budget}.`);
  }
  return parts.join('\n');
}

export interface WordleStatusReplyInput {
  status: string; // 'status' | 'no_puzzle' | 'error'
  message?: string;
  history?: WordleHistoryEntry[];
  budget?: number;
  solved?: boolean;
  word?: string;
}

export function formatWordleStatusReply(r: WordleStatusReplyInput): string {
  if (r.status !== 'status') {
    return r.message || `(${r.status})`;
  }
  const history = r.history ?? [];
  const budget = r.budget ?? 6;
  const used = history.length;

  if (used === 0) {
    return `No guesses yet today — you have ${budget} tries. Use \`/wordle\` to start.`;
  }

  const parts: string[] = [];
  parts.push(renderGuessStack(history));
  parts.push('');
  parts.push(renderKeyboard(history));
  parts.push('');
  if (r.solved) {
    parts.push(`🎉 Solved in ${used}/${budget}.`);
  } else if (r.word) {
    parts.push(`Out of guesses. The word was **${r.word}**.`);
  } else {
    parts.push(`${used}/${budget} guesses used — ${budget - used} left.`);
  }
  return parts.join('\n');
}
