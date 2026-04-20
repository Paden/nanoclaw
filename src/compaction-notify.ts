import { Channel, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { findChannel } from './router.js';

export interface CompactionNotifyParams {
  sourceFolder: string;
  peakInputTokens: number;
  summaryWords: number;
  registeredGroups: Record<string, RegisteredGroup>;
  channels: Channel[];
}

export async function notifyOvermindOfCompaction(
  params: CompactionNotifyParams,
): Promise<void> {
  const {
    sourceFolder,
    peakInputTokens,
    summaryWords,
    registeredGroups,
    channels,
  } = params;

  const overmindJid = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === 'discord_overmind',
  )?.[0];

  if (!overmindJid) {
    logger.warn(
      { group: sourceFolder },
      'Compaction notification skipped: discord_overmind not registered',
    );
    return;
  }

  const ch = findChannel(channels, overmindJid);
  if (!ch) {
    logger.warn(
      { group: sourceFolder, overmindJid },
      'Compaction notification skipped: no channel owns overmindJid',
    );
    return;
  }

  const tokensK = Math.round(peakInputTokens / 1000);
  const msg = `📦 **Compaction** — \`${sourceFolder}\` hit ${tokensK}K tokens → session reset (${summaryWords}-word summary saved)`;

  try {
    await ch.sendMessage(overmindJid, msg);
  } catch (err) {
    logger.warn(
      { err, group: sourceFolder },
      'Failed to send compaction notification',
    );
  }
}
