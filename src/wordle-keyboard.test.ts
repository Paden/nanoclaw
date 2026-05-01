import { describe, it, expect } from 'vitest';
import {
  accumulateLetterStates,
  renderKeyboard,
  renderGuessStack,
  formatWordleReply,
  formatWordleStatusReply,
} from './wordle-keyboard.js';

describe('accumulateLetterStates', () => {
  it('maps each guessed letter to its best state across guesses', () => {
    const states = accumulateLetterStates([
      { guess: 'CAMPS', grid: '⬜🟨⬜🟩⬜' },
    ]);
    expect(states.get('C')).toBe('miss');
    expect(states.get('A')).toBe('yellow');
    expect(states.get('M')).toBe('miss');
    expect(states.get('P')).toBe('green');
    expect(states.get('S')).toBe('miss');
    expect(states.get('Q')).toBeUndefined();
  });

  it('upgrades a letter from miss/yellow to green across guesses', () => {
    const states = accumulateLetterStates([
      { guess: 'CRANE', grid: '⬜⬜🟨⬜⬜' },
      { guess: 'PIANO', grid: '⬜⬜🟩⬜⬜' },
    ]);
    // A was yellow on guess 1, green on guess 2 → should end green.
    expect(states.get('A')).toBe('green');
  });

  it('does not downgrade a green letter', () => {
    const states = accumulateLetterStates([
      { guess: 'PLATE', grid: '🟩⬜⬜⬜⬜' },
      { guess: 'PIANO', grid: '⬜⬜⬜⬜⬜' },
    ]);
    expect(states.get('P')).toBe('green');
  });
});

describe('renderKeyboard', () => {
  it('renders all three QWERTY rows with appropriate markdown per letter', () => {
    const kb = renderKeyboard([{ guess: 'CAMPS', grid: '🟩🟨⬜⬜⬜' }]);
    const rows = kb.split('\n');
    expect(rows).toHaveLength(3);
    // C green → **C**
    expect(rows[2]).toContain('**C**');
    // A yellow → *A*
    expect(rows[1]).toContain('*A*');
    // M/S miss → spoiler
    expect(rows[2]).toContain('||M||');
    expect(rows[0]).toContain('||P||'); // P also miss
    // Q untouched → bare letter, no markdown around it
    expect(rows[0].split(' ')).toContain('Q');
  });
});

describe('renderGuessStack', () => {
  it('one row per guess, emoji grid then codeblock of uppercase word', () => {
    const stack = renderGuessStack([
      { guess: 'camps', grid: '🟩🟨⬜⬜⬜' },
      { guess: 'tangy', grid: '⬜🟨🟨⬜🟩' },
    ]);
    expect(stack.split('\n')).toEqual([
      '🟩🟨⬜⬜⬜ `CAMPS`',
      '⬜🟨🟨⬜🟩 `TANGY`',
    ]);
  });
});

describe('formatWordleReply', () => {
  it('returns only the message for non-scored statuses', () => {
    expect(
      formatWordleReply({ status: 'invalid', message: 'not in dictionary' }),
    ).toBe('not in dictionary');
  });

  it('builds full stack + keyboard + solved footer on solve', () => {
    const reply = formatWordleReply({
      status: 'scored',
      history: [
        { guess: 'CRANE', grid: '⬜⬜⬜⬜⬜' },
        { guess: 'PLUMB', grid: '🟩🟩🟩🟩🟩' },
      ],
      solved: true,
      guess_num: 2,
      budget: 6,
    });
    expect(reply).toContain('`CRANE`');
    expect(reply).toContain('`PLUMB`');
    expect(reply).toContain('🎉 Solved in 2/6.');
    // Keyboard bold for all PLUMB letters
    expect(reply).toContain('**P**');
    expect(reply).toContain('**L**');
    expect(reply).toContain('**U**');
    expect(reply).toContain('**M**');
    expect(reply).toContain('**B**');
  });

  it('reveals word on budget exhaustion', () => {
    const reply = formatWordleReply({
      status: 'scored',
      history: [{ guess: 'CRANE', grid: '⬜⬜⬜⬜⬜' }],
      solved: false,
      guess_num: 6,
      budget: 6,
      word: 'FORGE',
    });
    expect(reply).toContain('The word was **FORGE**');
  });
});

describe('formatWordleStatusReply', () => {
  it('returns the message for non-status results', () => {
    expect(
      formatWordleStatusReply({
        status: 'no_puzzle',
        message: "Today's puzzle isn't published yet.",
      }),
    ).toBe("Today's puzzle isn't published yet.");
  });

  it('tells player to start when no guesses yet', () => {
    const reply = formatWordleStatusReply({
      status: 'status',
      history: [],
      budget: 6,
      solved: false,
    });
    expect(reply).toContain('No guesses yet today');
    expect(reply).toContain('6 tries');
    expect(reply).toContain('`/wordle`');
  });

  it('shows stack + keyboard + remaining count mid-game', () => {
    const reply = formatWordleStatusReply({
      status: 'status',
      history: [
        { guess: 'CRANE', grid: '⬜🟨⬜⬜⬜' },
        { guess: 'PIANO', grid: '⬜⬜🟩⬜⬜' },
      ],
      budget: 6,
      solved: false,
    });
    expect(reply).toContain('`CRANE`');
    expect(reply).toContain('`PIANO`');
    expect(reply).toContain('2/6 guesses used — 4 left.');
    // A upgraded yellow→green across guesses
    expect(reply).toContain('**A**');
  });

  it('shows solved footer when player has already won', () => {
    const reply = formatWordleStatusReply({
      status: 'status',
      history: [
        { guess: 'CRANE', grid: '⬜⬜⬜⬜⬜' },
        { guess: 'PLUMB', grid: '🟩🟩🟩🟩🟩' },
      ],
      budget: 6,
      solved: true,
    });
    expect(reply).toContain('🎉 Solved in 2/6.');
  });

  it('reveals word when player busted out', () => {
    const reply = formatWordleStatusReply({
      status: 'status',
      history: Array.from({ length: 6 }, () => ({
        guess: 'CRANE',
        grid: '⬜⬜⬜⬜⬜',
      })),
      budget: 6,
      solved: false,
      word: 'FORGE',
    });
    expect(reply).toContain('The word was **FORGE**');
  });
});
