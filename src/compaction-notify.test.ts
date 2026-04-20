import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { notifyOvermindOfCompaction } from './compaction-notify.js';
import { logger } from './logger.js';
import type { Channel, RegisteredGroup } from './types.js';

const OVERMIND_JID = 'dc:1491554631413665872';
const OTHER_JID = 'dc:9999999999999999999';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: 'discord',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    ownsJid: (jid: string) => jid.startsWith('dc:'),
    ...overrides,
  };
}

function makeRegisteredGroups(
  entries: Record<string, string>,
): Record<string, RegisteredGroup> {
  const out: Record<string, RegisteredGroup> = {};
  for (const [jid, folder] of Object.entries(entries)) {
    out[jid] = {
      name: folder,
      folder,
      trigger: '@Andy',
      added_at: '2026-04-20T00:00:00Z',
    };
  }
  return out;
}

describe('notifyOvermindOfCompaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a formatted message when overmind is registered and channel is available', async () => {
    const ch = makeChannel();
    await notifyOvermindOfCompaction({
      sourceFolder: 'discord_emilio-care',
      peakInputTokens: 152_345,
      summaryWords: 1234,
      registeredGroups: makeRegisteredGroups({
        [OVERMIND_JID]: 'discord_overmind',
        [OTHER_JID]: 'discord_emilio-care',
      }),
      channels: [ch],
    });

    expect(ch.sendMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = (ch.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(jid).toBe(OVERMIND_JID);
    expect(msg).toContain('📦');
    expect(msg).toContain('discord_emilio-care');
    expect(msg).toContain('152K tokens');
    expect(msg).toContain('1234-word');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and skips when discord_overmind is not registered', async () => {
    const ch = makeChannel();
    await notifyOvermindOfCompaction({
      sourceFolder: 'discord_emilio-care',
      peakInputTokens: 150_000,
      summaryWords: 500,
      registeredGroups: makeRegisteredGroups({
        [OTHER_JID]: 'discord_emilio-care',
      }),
      channels: [ch],
    });

    expect(ch.sendMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { group: 'discord_emilio-care' },
      'Compaction notification skipped: discord_overmind not registered',
    );
  });

  it('warns and skips when no channel owns the overmind jid', async () => {
    const nonDiscord = makeChannel({
      name: 'whatsapp',
      ownsJid: (jid: string) => jid.endsWith('@g.us'),
    });
    await notifyOvermindOfCompaction({
      sourceFolder: 'discord_silverthorne',
      peakInputTokens: 150_000,
      summaryWords: 500,
      registeredGroups: makeRegisteredGroups({
        [OVERMIND_JID]: 'discord_overmind',
      }),
      channels: [nonDiscord],
    });

    expect(nonDiscord.sendMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { group: 'discord_silverthorne', overmindJid: OVERMIND_JID },
      'Compaction notification skipped: no channel owns overmindJid',
    );
  });

  it('warns when sendMessage rejects', async () => {
    const err = new Error('discord API 500');
    const ch = makeChannel({
      sendMessage: vi.fn().mockRejectedValue(err),
    });

    await notifyOvermindOfCompaction({
      sourceFolder: 'discord_dms_paden',
      peakInputTokens: 150_000,
      summaryWords: 500,
      registeredGroups: makeRegisteredGroups({
        [OVERMIND_JID]: 'discord_overmind',
      }),
      channels: [ch],
    });

    expect(ch.sendMessage).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err, group: 'discord_dms_paden' },
      'Failed to send compaction notification',
    );
  });
});
