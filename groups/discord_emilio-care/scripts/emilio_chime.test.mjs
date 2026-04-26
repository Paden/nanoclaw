// groups/discord_emilio-care/scripts/emilio_chime.test.mjs
import { describe, it, expect } from 'vitest';
import { pickChime, parsePools } from './emilio_chime.mjs';

const SAMPLE_VOICE_MD = `
### Feed
- \`nom nom\`
- \`mmm milk\`
- \`glug glug\`

### Nap start
- \`nini mama\`
- \`zzz goo\`

### Wake
- \`ouuu awake\`
- \`hi mama\`

### General
- \`goo\`
- \`mama 💛\`
`;

describe('parsePools', () => {
  it('extracts pools from markdown ###/- entries', () => {
    const pools = parsePools(SAMPLE_VOICE_MD);
    expect(pools.feed).toEqual(['nom nom', 'mmm milk', 'glug glug']);
    expect(pools.nap_start).toEqual(['nini mama', 'zzz goo']);
    expect(pools.wake).toEqual(['ouuu awake', 'hi mama']);
    expect(pools.general).toEqual(['goo', 'mama 💛']);
  });
});

describe('pickChime', () => {
  const pools = {
    feed: ['nom nom', 'mmm milk', 'glug glug'],
    wake: ['ouuu awake', 'hi mama'],
    nap_start: ['nini mama', 'zzz goo'],
    general: ['goo'],
  };

  it('picks from the right pool', () => {
    const r = pickChime('feed', pools, { last: {} });
    expect(['nom nom', 'mmm milk', 'glug glug']).toContain(r.text);
  });

  it('avoids the last-picked line for that event', () => {
    const r = pickChime('feed', pools, { last: { feed: 'nom nom' } });
    expect(r.text).not.toBe('nom nom');
  });

  it('falls back to feed pool for feeding_update', () => {
    const r = pickChime('feeding_update', pools, { last: {} });
    expect(['nom nom', 'mmm milk', 'glug glug']).toContain(r.text);
  });

  it('falls back to general when pool is missing or single-element + same as last', () => {
    // Wake pool has only 2; if both have been used, fallback to general
    const r = pickChime('wake', { wake: ['ouuu awake'], general: ['goo'] }, { last: { wake: 'ouuu awake' } });
    expect(r.text).toBe('goo');
  });

  it('updates state with the picked line', () => {
    const r = pickChime('nap_start', pools, { last: { nap_start: 'nini mama' } });
    expect(r.newState.last.nap_start).toBe(r.text);
  });

  it('filters mom-addressed lines when dad logs', () => {
    const dadPools = {
      feed: ['nom nom', 'yummy mama', 'mmm milk'],
    };
    for (let i = 0; i < 30; i++) {
      const r = pickChime('feed', dadPools, { last: {} }, { parentRole: 'dad' });
      expect(r.text).not.toBe('yummy mama');
    }
  });

  it('filters dad-addressed lines when mom logs', () => {
    const momPools = {
      nap_start: ['zzz goo', 'nini dada', 'sleeeepy'],
    };
    for (let i = 0; i < 30; i++) {
      const r = pickChime('nap_start', momPools, { last: {} }, { parentRole: 'mom' });
      expect(r.text).not.toBe('nini dada');
    }
  });

  it('filters both parent words when parentRole is null (sibling)', () => {
    const mixedPools = {
      general: ['mama 💛', 'dada!', 'goo', 'papá 💛'],
    };
    for (let i = 0; i < 30; i++) {
      const r = pickChime('general', mixedPools, { last: {} }, { parentRole: null });
      expect(r.text).toBe('goo');
    }
  });

  it('falls back to unfiltered pool when filter empties everything', () => {
    const pools = { feed: ['yummy mama', 'milky mama'] };
    const r = pickChime('feed', pools, { last: {} }, { parentRole: 'dad' });
    expect(['yummy mama', 'milky mama']).toContain(r.text);
  });

  it('skips parent filtering when no parentRole opt provided', () => {
    const pools = { feed: ['yummy mama'] };
    const r = pickChime('feed', pools, { last: {} });
    expect(r.text).toBe('yummy mama');
  });
});
