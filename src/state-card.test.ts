import { describe, it, expect } from 'vitest';
import { stripCard, fitDiscordReply } from './state-card.js';

describe('stripCard', () => {
  it('returns input unchanged when no AGENT REF marker is present', () => {
    const out = '🍼 Emilio today\n• 4oz formula 09:00\n• nap since 10:30';
    expect(stripCard(out)).toBe(out);
  });

  it('cuts the AGENT REF section and trailing whitespace', () => {
    const out =
      '🍼 Emilio today\n• 4oz formula 09:00\n\n═══ AGENT REF ═══\nrow 5: ...\nrow 6: ...';
    expect(stripCard(out)).toBe('🍼 Emilio today\n• 4oz formula 09:00');
  });

  it('trims trailing whitespace even without the marker', () => {
    expect(stripCard('card\n\n\n')).toBe('card');
  });
});

describe('fitDiscordReply', () => {
  it('returns text unchanged when under the cap', () => {
    expect(fitDiscordReply('short')).toBe('short');
  });

  it('truncates and marks when text exceeds the cap', () => {
    const big = 'x'.repeat(2500);
    const out = fitDiscordReply(big);
    expect(out.length).toBeLessThanOrEqual(1900 + '\n… (truncated)'.length);
    expect(out.endsWith('(truncated)')).toBe(true);
  });
});
