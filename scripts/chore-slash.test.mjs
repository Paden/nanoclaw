import { describe, it, expect, vi } from 'vitest';

import { runChoreCardHook } from './chore-slash.mjs';

describe('runChoreCardHook', () => {
  it('skips when no chore was newly logged', async () => {
    const buildStatusCardFn = vi.fn();
    const writeIpcMessageFn = vi.fn();
    const out = await runChoreCardHook({
      token: 'fake',
      results: [{ chore_id: 'a', name: 'A', skipped: 'already_done' }],
      buildStatusCardFn,
      writeIpcMessageFn,
    });
    expect(out.skipped).toBe('no_newly_done');
    expect(buildStatusCardFn).not.toHaveBeenCalled();
    expect(writeIpcMessageFn).not.toHaveBeenCalled();
  });

  it('rebuilds and posts an edit_message IPC on a successful submit', async () => {
    const buildStatusCardFn = vi.fn().mockResolvedValue({ discord: 'CARD TEXT' });
    const writeIpcMessageFn = vi.fn().mockResolvedValue('/tmp/x.json');
    const out = await runChoreCardHook({
      token: 'fake',
      results: [{ chore_id: 'a', name: 'A', xp: 5, status: 'on-time' }],
      buildStatusCardFn,
      writeIpcMessageFn,
    });
    expect(out.updated).toBe(true);
    expect(buildStatusCardFn).toHaveBeenCalledWith({ token: 'fake' });
    expect(writeIpcMessageFn).toHaveBeenCalledOnce();
    const [group, msg] = writeIpcMessageFn.mock.calls[0];
    expect(group).toBe('discord_silverthorne');
    expect(msg.type).toBe('edit_message');
    expect(msg.label).toBe('status_card');
    expect(msg.chatJid).toBe('dc:1490895684789075968');
    expect(msg.text).toBe('CARD TEXT');
  });

  it('returns updated=false with the error when buildStatusCard throws', async () => {
    const buildStatusCardFn = vi.fn().mockRejectedValue(new Error('sheets dead'));
    const writeIpcMessageFn = vi.fn();
    const out = await runChoreCardHook({
      token: 'fake',
      results: [{ chore_id: 'a', name: 'A', xp: 5, status: 'on-time' }],
      buildStatusCardFn,
      writeIpcMessageFn,
    });
    expect(out.updated).toBe(false);
    expect(out.error).toContain('sheets dead');
    expect(writeIpcMessageFn).not.toHaveBeenCalled();
  });

  it('returns updated=false with the error when writeIpcMessage throws', async () => {
    const buildStatusCardFn = vi.fn().mockResolvedValue({ discord: 'CARD' });
    const writeIpcMessageFn = vi.fn().mockRejectedValue(new Error('disk full'));
    const out = await runChoreCardHook({
      token: 'fake',
      results: [{ chore_id: 'a', name: 'A', xp: 5, status: 'on-time' }],
      buildStatusCardFn,
      writeIpcMessageFn,
    });
    expect(out.updated).toBe(false);
    expect(out.error).toContain('disk full');
  });

  it('treats a partial bundle (some xp, some skipped) as newly_done', async () => {
    const buildStatusCardFn = vi.fn().mockResolvedValue({ discord: 'CARD' });
    const writeIpcMessageFn = vi.fn().mockResolvedValue('/tmp/x.json');
    const out = await runChoreCardHook({
      token: 'fake',
      results: [
        { chore_id: 'a', name: 'A', skipped: 'already_done' },
        { chore_id: 'b', name: 'B', xp: 3, status: 'on-time' },
      ],
      buildStatusCardFn,
      writeIpcMessageFn,
    });
    expect(out.updated).toBe(true);
    expect(writeIpcMessageFn).toHaveBeenCalledOnce();
  });
});
