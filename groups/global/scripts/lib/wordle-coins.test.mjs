import { describe, it, expect, beforeEach } from 'bun:test';
import { getBalance, deposit, withdraw, setBalance, COIN_CAP } from './wordle-coins.mjs';

// In-memory sheet mock — two tabs.
function makeSheetMock(initial = {}) {
  const coins = {
    // row 0 = header, then one row per player
    rows: [
      ['player', 'balance', 'last_updated', 'last_event_id'],
      ['Paden', String(initial.Paden ?? 2), '2026-05-23T00:00:00Z', 'seed'],
      ['Brenda', String(initial.Brenda ?? 2), '2026-05-23T00:00:00Z', 'seed'],
      ['Danny', String(initial.Danny ?? 2), '2026-05-23T00:00:00Z', 'seed'],
    ],
  };
  const log = { rows: [['timestamp', 'player', 'delta', 'reason', 'new_balance', 'event_id']] };

  return {
    coins,
    log,
    deps: {
      tokenFn: async () => 'fake-token',
      readRangeFn: async (_sheetId, range) => {
        if (range.startsWith('Wordle Coins!')) return coins.rows;
        if (range.startsWith('Wordle Coins Log!')) return log.rows;
        throw new Error(`unexpected range: ${range}`);
      },
      updateRangeFn: async (_sheetId, range, values) => {
        // range like "Wordle Coins!A2:D2"
        const m = range.match(/Wordle Coins!A(\d+):D\d+/);
        if (!m) throw new Error(`unexpected update range: ${range}`);
        coins.rows[Number(m[1]) - 1] = values[0];
      },
      appendRowsFn: async (_sheetId, range, values) => {
        if (range.startsWith('Wordle Coins Log!')) {
          for (const row of values) log.rows.push(row);
          return;
        }
        throw new Error(`unexpected append range: ${range}`);
      },
    },
  };
}

describe('wordle-coins', () => {
  describe('COIN_CAP', () => {
    it('is 10', () => {
      expect(COIN_CAP).toBe(10);
    });
  });

  describe('getBalance', () => {
    it('reads the current balance for a known player', async () => {
      const { deps } = makeSheetMock({ Brenda: 7 });
      expect(await getBalance('Brenda', deps)).toBe(7);
    });

    it('returns 0 for an unknown player', async () => {
      const { deps } = makeSheetMock();
      expect(await getBalance('Unknown', deps)).toBe(0);
    });
  });

  describe('deposit', () => {
    it('increments balance by 1', async () => {
      const { deps } = makeSheetMock({ Paden: 3 });
      const next = await deposit('Paden', 'chore-abc', 'chore:abc', deps);
      expect(next).toBe(4);
      expect(await getBalance('Paden', deps)).toBe(4);
    });

    it('caps at COIN_CAP', async () => {
      const { deps } = makeSheetMock({ Paden: 10 });
      const next = await deposit('Paden', 'chore-xyz', 'chore:xyz', deps);
      expect(next).toBe(10);
    });

    it('is idempotent when eventId matches last_event_id', async () => {
      const { deps } = makeSheetMock({ Brenda: 5 });
      const first = await deposit('Brenda', 'chore-dup', 'chore:dup', deps);
      const second = await deposit('Brenda', 'chore-dup', 'chore:dup', deps);
      expect(first).toBe(6);
      expect(second).toBe(6); // unchanged
    });

    it('appends a row to Wordle Coins Log', async () => {
      const { deps, log } = makeSheetMock({ Danny: 0 });
      await deposit('Danny', 'chore-1', 'chore:1', deps);
      // header + one entry
      expect(log.rows.length).toBe(2);
      expect(log.rows[1][1]).toBe('Danny');
      expect(log.rows[1][2]).toBe('+1');
      expect(log.rows[1][3]).toBe('chore:1');
      expect(log.rows[1][4]).toBe('1');
    });
  });

  describe('withdraw', () => {
    it('decrements balance by 1', async () => {
      const { deps } = makeSheetMock({ Brenda: 5 });
      const next = await withdraw('Brenda', 'wordle-1', 'wordle:1', deps);
      expect(next).toBe(4);
    });

    it('throws when balance is 0', async () => {
      const { deps } = makeSheetMock({ Danny: 0 });
      await expect(withdraw('Danny', 'wordle-1', 'wordle:1', deps)).rejects.toThrow(/insufficient/i);
    });

    it('is idempotent when eventId matches last_event_id', async () => {
      const { deps } = makeSheetMock({ Brenda: 5 });
      const first = await withdraw('Brenda', 'wordle-dup', 'wordle:dup', deps);
      const second = await withdraw('Brenda', 'wordle-dup', 'wordle:dup', deps);
      expect(first).toBe(4);
      expect(second).toBe(4);
    });
  });

  describe('setBalance', () => {
    it('overwrites balance and logs a manual reason', async () => {
      const { deps, log } = makeSheetMock({ Paden: 3 });
      await setBalance('Paden', 8, 'vacation grant', deps);
      expect(await getBalance('Paden', deps)).toBe(8);
      expect(log.rows[1][3]).toBe('manual:vacation grant');
    });

    it('clamps to 0..COIN_CAP', async () => {
      const { deps } = makeSheetMock();
      await setBalance('Paden', 999, 'test', deps);
      expect(await getBalance('Paden', deps)).toBe(10);
      await setBalance('Paden', -5, 'test', deps);
      expect(await getBalance('Paden', deps)).toBe(0);
    });
  });
});
