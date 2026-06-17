import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  Partials,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  AutocompleteInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  TextChannel,
  User,
  Webhook,
} from 'discord.js';

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { ASSISTANT_NAME, DISCORD_REACTIONS_INBOUND, TRIGGER_PATTERN, WEBHOOK_PERSONAS } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { formatWordleReply, formatWordleStatusReply } from '../wordle-keyboard.js';
import { formatQotdStatusReply } from '../qotd-status.js';
import { stripCard, fitDiscordReply } from '../state-card.js';
import { writeIpcTask, writeIpcMessage } from '../ipc-writer.js';
import { buildAvatarPromptMessage } from '../wordle-evolution-prompt.js';
import { buildLastFedSuffix, isNapCloseSubtext, subtextAlreadyEnriched } from '../emilio-feed-context.js';

const execFileAsync = promisify(execFile);

// Per-channel buffer of recently-delivered messages. Used to dedup
// duplicate outbounds Claudio sends within a single turn — exact duplicates
// (chime + bare echo of same text) AND supersets where the next message
// adds another event to the earlier one (e.g. "Logged 3.5oz feeding"
// followed by "Logged 3.5oz feeding and asleep"). For the superset case
// the second message is the more comprehensive one and the first becomes
// redundant — we delete the first from the channel after the second lands.
const RECENT_TEXT_WINDOW_MS = 30 * 1000;
const RECENT_TEXT_MAX_PER_CHANNEL = 5;
interface RecentMessage {
  text: string;
  ts: number;
  platformMsgId: string | null;
}
const recentMessagesByChannel = new Map<string, RecentMessage[]>();

function getRecents(channelId: string): RecentMessage[] {
  const now = Date.now();
  const fresh = (recentMessagesByChannel.get(channelId) || []).filter((r) => now - r.ts < RECENT_TEXT_WINDOW_MS);
  recentMessagesByChannel.set(channelId, fresh);
  return fresh;
}

function shouldDropAsDuplicate(channelId: string, text: string): boolean {
  return getRecents(channelId).some((r) => r.text === text);
}

function firstNWords(text: string, n: number): string {
  return text.trim().split(/\s+/).slice(0, n).join(' ');
}

/**
 * If an earlier short message shares this one's opening phrase and is
 * shorter overall, treat the earlier as a redundant predecessor — caller
 * deletes it after delivering this comprehensive one.
 */
function findSupersetVictim(channelId: string, text: string): RecentMessage | null {
  const prefix = firstNWords(text, 5).toLowerCase();
  if (!prefix) return null;
  for (const r of getRecents(channelId)) {
    if (text.length <= r.text.length) continue;
    if (!r.platformMsgId) continue;
    if (firstNWords(r.text, 5).toLowerCase() === prefix) return r;
  }
  return null;
}

function recordRecentText(channelId: string, text: string, platformMsgId: string | null = null): void {
  const recents = getRecents(channelId);
  recents.push({ text, ts: Date.now(), platformMsgId });
  while (recents.length > RECENT_TEXT_MAX_PER_CHANNEL) recents.shift();
  recentMessagesByChannel.set(channelId, recents);
}

function forgetRecent(channelId: string, platformMsgId: string): void {
  const recents = (recentMessagesByChannel.get(channelId) || []).filter((r) => r.platformMsgId !== platformMsgId);
  recentMessagesByChannel.set(channelId, recents);
}

// Per-channel record of the most recent inbound sender. Used by the
// emilio-care adapter to fix Claudio's wrong-attribution bug (he defaults
// to "Paden" in the chime subtext regardless of who actually posted). We
// rewrite the subtext name to match the actual sender, and strip the
// chime entirely when the sender isn't a household parent.
const lastInboundByChannel = new Map<string, { senderName: string; ts: number }>();
const ATTRIBUTION_WINDOW_MS = 90 * 1000;
const EMILIO_HOUSEHOLD = new Set(['Paden', 'Brenda', 'Danny']);
// Map Discord user IDs → canonical household name. Display names like
// "Br3nd9" don't match the EMILIO_HOUSEHOLD set ("Brenda"), so every
// Brenda message was triggering the non-household chime suppression
// (seen 2026-06-02: every chime subtext logged as suppressed even
// though Brenda IS household). Resolve to canonical at record time.
const HOUSEHOLD_BY_DISCORD_ID: Record<string, string> = {
  '181867944404320256': 'Paden',
  '350815183804825600': 'Brenda',
  '280744944358916097': 'Danny',
};

function recordInboundSender(channelId: string, senderName: string, discordUserId?: string): void {
  if (!senderName) return;
  const canonical = discordUserId && HOUSEHOLD_BY_DISCORD_ID[discordUserId];
  lastInboundByChannel.set(channelId, { senderName: canonical || senderName, ts: Date.now() });
}

function getRecentInboundSender(channelId: string): string | null {
  const hit = lastInboundByChannel.get(channelId);
  if (!hit) return null;
  if (Date.now() - hit.ts > ATTRIBUTION_WINDOW_MS) return null;
  return hit.senderName;
}

// Emoji-name → unicode map for the add_reaction MCP tool. The tool accepts
// names like "thumbs_up" / "eyes" but Discord.js's msg.react() needs the
// actual unicode codepoint. Anything not in this map is passed through
// verbatim in case the agent already supplied unicode.
const REACTION_EMOJI_MAP: Record<string, string> = {
  thumbs_up: '👍',
  thumbs_down: '👎',
  heart: '❤️',
  eyes: '👀',
  check: '✅',
  white_check_mark: '✅',
  x: '❌',
  fire: '🔥',
  tada: '🎉',
  pray: '🙏',
  ok: '👌',
  raised_hands: '🙌',
  clap: '👏',
  rocket: '🚀',
  sparkles: '✨',
  warning: '⚠️',
  question: '❓',
  exclamation: '❗',
  sob: '😭',
  joy: '😂',
  smile: '😄',
  thinking: '🤔',
  wave: '👋',
};

export class DiscordChannel implements ChannelAdapter {
  name = 'discord';
  channelType = 'discord';
  supportsThreads = false;

  private client: Client | null = null;
  private channelSetup: ChannelSetup | null = null;
  private webhookCache = new Map<string, Webhook>();

  // Hardcoded channel ID → group folder map (replaces v1 registeredGroups() lookup)
  private static readonly CHANNEL_FOLDERS: Record<string, string> = {
    '1490764545730285622': 'discord_general',
    '1490781468182577172': 'discord_emilio-care',
    '1490784303662239894': 'discord_parents',
    '1490895684789075968': 'discord_silverthorne',
    '1490924818869260328': 'discord_family-fun',
    '1490945211747274752': 'discord_dms_danny',
    '1490936118135230684': 'discord_dms_paden',
    '1490945206059532378': 'discord_dms_brenda',
    '1491554631413665872': 'discord_overmind',
    '1496166763128160346': 'discord_liquid-gold',
  };

  constructor(private readonly botToken: string) {}

  async setup(config: ChannelSetup): Promise<void> {
    this.channelSetup = config;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.User, Partials.GuildMember, Partials.Reaction],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      log.info('Discord MessageCreate fired', {
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        authorBot: message.author.bot,
        contentLen: message.content.length,
      });
      if (message.author.bot) return;

      // DMs are outbound-only
      if (!message.guild) {
        log.debug('Ignoring inbound DM (outbound-only)', {
          channelId: message.channelId,
          authorId: message.author.id,
        });
        return;
      }

      const channelId = message.channelId;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName = message.member?.displayName || message.author.displayName || message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      const textChannel = message.channel as TextChannel;
      const chatName = `${message.guild!.name} #${textChannel.name}`;

      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) || content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      if (message.attachments.size > 0) {
        // Directive form: spell out that the content isn't accessible so the
        // agent doesn't spin tool calls trying to "see" it. A 2026-05-19
        // image-reply ate ~300 gemini-3-flash requests over 17min before
        // giving up; the curt `[Image: foo.jpg]` form invited that loop.
        const attachmentDescriptions = [...message.attachments.values()].map((att) => {
          const contentType = att.contentType || '';
          const name = att.name || 'attachment';
          if (contentType.startsWith('image/')) {
            return `[image attached: ${name} — you cannot view the image. If you need it, ask the user to paste a direct URL.]`;
          } else if (contentType.startsWith('video/')) {
            return `[video attached: ${name} — you cannot view the video.]`;
          } else if (contentType.startsWith('audio/')) {
            return `[audio attached: ${name} — you cannot play the audio.]`;
          } else {
            return `[file attached: ${name} — you cannot open the file.]`;
          }
        });
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
          const replyAuthor =
            repliedTo.member?.displayName || repliedTo.author.displayName || repliedTo.author.username;
          const repliedText = (repliedTo.content ?? '').replace(/\s+/g, ' ').trim();
          const snippet = repliedText.length > 200 ? `${repliedText.slice(0, 200)}…` : repliedText;
          const quoted = snippet ? ` "${snippet}"` : '';
          content = `[Reply to ${replyAuthor}${quoted}] ${content}`;
        } catch {
          /* Referenced message may have been deleted */
        }
      }

      this.channelSetup?.onMetadata(channelId, chatName, true);

      const channelFolder = DiscordChannel.CHANNEL_FOLDERS[channelId];
      if (!channelFolder) {
        log.debug('Message from unregistered Discord channel', { channelId, chatName });
        return;
      }

      // Detect mention: bot @mentioned OR message starts with trigger pattern (@Claudio)
      const isMention =
        (this.client?.user
          ? message.mentions.users.has(this.client.user.id) ||
            message.content.includes(`<@${this.client.user.id}>`) ||
            message.content.includes(`<@!${this.client.user.id}>`)
          : false) || TRIGGER_PATTERN.test(content);

      this.channelSetup?.onInbound(channelId, null, {
        id: msgId,
        kind: 'chat',
        content: { text: content, sender, sender_name: senderName },
        timestamp,
        isGroup: true,
        isMention,
      });

      // Remember who last posted in this channel — used by the emilio-care
      // adapter below to correct Claudio's wrong-attribution habit (he
      // routinely writes "Paden" in chime subtexts regardless of who
      // actually triggered the log).
      recordInboundSender(channelId, senderName, message.author.id);

      log.info('Discord message stored', { channelId, chatName, sender: senderName });
    });

    const handleReaction = async (
      reaction: MessageReaction | PartialMessageReaction,
      user: User | PartialUser,
      action: 'add' | 'remove',
    ) => {
      if (DISCORD_REACTIONS_INBOUND === 'off') return;
      if (!this.client?.user) return;
      if (user.bot || user.id === this.client.user.id) return;

      try {
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
      } catch (err) {
        log.debug('Failed to fetch partial reaction', { err });
        return;
      }

      if (reaction.emoji.id !== null) {
        log.debug('Skipping custom emoji reaction (unicode only)', {
          emoji: reaction.emoji.name,
        });
        return;
      }
      const emoji = reaction.emoji.name;
      if (!emoji) return;

      const msg = reaction.message;
      const channelId = msg.channelId;
      if (!DiscordChannel.CHANNEL_FOLDERS[channelId]) return;

      const onBotMessage = msg.author?.id === this.client.user.id;
      if (DISCORD_REACTIONS_INBOUND === 'own' && !onBotMessage) return;

      try {
        if (!user.partial && !('username' in user && user.username)) {
          await user.fetch();
        }
      } catch {
        /* ignore */
      }

      const userName = ('globalName' in user && user.globalName) || ('username' in user && user.username) || 'Unknown';
      const timestamp = new Date().toISOString();

      this.channelSetup?.onInbound(channelId, null, {
        id: `reaction-${msg.id}:${user.id}:${emoji}:${action}:${timestamp}`,
        kind: 'chat',
        content: {
          type: 'reaction',
          emoji,
          action,
          messageId: msg.id,
          userId: user.id,
          userName,
          onBotMessage,
        },
        timestamp,
        isGroup: true,
      });

      log.info('Discord reaction event', { channelId, action, emoji, user: userName });
    };

    this.client.on(Events.MessageReactionAdd, (reaction, user) => handleReaction(reaction, user, 'add'));
    this.client.on(Events.MessageReactionRemove, (reaction, user) => handleReaction(reaction, user, 'remove'));

    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'health') {
          await this.handleHealthCommand(interaction);
          return;
        }
        if (interaction.commandName === 'wordle') {
          await this.handleWordleCommand(interaction);
          return;
        }
        if (interaction.commandName === 'wordle-status') {
          await this.handleWordleStatusCommand(interaction);
          return;
        }
        if (interaction.commandName === 'emilio-week') {
          await this.handleEmilioWeekCommand(interaction);
          return;
        }
        if (interaction.commandName === 'emilio-day') {
          await this.handleEmilioDayCommand(interaction);
          return;
        }
        if (interaction.commandName === 'pet-status') {
          await this.handlePetStatusCommand(interaction);
          return;
        }
        if (interaction.commandName === 'qotd') {
          await this.handleQotdCommand(interaction);
          return;
        }
        if (interaction.commandName === 'qotd-status') {
          await this.handleQotdStatusCommand(interaction);
          return;
        }
        const stateCmd = DiscordChannel.STATE_CARD_COMMANDS.find((c) => c.name === interaction.commandName);
        if (stateCmd) {
          await this.handleStateCardCommand(interaction, stateCmd);
          return;
        }
        if (interaction.commandName === 'calendar') {
          await this.handleCalendarCommand(interaction);
          return;
        }
        if (interaction.commandName === 'chore') {
          await this.handleChoreCommand(interaction);
          return;
        }
        if (
          interaction.commandName === 'asleep' ||
          interaction.commandName === 'awake' ||
          interaction.commandName === 'feeding' ||
          interaction.commandName === 'update-feeding' ||
          interaction.commandName === 'diaper'
        ) {
          await this.handleEmilioSlashCommand(interaction);
          return;
        }
        return;
      }
      if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'chore') {
          await this.handleChoreAutocomplete(interaction);
          return;
        }
        if (interaction.commandName === 'update-feeding') {
          await this.handleEmilioUpdateFeedingAutocomplete(interaction);
          return;
        }
      }
      if (interaction.isButton()) {
        if (interaction.customId.startsWith('emilio_day:')) {
          await this.handleEmilioHistoryNav(interaction);
          return;
        }
        if (interaction.customId.startsWith('emilio_day_table:')) {
          await this.handleEmilioDayTableNav(interaction);
          return;
        }
        if (interaction.customId.startsWith('emilio_week_table:')) {
          await this.handleEmilioWeekTableNav(interaction);
          return;
        }
      }
      if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith('qotd:pick:')) {
          await this.handleQotdSelect(interaction);
          return;
        }
      }
    });

    this.client.on(Events.Error, (err) => {
      log.error('Discord client error', { err: err.message });
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        log.info('Discord bot connected', {
          username: readyClient.user.tag,
          id: readyClient.user.id,
        });
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(`  Use /chatid command or check channel IDs in Discord settings\n`);

        try {
          const commands = [
            new SlashCommandBuilder()
              .setName('health')
              .setDescription('Run Claudio health check (containers, tasks, sheets, disk)')
              .toJSON(),
            new SlashCommandBuilder()
              .setName('wordle')
              .setDescription('Submit a 5-letter Wordle guess (#family-fun only)')
              .addStringOption((opt) =>
                opt
                  .setName('word')
                  .setDescription('Your 5-letter guess')
                  .setRequired(true)
                  .setMinLength(5)
                  .setMaxLength(5),
              )
              .toJSON(),
            new SlashCommandBuilder()
              .setName('wordle-status')
              .setDescription("Show today's Wordle progress (#family-fun only)")
              .toJSON(),
            new SlashCommandBuilder()
              .setName('emilio-week')
              .setDescription("Show Emilio's feeding, sleep, and poop summary for the last 7 days (#emilio-care only)")
              .toJSON(),
            new SlashCommandBuilder()
              .setName('emilio-day')
              .setDescription('Chronological event log for one day of Emilio activity (#emilio-care only)')
              .addStringOption((opt) =>
                opt
                  .setName('date')
                  .setDescription('Day to show. "today" (default), "yesterday", or YYYY-MM-DD.')
                  .setRequired(false),
              )
              .toJSON(),
            new SlashCommandBuilder()
              .setName('pet-status')
              .setDescription("Show every Silverthorne pet's stage, HP, and XP-to-next-evolution (#silverthorne only)")
              .toJSON(),
            new SlashCommandBuilder()
              .setName('qotd')
              .setDescription('Answer a panda question of the day (#panda only)')
              .addStringOption((opt) =>
                opt
                  .setName('answer')
                  .setDescription('Your answer')
                  .setRequired(true)
                  .setMinLength(1)
                  .setMaxLength(1500),
              )
              .toJSON(),
            new SlashCommandBuilder()
              .setName('qotd-status')
              .setDescription('Show panda questions still waiting for you (#panda only)')
              .toJSON(),
            ...DiscordChannel.STATE_CARD_COMMANDS.map((c) =>
              new SlashCommandBuilder().setName(c.name).setDescription(c.description).toJSON(),
            ),
            new SlashCommandBuilder()
              .setName('calendar')
              .setDescription("Show today's calendar agenda (#panda only)")
              .toJSON(),
            new SlashCommandBuilder()
              .setName('chore')
              .setDescription('Check off a silverthorne chore (#silverthorne only)')
              .addStringOption((opt) =>
                opt
                  .setName('chore')
                  .setDescription('Pick a chore from the autocomplete list')
                  .setRequired(true)
                  .setAutocomplete(true),
              )
              .toJSON(),
            new SlashCommandBuilder()
              .setName('asleep')
              .setDescription('Log Emilio falling asleep (#emilio-care)')
              .addStringOption((opt) =>
                opt.setName('time').setDescription('Optional: 5m, 2:30pm, 14:30. Defaults to now.').setRequired(false),
              )
              .toJSON(),
            new SlashCommandBuilder()
              .setName('awake')
              .setDescription('Close the open nap (#emilio-care)')
              .addStringOption((opt) =>
                opt.setName('time').setDescription('Optional: 5m, 2:30pm, 14:30. Defaults to now.').setRequired(false),
              )
              .toJSON(),
            new SlashCommandBuilder()
              .setName('feeding')
              .setDescription('Log a feeding (#emilio-care)')
              .addNumberOption((opt) =>
                opt
                  .setName('amount')
                  .setDescription('Ounces, e.g. 2.5')
                  .setMinValue(0.1)
                  .setMaxValue(20)
                  .setRequired(true),
              )
              .addStringOption((opt) =>
                opt.setName('time').setDescription('Optional: 5m, 2:30pm, 14:30. Defaults to now.').setRequired(false),
              )
              .addStringOption((opt) =>
                opt
                  .setName('source')
                  .setDescription('Source (default Formula)')
                  .setRequired(false)
                  .addChoices({ name: 'Formula', value: 'Formula' }, { name: 'Breast', value: 'Breast' }),
              )
              .toJSON(),
            new SlashCommandBuilder()
              .setName('update-feeding')
              .setDescription('Correct a recent feeding amount (#emilio-care)')
              .addNumberOption((opt) =>
                opt.setName('amount').setDescription('Corrected oz').setMinValue(0.1).setMaxValue(20).setRequired(true),
              )
              .addStringOption((opt) =>
                opt
                  .setName('row')
                  .setDescription('Which feeding (autocomplete shows last 5)')
                  .setRequired(false)
                  .setAutocomplete(true),
              )
              .toJSON(),
            new SlashCommandBuilder()
              .setName('diaper')
              .setDescription('Log a diaper change (#emilio-care)')
              .addStringOption((opt) =>
                opt
                  .setName('type')
                  .setDescription('Diaper status')
                  .setRequired(true)
                  .addChoices(
                    { name: 'wet', value: 'wet' },
                    { name: 'poopy', value: 'poopy' },
                    { name: 'both', value: 'both' },
                  ),
              )
              .addStringOption((opt) =>
                opt.setName('time').setDescription('Optional: 5m, 2:30pm, 14:30. Defaults to now.').setRequired(false),
              )
              .toJSON(),
          ];
          await readyClient.application.commands.set(commands);
          log.info('Registered Discord slash commands', { count: commands.length });
        } catch (err) {
          log.error('Failed to register Discord slash commands', { err });
        }

        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  private async handleHealthCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.reply({ content: '🩺 Running health check...', ephemeral: true });
    } catch (err) {
      log.warn('Failed to ack /health interaction', { err });
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder) {
      try {
        await interaction.followUp({
          content: '⚠️ This channel is not registered with Claudio.',
          ephemeral: true,
        });
      } catch {
        /* ignore */
      }
      return;
    }

    this.channelSetup?.onInbound(interaction.channelId, null, {
      id: `slash-health-${Date.now()}`,
      kind: 'chat',
      content: {
        text: `@${ASSISTANT_NAME} health`,
        sender: interaction.user.id,
        sender_name: interaction.user.globalName || interaction.user.username || 'Unknown',
      },
      timestamp: new Date().toISOString(),
      isGroup: true,
    });
  }

  private async handleWordleCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn('Failed to defer /wordle interaction', { err });
      return;
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (channelFolder !== 'discord_family-fun') {
      await interaction.editReply('⚠️ `/wordle` is only available in #family-fun.');
      return;
    }

    const rawGuess = interaction.options.getString('word', true);
    const guess = rawGuess.trim();
    if (!/^[A-Za-z]{5}$/.test(guess)) {
      await interaction.editReply(`⚠️ "${rawGuess}" isn't a 5-letter word (letters only).`);
      return;
    }

    const player = DiscordChannel.PLAYER_NAMES[interaction.user.id];
    if (!player) {
      await interaction.editReply("⚠️ You're not a registered Saga Wordle player.");
      return;
    }

    const scriptPath = path.resolve(process.cwd(), 'scripts', 'wordle-slash.mjs');
    let stdout: string;
    try {
      const res = await execFileAsync(
        'node',
        [scriptPath, player, guess, channelFolder, interaction.user.id, interaction.channelId],
        { timeout: 20_000, maxBuffer: 1_000_000 },
      );
      stdout = res.stdout;
    } catch (err) {
      const e = err as { message?: string };
      log.error('wordle-slash.mjs failed', { err: e.message, player, guess, folder: channelFolder });
      await interaction.editReply(`⚠️ Scoring failed: ${e.message || 'unknown error'}`);
      return;
    }

    let result: {
      ok?: boolean;
      status?: string;
      message?: string;
      history?: Array<{ guess: string; grid: string }>;
      solved?: boolean;
      guess_num?: number;
      budget?: number;
      word?: string;
      submission_audit_error?: string;
      coinsRemaining?: number;
    };
    try {
      result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    } catch (err) {
      log.error('wordle-slash.mjs returned non-JSON', { err, stdout });
      await interaction.editReply('⚠️ Scoring returned unparseable output.');
      return;
    }

    if (result.submission_audit_error) {
      log.warn('Wordle submissions audit append failed', {
        err: result.submission_audit_error,
        player,
        guess,
      });
    }

    const replyText = formatWordleReply({
      status: result.status || 'error',
      message: result.message,
      history: result.history,
      solved: result.solved,
      guess_num: result.guess_num,
      budget: result.budget,
      word: result.word,
    });
    const withCoins =
      result.coinsRemaining != null ? `${replyText}\n-# 🪙 ${result.coinsRemaining} remaining` : replyText;
    await interaction.editReply(withCoins);
    log.info('Wordle slash command scored', {
      player,
      guess: guess.toUpperCase(),
      status: result.status,
      solved: result.solved,
    });
  }

  private async handleWordleStatusCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
  ): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn('Failed to defer /wordle-status interaction', { err });
      return;
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (channelFolder !== 'discord_family-fun') {
      await interaction.editReply('⚠️ `/wordle-status` is only available in #family-fun.');
      return;
    }

    const player = DiscordChannel.PLAYER_NAMES[interaction.user.id];
    if (!player) {
      await interaction.editReply("⚠️ You're not a registered Saga Wordle player.");
      return;
    }

    const scriptPath = path.resolve(process.cwd(), 'scripts', 'wordle-status-slash.mjs');
    let stdout: string;
    try {
      const res = await execFileAsync('node', [scriptPath, player], {
        timeout: 20_000,
        maxBuffer: 1_000_000,
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { message?: string };
      log.error('wordle-status-slash.mjs failed', { err: e.message, player });
      await interaction.editReply(`⚠️ Status lookup failed: ${e.message || 'unknown error'}`);
      return;
    }

    let result: {
      ok?: boolean;
      status?: string;
      message?: string;
      history?: Array<{ guess: string; grid: string }>;
      budget?: number;
      solved?: boolean;
      word?: string;
      banked?: number | null;
    };
    try {
      result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    } catch (err) {
      log.error('wordle-status-slash.mjs returned non-JSON', { err, stdout });
      await interaction.editReply('⚠️ Status returned unparseable output.');
      return;
    }

    await interaction.editReply(
      formatWordleStatusReply({
        status: result.status || 'error',
        message: result.message,
        history: result.history,
        budget: result.budget,
        solved: result.solved,
        word: result.word,
        banked: result.banked,
      }),
    );
    log.info('Wordle status slash command ran', {
      player,
      status: result.status,
      guesses: result.history?.length,
      solved: result.solved,
    });
  }

  // --- /emilio history nav ---

  private chicagoDateStr(date: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  private prevDate(dateStr: string): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
    return dt.toISOString().slice(0, 10);
  }

  private nextDate(dateStr: string): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
    return dt.toISOString().slice(0, 10);
  }

  private async runEmilioCard(dateStr: string): Promise<string> {
    const scriptPath = path.resolve(process.cwd(), 'groups', 'discord_emilio-care', 'build_status_card.mjs');
    const { stdout } = await execFileAsync('node', [scriptPath, '--date', dateStr], {
      timeout: 20_000,
      maxBuffer: 1_000_000,
      env: {
        ...process.env,
        GOOGLE_OAUTH_CREDENTIALS:
          process.env.GOOGLE_OAUTH_CREDENTIALS ||
          path.resolve(process.cwd(), 'data', 'google-calendar', 'gcp-oauth.keys.json'),
        GOOGLE_CALENDAR_MCP_TOKEN_PATH:
          process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
          path.resolve(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json'),
      },
    });
    return stdout.split(/═══ AGENT REF/)[0].trim();
  }

  private buildEmilioHistoryReply(
    card: string,
    dateStr: string,
    today: string,
  ): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
    const isToday = dateStr === today;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`emilio_day:${this.prevDate(dateStr)}`)
        .setLabel('◀ Prev Day')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`emilio_day:${this.nextDate(dateStr)}`)
        .setLabel('Next Day ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isToday),
    );
    return { content: card, components: [row] };
  }

  private async handleEmilioHistoryNav(interaction: ButtonInteraction): Promise<void> {
    const dateStr = interaction.customId.split(':')[1];
    const today = this.chicagoDateStr();
    if (!dateStr || dateStr > today) {
      await interaction.update({ content: '⚠️ Invalid date.', components: [] });
      return;
    }
    try {
      const card = await this.runEmilioCard(dateStr);
      await interaction.update(this.buildEmilioHistoryReply(card, dateStr, today));
    } catch (err) {
      log.error('emilio_day nav failed', { err, dateStr });
      await interaction.update({ content: '⚠️ Could not load that day.', components: [] });
    }
  }

  private buildEmilioDayTableReply(
    table: string,
    dateStr: string,
    today: string,
  ): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
    const isToday = dateStr === today;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`emilio_day_table:${this.prevDate(dateStr)}`)
        .setLabel('◀ Prev Day')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`emilio_day_table:${this.nextDate(dateStr)}`)
        .setLabel('Next Day ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isToday),
    );
    return { content: table, components: [row] };
  }

  private async runEmilioDaySlash(dateStr: string): Promise<{ ok?: boolean; table?: string; error?: string }> {
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'emilio-day-slash.mjs');
    const { stdout } = await execFileAsync('node', [scriptPath, `--date=${dateStr}`], {
      timeout: 25_000,
      maxBuffer: 1_000_000,
      env: {
        ...process.env,
        GOOGLE_OAUTH_CREDENTIALS:
          process.env.GOOGLE_OAUTH_CREDENTIALS ||
          path.resolve(process.cwd(), 'data', 'google-calendar', 'gcp-oauth.keys.json'),
        GOOGLE_CALENDAR_MCP_TOKEN_PATH:
          process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
          path.resolve(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json'),
      },
    });
    return JSON.parse(stdout.trim().split('\n').pop() || '{}');
  }

  private async handleEmilioDayTableNav(interaction: ButtonInteraction): Promise<void> {
    const dateStr = interaction.customId.split(':')[1];
    const today = this.chicagoDateStr();
    if (!dateStr || dateStr > today) {
      await interaction.update({ content: '⚠️ Invalid date.', components: [] });
      return;
    }
    try {
      const result = await this.runEmilioDaySlash(dateStr);
      if (!result.ok || !result.table) {
        await interaction.update({ content: `⚠️ ${result.error || 'Unknown error'}`, components: [] });
        return;
      }
      await interaction.update(this.buildEmilioDayTableReply(result.table, dateStr, today));
    } catch (err) {
      log.error('emilio_day_table nav failed', { err, dateStr });
      await interaction.update({ content: '⚠️ Could not load that day.', components: [] });
    }
  }

  private buildEmilioWeekTableReply(
    table: string,
    endDate: string,
    today: string,
  ): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
    const isCurrent = endDate === today;
    const prevEnd = this.addDays(endDate, -7);
    const nextEnd = this.addDays(endDate, 7);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`emilio_week_table:${prevEnd}`)
        .setLabel('◀ Prev Week')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`emilio_week_table:${nextEnd > today ? today : nextEnd}`)
        .setLabel('Next Week ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isCurrent),
    );
    return { content: table, components: [row] };
  }

  private async runEmilioWeekSlash(endDate: string | null): Promise<{ ok?: boolean; table?: string; error?: string }> {
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'emilio-week-slash.mjs');
    const args = endDate ? [scriptPath, `--end=${endDate}`] : [scriptPath];
    const { stdout } = await execFileAsync('node', args, {
      timeout: 25_000,
      maxBuffer: 1_000_000,
      env: {
        ...process.env,
        GOOGLE_OAUTH_CREDENTIALS:
          process.env.GOOGLE_OAUTH_CREDENTIALS ||
          path.resolve(process.cwd(), 'data', 'google-calendar', 'gcp-oauth.keys.json'),
        GOOGLE_CALENDAR_MCP_TOKEN_PATH:
          process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
          path.resolve(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json'),
      },
    });
    return JSON.parse(stdout.trim().split('\n').pop() || '{}');
  }

  private async handleEmilioWeekTableNav(interaction: ButtonInteraction): Promise<void> {
    const endDate = interaction.customId.split(':')[1];
    const today = this.chicagoDateStr();
    if (!endDate || endDate > today) {
      await interaction.update({ content: '⚠️ Invalid week.', components: [] });
      return;
    }
    try {
      const result = await this.runEmilioWeekSlash(endDate);
      if (!result.ok || !result.table) {
        await interaction.update({ content: `⚠️ ${result.error || 'Unknown error'}`, components: [] });
        return;
      }
      await interaction.update(this.buildEmilioWeekTableReply(result.table, endDate, today));
    } catch (err) {
      log.error('emilio_week_table nav failed', { err, endDate });
      await interaction.update({ content: '⚠️ Could not load that week.', components: [] });
    }
  }

  private addDays(dateStr: string, n: number): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
  }

  // --- /emilio-week ---

  private async handleEmilioWeekCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn('Failed to defer /emilio-week interaction', { err });
      return;
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder || channelFolder !== 'discord_emilio-care') {
      await interaction.editReply('⚠️ `/emilio-week` is only available in #emilio-care.');
      return;
    }

    const scriptPath = path.resolve(process.cwd(), 'scripts', 'emilio-week-slash.mjs');
    let stdout: string;
    try {
      const res = await execFileAsync('node', [scriptPath], {
        timeout: 25_000,
        maxBuffer: 1_000_000,
        env: {
          ...process.env,
          GOOGLE_OAUTH_CREDENTIALS:
            process.env.GOOGLE_OAUTH_CREDENTIALS ||
            path.resolve(process.cwd(), 'data', 'google-calendar', 'gcp-oauth.keys.json'),
          GOOGLE_CALENDAR_MCP_TOKEN_PATH:
            process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
            path.resolve(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json'),
        },
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { message?: string };
      log.error('/emilio-week script failed', { err: e.message });
      await interaction.editReply(`⚠️ Could not load weekly summary: ${e.message || 'unknown error'}`);
      return;
    }

    let result: { ok?: boolean; table?: string; error?: string };
    try {
      result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    } catch {
      await interaction.editReply('⚠️ Weekly summary returned unparseable output.');
      return;
    }

    if (!result.ok || !result.table) {
      await interaction.editReply(`⚠️ ${result.error || 'Unknown error'}`);
      return;
    }

    const today = this.chicagoDateStr();
    await interaction.editReply(this.buildEmilioWeekTableReply(result.table, today, today));
    log.info('/emilio-week slash command ran');
  }

  // --- /emilio-day ---

  private async handleEmilioDayCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn('Failed to defer /emilio-day interaction', { err });
      return;
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder || channelFolder !== 'discord_emilio-care') {
      await interaction.editReply('⚠️ `/emilio-day` is only available in #emilio-care.');
      return;
    }

    const dateOpt = interaction.options.getString('date') || 'today';
    // Reject anything that isn't today/yesterday/YYYY-MM-DD before spawning the script.
    if (!/^(today|yesterday|\d{4}-\d{2}-\d{2})$/.test(dateOpt)) {
      await interaction.editReply('⚠️ `date` must be `today`, `yesterday`, or `YYYY-MM-DD`.');
      return;
    }

    const scriptPath = path.resolve(process.cwd(), 'scripts', 'emilio-day-slash.mjs');
    let stdout: string;
    try {
      const res = await execFileAsync('node', [scriptPath, `--date=${dateOpt}`], {
        timeout: 25_000,
        maxBuffer: 1_000_000,
        env: {
          ...process.env,
          GOOGLE_OAUTH_CREDENTIALS:
            process.env.GOOGLE_OAUTH_CREDENTIALS ||
            path.resolve(process.cwd(), 'data', 'google-calendar', 'gcp-oauth.keys.json'),
          GOOGLE_CALENDAR_MCP_TOKEN_PATH:
            process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
            path.resolve(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json'),
        },
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { message?: string };
      log.error('/emilio-day script failed', { err: e.message });
      await interaction.editReply(`⚠️ Could not load day summary: ${e.message || 'unknown error'}`);
      return;
    }

    let result: { ok?: boolean; table?: string; error?: string };
    try {
      result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    } catch {
      await interaction.editReply('⚠️ Day summary returned unparseable output.');
      return;
    }

    if (!result.ok || !result.table) {
      await interaction.editReply(`⚠️ ${result.error || 'Unknown error'}`);
      return;
    }

    const today = this.chicagoDateStr();
    const resolvedDate = dateOpt === 'today' ? today : dateOpt === 'yesterday' ? this.prevDate(today) : dateOpt;
    await interaction.editReply(this.buildEmilioDayTableReply(result.table, resolvedDate, today));
    log.info('/emilio-day slash command ran', { date: dateOpt });
  }

  // --- /pet-status ---

  private async handlePetStatusCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn('Failed to defer /pet-status interaction', { err });
      return;
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder || channelFolder !== 'discord_silverthorne') {
      await interaction.editReply('⚠️ `/pet-status` is only available in #silverthorne.');
      return;
    }

    const scriptPath = path.resolve(process.cwd(), 'scripts', 'pet-status-slash.mjs');
    let stdout: string;
    try {
      const res = await execFileAsync('node', [scriptPath], {
        timeout: 15_000,
        maxBuffer: 1_000_000,
        env: {
          ...process.env,
          GOOGLE_OAUTH_CREDENTIALS:
            process.env.GOOGLE_OAUTH_CREDENTIALS ||
            path.resolve(process.cwd(), 'data', 'google-calendar', 'gcp-oauth.keys.json'),
          GOOGLE_CALENDAR_MCP_TOKEN_PATH:
            process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
            path.resolve(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json'),
        },
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { message?: string };
      log.error('/pet-status script failed', { err: e.message });
      await interaction.editReply(`⚠️ Could not load pet status: ${e.message || 'unknown error'}`);
      return;
    }

    let result: { ok?: boolean; table?: string; error?: string };
    try {
      result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    } catch {
      await interaction.editReply('⚠️ Pet status returned unparseable output.');
      return;
    }

    if (!result.ok || !result.table) {
      await interaction.editReply(`⚠️ ${result.error || 'Unknown error'}`);
      return;
    }

    await interaction.editReply(result.table);
    log.info('/pet-status slash command ran');
  }

  // --- /qotd ---

  private qotdPending = new Map<string, { userId: string; player: string; answer: string; expiresAt: number }>();

  private static readonly QOTD_ALLOWED_USER_IDS = new Set([
    '181867944404320256', // Paden
    '350815183804825600', // Brenda
  ]);

  private static readonly PLAYER_NAMES: Record<string, string> = {
    '181867944404320256': 'Paden',
    '350815183804825600': 'Brenda',
    '280744944358916097': 'Danny',
  };

  private static readonly STATE_CARD_COMMANDS: Array<{
    name: string;
    description: string;
    folder: string;
    scriptPath: string;
  }> = [
    {
      name: 'emilio',
      description: "Show Emilio's today snapshot (#emilio-care only)",
      folder: 'discord_emilio-care',
      scriptPath: 'groups/discord_emilio-care/build_status_card.mjs',
    },
    {
      name: 'chore-status',
      description: 'Show the silverthorne chore + pet status card (#silverthorne only)',
      folder: 'discord_silverthorne',
      scriptPath: 'groups/discord_silverthorne/build_status_card.mjs',
    },
    {
      name: 'pumps',
      description: 'Show the pumping status card (#liquid-gold only)',
      folder: 'discord_liquid-gold',
      scriptPath: 'groups/discord_liquid-gold/build_status_card.mjs',
    },
  ];

  private async handleQotdCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn('Failed to defer /qotd interaction', { err });
      return;
    }

    if (!DiscordChannel.QOTD_ALLOWED_USER_IDS.has(interaction.user.id)) {
      await interaction.editReply('⚠️ `/qotd` is just for Paden and Brenda — panda game is theirs.');
      return;
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (channelFolder !== 'discord_parents') {
      await interaction.editReply('⚠️ `/qotd` is only available in #panda.');
      return;
    }

    const answer = interaction.options.getString('answer', true).trim();
    if (!answer) {
      await interaction.editReply('⚠️ Answer was empty.');
      return;
    }

    const player = DiscordChannel.PLAYER_NAMES[interaction.user.id];
    if (!player) {
      await interaction.editReply("⚠️ You're not a registered panda player.");
      return;
    }

    const result = await this.runQotdScript([player, interaction.user.id, answer]);
    if (!result) {
      await interaction.editReply('⚠️ Scoring returned unparseable output.');
      return;
    }

    if (result.ok === false || result.status === 'error') {
      await interaction.editReply(`⚠️ ${result.message || 'Something went wrong recording that.'}`);
      return;
    }

    if (result.status === 'caught_up') {
      await interaction.editReply(result.message || "You're all caught up — no open panda Qs for you right now.");
      return;
    }

    if (result.status === 'appended') {
      await interaction.editReply(`✅ Logged for Q${result.qNum} — _${result.question}_`);
      return;
    }

    if (result.status === 'needs_choice' && Array.isArray(result.candidates)) {
      const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      this.pruneQotdPending();
      this.qotdPending.set(token, {
        userId: interaction.user.id,
        player,
        answer,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const select = new StringSelectMenuBuilder()
        .setCustomId(`qotd:pick:${token}`)
        .setPlaceholder('Which question did you just answer?')
        .addOptions(
          result.candidates.slice(0, 25).map((c) => ({
            label: `Q${c.qNum}`.slice(0, 100),
            description: (c.question || '').slice(0, 100),
            value: String(c.qNum),
          })),
        );
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

      await interaction.editReply({
        content: `You have ${result.candidates.length} open panda Qs — which one does this answer go to?`,
        components: [row],
      });
      return;
    }

    await interaction.editReply(`⚠️ Unexpected response: ${JSON.stringify(result)}`);
  }

  private async handleQotdSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    try {
      await interaction.deferUpdate();
    } catch (err) {
      log.warn('Failed to deferUpdate qotd select', { err });
      return;
    }

    const token = interaction.customId.replace(/^qotd:pick:/, '');
    this.pruneQotdPending();
    const pending = this.qotdPending.get(token);
    if (!pending) {
      await interaction.editReply({
        content: '⚠️ That picker expired — rerun `/qotd` with your answer.',
        components: [],
      });
      return;
    }
    if (pending.userId !== interaction.user.id) {
      await interaction.editReply({ content: "⚠️ That picker isn't yours.", components: [] });
      return;
    }
    this.qotdPending.delete(token);

    const qNum = interaction.values[0];
    const result = await this.runQotdScript([pending.player, pending.userId, pending.answer, qNum]);
    if (!result || result.ok === false || result.status === 'error') {
      await interaction.editReply({
        content: `⚠️ ${result?.message || 'Failed to record that answer.'}`,
        components: [],
      });
      return;
    }

    await interaction.editReply({
      content: `✅ Logged for Q${result.qNum} — _${result.question}_`,
      components: [],
    });
  }

  private async handleQotdStatusCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn('Failed to defer /qotd-status interaction', { err });
      return;
    }

    if (!DiscordChannel.QOTD_ALLOWED_USER_IDS.has(interaction.user.id)) {
      await interaction.editReply('⚠️ `/qotd-status` is just for Paden and Brenda.');
      return;
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (channelFolder !== 'discord_parents') {
      await interaction.editReply('⚠️ `/qotd-status` is only available in #panda.');
      return;
    }

    const scriptPath = path.resolve(process.cwd(), 'scripts', 'qotd-status-slash.mjs');
    let stdout: string;
    try {
      const res = await execFileAsync('node', [scriptPath, interaction.user.id], {
        timeout: 20_000,
        maxBuffer: 1_000_000,
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { message?: string };
      log.error('qotd-status-slash.mjs failed', { err: e.message, userId: interaction.user.id });
      await interaction.editReply(`⚠️ Status lookup failed: ${e.message || 'unknown error'}`);
      return;
    }

    let result: {
      ok?: boolean;
      status?: string;
      message?: string;
      currentQNum?: number;
      currentDay?: number;
      today?: string;
      open?: Array<{ qNum: number; day: number; date: string; question: string }>;
      skippedOpen?: Array<{ qNum: number; day: number; date: string; question: string }>;
      totalAnswered?: number;
    };
    try {
      result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    } catch (err) {
      log.error('qotd-status-slash.mjs returned non-JSON', { err, stdout });
      await interaction.editReply('⚠️ Status returned unparseable output.');
      return;
    }

    await interaction.editReply(
      formatQotdStatusReply({
        status: result.status || 'error',
        message: result.message,
        currentQNum: result.currentQNum,
        currentDay: result.currentDay,
        today: result.today,
        open: result.open,
        skippedOpen: result.skippedOpen,
        totalAnswered: result.totalAnswered,
      }),
    );
    log.info('Qotd status slash command ran', {
      userId: interaction.user.id,
      status: result.status,
      open: result.open?.length,
    });
  }

  private async handleStateCardCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
    cfg: (typeof DiscordChannel.STATE_CARD_COMMANDS)[number],
  ): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn(`Failed to defer /${cfg.name} interaction`, { err });
      return;
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (channelFolder !== cfg.folder) {
      await interaction.editReply(
        `⚠️ \`/${cfg.name}\` is only available in the ${cfg.folder.replace(/^discord_/, '#')} channel.`,
      );
      return;
    }

    const scriptPath = path.resolve(process.cwd(), cfg.scriptPath);
    let stdout: string;
    try {
      const res = await execFileAsync('node', [scriptPath], {
        timeout: 20_000,
        maxBuffer: 2_000_000,
        env: {
          ...process.env,
          GOOGLE_OAUTH_CREDENTIALS:
            process.env.GOOGLE_OAUTH_CREDENTIALS ||
            path.resolve(process.cwd(), 'data', 'google-calendar', 'gcp-oauth.keys.json'),
          GOOGLE_CALENDAR_MCP_TOKEN_PATH:
            process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
            path.resolve(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json'),
        },
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { message?: string };
      log.error(`/${cfg.name} script failed`, { err: e.message, script: cfg.scriptPath });
      await interaction.editReply(`⚠️ Status lookup failed: ${e.message || 'unknown error'}`);
      return;
    }

    const card = stripCard(stdout);
    if (!card) {
      await interaction.editReply('⚠️ Card script returned empty output.');
      return;
    }

    if (cfg.name === 'emilio') {
      const today = this.chicagoDateStr();
      await interaction.editReply(this.buildEmilioHistoryReply(fitDiscordReply(card), today, today));
    } else {
      await interaction.editReply(fitDiscordReply(card));
    }
    log.info('State-card slash command ran', {
      command: cfg.name,
      folder: cfg.folder,
      cardLength: card.length,
    });
  }

  private async handleCalendarCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn('Failed to defer /calendar interaction', { err });
      return;
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (channelFolder !== 'discord_parents') {
      await interaction.editReply('⚠️ `/calendar` is only available in #panda.');
      return;
    }

    const scriptPath = path.resolve(process.cwd(), 'scripts', 'calendar-slash.mjs');
    let stdout: string;
    try {
      const res = await execFileAsync('node', [scriptPath], {
        timeout: 20_000,
        maxBuffer: 2_000_000,
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { message?: string };
      log.error('/calendar script failed', { err: e.message });
      await interaction.editReply(`⚠️ Calendar lookup failed: ${e.message || 'unknown error'}`);
      return;
    }
    const card = stdout.replace(/\s+$/, '');
    if (!card) {
      await interaction.editReply('⚠️ Calendar script returned empty output.');
      return;
    }
    await interaction.editReply(fitDiscordReply(card));
    log.info('/calendar slash command ran', { cardLength: card.length });
  }

  private async handleChoreAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder || channelFolder !== 'discord_silverthorne') {
      try {
        await interaction.respond([]);
      } catch {
        /* ignore */
      }
      return;
    }
    const focused = interaction.options.getFocused();
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'chore-slash.mjs');
    try {
      const res = await execFileAsync('node', [scriptPath, 'autocomplete', interaction.user.id, focused], {
        timeout: 2500,
        maxBuffer: 1_000_000,
      });
      const parsed = JSON.parse(res.stdout.trim().split('\n').pop() || '{}') as {
        ok?: boolean;
        options?: Array<{ value: string; label: string }>;
      };
      const choices = (parsed.options || []).slice(0, 25).map((o) => ({
        name: o.label.slice(0, 100),
        value: o.value.slice(0, 100),
      }));
      await interaction.respond(choices);
    } catch (err) {
      log.warn('chore autocomplete failed; returning empty choices', {
        err: (err as Error).message,
        userId: interaction.user.id,
      });
      try {
        await interaction.respond([]);
      } catch {
        /* ignore */
      }
    }
  }

  private async handleChoreCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn('Failed to defer /chore interaction', { err });
      return;
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (channelFolder !== 'discord_silverthorne') {
      await interaction.editReply('⚠️ `/chore` is only available in #silverthorne.');
      return;
    }

    const value = interaction.options.getString('chore', true);
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'chore-slash.mjs');
    let stdout: string;
    try {
      const res = await execFileAsync('node', [scriptPath, 'submit', interaction.user.id, value], {
        timeout: 25_000,
        maxBuffer: 2_000_000,
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { message?: string };
      log.error('/chore submit failed', { err: e.message, userId: interaction.user.id, value });
      await interaction.editReply(`⚠️ Chore log failed: ${e.message || 'unknown error'}`);
      return;
    }

    let result: {
      ok?: boolean;
      error?: string;
      petName?: string;
      fact?: string;
      voice?: string;
      totalXp?: number;
      chores?: Array<{ chore_id: string; name?: string; xp?: number; skipped?: string; error?: string }>;
      awards?: Array<{
        owner: string;
        xp: number;
        award?: {
          petName?: string;
          prevStage?: string;
          newStage?: string;
          newXp?: number;
          evolved?: boolean;
        };
        coins?: { delta: number; new_balance: number; per_chore: Array<{ chore_id: string; new_balance: number }> };
        error?: string;
      }>;
    };
    try {
      result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    } catch (err) {
      log.error('/chore-slash returned non-JSON', { err, stdout });
      await interaction.editReply('⚠️ Chore log returned unparseable output.');
      return;
    }

    if (!result.ok) {
      await interaction.editReply(`⚠️ ${result.error || 'something went wrong'}`);
      return;
    }

    const doneChores = (result.chores || []).filter((c) => c.xp && !c.skipped);
    const skippedChores = (result.chores || []).filter((c) => c.skipped);
    const ackLines: string[] = [];
    if (doneChores.length) {
      for (const c of doneChores) ackLines.push(`✅ ${c.name} · +${c.xp} XP`);
    }
    for (const c of skippedChores) ackLines.push(`↩ ${c.name} · already logged`);
    if (!ackLines.length) ackLines.push('Nothing new to log.');
    await interaction.editReply(ackLines.join('\n'));

    // Send webhook pet ack directly
    if (doneChores.length && result.petName && result.fact) {
      const coinAward = (result.awards || []).find((a) => a.coins?.delta);
      const coinLine = coinAward ? ` · 🪙 +${coinAward.coins!.delta} (bank: ${coinAward.coins!.new_balance})` : '';
      const dataLine = result.totalXp
        ? `${result.fact} · +${result.totalXp} XP${coinLine}`
        : `${result.fact}${coinLine}`;
      const text = result.voice ? `${result.voice}\n-# ${dataLine}` : dataLine;
      const persona = WEBHOOK_PERSONAS[result.petName];
      if (persona) {
        try {
          await this.sendWebhookMessage(interaction.channelId, text, persona.name, persona.avatar);
        } catch (err) {
          log.warn('Failed to send pet webhook for /chore', {
            err: (err as Error).message,
            petName: result.petName,
          });
        }
      }
    }

    log.info('/chore slash command ran', {
      userId: interaction.user.id,
      value,
      doneCount: doneChores.length,
      totalXp: result.totalXp,
    });

    // Evolution ceremony trigger. award_xp.mjs writes the Pets sheet update +
    // evolution row to Pet Log on stage-up; this wakes Claudio to do the
    // theatrical post + species/avatar generation per chore_pet_spec.md.
    const evolutions = (result.awards || []).filter((a) => a.award?.evolved);
    for (const ev of evolutions) {
      const petName = ev.award?.petName || '(pet)';
      const prevStage = ev.award?.prevStage || '?';
      const newStage = ev.award?.newStage || '?';
      const ceremonyPrompt = [
        `A pet just evolved via /chore. Run the ceremony per /workspace/agent/chore_pet_spec.md.`,
        '',
        `Owner: ${ev.owner}`,
        `Pet: ${petName}`,
        `Evolution: ${prevStage} → ${newStage}`,
        '',
        '1. Generate a fresh, unique species description for the new stage — wild',
        '   imagination, distinct from prior stages. Two pets must never share a',
        '   description.',
        '2. Post the theatrical 3-message sequence in #silverthorne:',
        '   anticipation → ✨✨✨ → reveal (with the new species description).',
        "3. Update the pet's avatar via personas[<PetName>] = { name: existing,",
        '   avatar: new URL } so its webhook posts show the new form.',
        '4. Update the Pet Log evolution row notes column (currently "species TBD',
        '   by agent") with the species description for posterity.',
        '',
        "Don't re-award XP or modify HP — award_xp.mjs already did the math.",
        'Just the ceremony.',
      ].join('\n');
      try {
        await writeIpcTask('discord_silverthorne', {
          type: 'schedule_task',
          prompt: ceremonyPrompt,
          targetJid: 'dc:1490895684789075968',
          schedule_type: 'once',
          schedule_value: new Date().toISOString(),
        });
        log.info('Scheduled evolution ceremony task', { owner: ev.owner, petName, newStage });
      } catch (err) {
        log.error('Failed to schedule evolution ceremony', {
          err: (err as Error).message,
          owner: ev.owner,
          petName,
        });
      }

      // Deterministic image-prompt follow-up. The ceremony task asks Claudio
      // to also generate an avatar-prompt for the owner, but Gemini-3-flash
      // consistently skips that step (seen on Nyx 2026-05-18 and Voss
      // 2026-05-23). Post the prompt directly from the host so it never
      // depends on the model.
      try {
        const avatarPromptText = buildAvatarPromptMessage({
          owner: ev.owner,
          petName,
          prevStage,
          newStage,
        });
        await writeIpcMessage('discord_silverthorne', {
          type: 'message',
          chatJid: 'dc:1490895684789075968',
          text: avatarPromptText,
        });
        log.info('Posted avatar-prompt follow-up', { owner: ev.owner, petName, newStage });
      } catch (err) {
        log.error('Failed to post avatar-prompt follow-up', {
          err: (err as Error).message,
          owner: ev.owner,
          petName,
        });
      }
    }
  }

  private async handleEmilioSlashCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn('Failed to defer Emilio slash interaction', { err, command: interaction.commandName });
      return;
    }

    const userId = interaction.user.id;
    const args: string[] = [];
    if (interaction.commandName === 'asleep' || interaction.commandName === 'awake') {
      args.push(interaction.options.getString('time') || '');
    } else if (interaction.commandName === 'feeding') {
      args.push(String(interaction.options.getNumber('amount', true)));
      args.push(interaction.options.getString('time') || '');
      args.push(interaction.options.getString('source') || '');
    } else if (interaction.commandName === 'diaper') {
      args.push(interaction.options.getString('type', true));
      args.push(interaction.options.getString('time') || '');
    } else {
      // update-feeding
      args.push(String(interaction.options.getNumber('amount', true)));
      args.push(interaction.options.getString('row') || '');
    }

    const scriptPath = path.resolve(process.cwd(), 'scripts', 'emilio-slash.mjs');
    let stdout: string;
    try {
      // 60s timeout: emilio-slash does two passes of Sheets work (the
      // action itself, then a build_status_card render that re-reads
      // Feedings/Diapers/Sleep Log). Under network/API load this routinely
      // approaches 30s. Killing at 30s produces a stderr-less "Command
      // failed" and — because the host kept the previous execFile pending
      // — the very next interaction's deferReply often misses Discord's
      // 3-second window (Unknown interaction). Doubling the budget so a
      // single slow Sheets pass doesn't poison the next slash command.
      const res = await execFileAsync('node', [scriptPath, interaction.commandName, userId, ...args], {
        timeout: 60_000,
        maxBuffer: 1_000_000,
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { message?: string };
      log.error('emilio-slash.mjs failed', { err: e.message, userId, command: interaction.commandName });
      await interaction.editReply(`⚠️ slash error: ${e.message || 'unknown error'}`);
      return;
    }

    let result: { ok?: boolean; reply?: string; error?: string; card?: string; chime?: string };
    try {
      result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    } catch (err) {
      log.error('emilio-slash returned non-JSON', { err, stdout, command: interaction.commandName });
      await interaction.editReply('⚠️ slash returned unparseable output.');
      return;
    }

    if (result.ok) {
      await interaction.editReply(result.reply || 'Done.');
      const emilioCareJid = '1490781468182577172';
      // Post Emilio chime via webhook persona
      if (result.chime && WEBHOOK_PERSONAS['Emilio']) {
        await this.sendWebhookMessage(
          emilioCareJid,
          result.chime,
          WEBHOOK_PERSONAS['Emilio'].name,
          WEBHOOK_PERSONAS['Emilio'].avatar,
        );
      }
      // Update pinned status card — edit existing pin, don't post a new message
      if (result.card) {
        const cardText = result.card.split(/═══ AGENT REF/)[0].trim();
        const labelsPath = path.resolve(
          process.cwd(),
          'data',
          'sessions',
          'discord_emilio-care',
          'message_labels.json',
        );
        let pinnedId: string | null = null;
        try {
          const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
          pinnedId = labels?.status_card?.id ?? null;
        } catch {
          /* first run — no label yet */
        }

        if (pinnedId) {
          try {
            const channelId = emilioCareJid.replace(/^dc:/, '');
            const ch = await this.client?.channels.fetch(channelId);
            if (ch && 'messages' in ch) {
              const msg = await (ch as import('discord.js').TextChannel).messages.fetch(pinnedId);
              await msg.edit(cardText);
            }
          } catch (err) {
            log.warn('Failed to edit pinned status card', { err });
          }
        } else {
          // No existing pin — post and pin it, save the label
          const msgId = await this.sendMessageWithId(emilioCareJid, cardText);
          if (msgId) {
            try {
              const channelId = emilioCareJid.replace(/^dc:/, '');
              const ch = await this.client?.channels.fetch(channelId);
              if (ch && 'messages' in ch) {
                const msg = await (ch as import('discord.js').TextChannel).messages.fetch(msgId);
                await msg.pin();
              }
            } catch {
              /* best effort */
            }
            try {
              const labels = fs.existsSync(labelsPath) ? JSON.parse(fs.readFileSync(labelsPath, 'utf8')) : {};
              labels.status_card = { id: msgId, date: new Date().toISOString().slice(0, 10) };
              fs.mkdirSync(path.dirname(labelsPath), { recursive: true });
              fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2));
            } catch {
              /* best effort */
            }
          }
        }
      }
    } else {
      await interaction.editReply(`⚠️ ${result.error || 'Unknown error'}`);
    }

    log.info('emilio slash command ran', { userId, command: interaction.commandName, ok: result.ok });
  }

  private async handleEmilioUpdateFeedingAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'row') {
      try {
        await interaction.respond([]);
      } catch {
        /* ignore */
      }
      return;
    }
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'emilio-slash.mjs');
    try {
      const res = await execFileAsync('node', [scriptPath, 'autocomplete-feeding-row', interaction.user.id], {
        timeout: 5_000,
        maxBuffer: 200_000,
      });
      const parsed = JSON.parse(res.stdout.trim().split('\n').pop() || '{}') as {
        ok?: boolean;
        options?: Array<{ value: string; label: string }>;
      };
      const choices = (parsed.options || []).slice(0, 25).map((o) => ({
        name: o.label.slice(0, 100),
        value: o.value.slice(0, 100),
      }));
      await interaction.respond(choices);
    } catch (err) {
      log.warn('update-feeding autocomplete failed; returning empty choices', {
        err: (err as Error).message,
        userId: interaction.user.id,
      });
      try {
        await interaction.respond([]);
      } catch {
        /* ignore */
      }
    }
  }

  private pruneQotdPending(): void {
    const now = Date.now();
    for (const [token, entry] of this.qotdPending) {
      if (entry.expiresAt < now) this.qotdPending.delete(token);
    }
  }

  private async runQotdScript(args: string[]): Promise<{
    ok?: boolean;
    status?: string;
    message?: string;
    qNum?: number;
    question?: string;
    candidates?: Array<{ qNum: number; question: string }>;
  } | null> {
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'qotd-slash.mjs');
    let stdout: string;
    try {
      const res = await execFileAsync('node', [scriptPath, ...args], {
        timeout: 20_000,
        maxBuffer: 1_000_000,
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { message?: string };
      log.error('qotd-slash.mjs failed', { err: e.message, args });
      return null;
    }
    try {
      return JSON.parse(stdout.trim().split('\n').pop() || '{}');
    } catch (err) {
      log.error('qotd-slash.mjs returned non-JSON', { err, stdout });
      return null;
    }
  }

  // --- v2 ChannelAdapter delivery methods ---

  async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const content = message.content as Record<string, unknown> | null;

    // Delete operation: {operation: "delete_message", messageId} deletes the
    // message by platform ID. Used by host-side cleanup (e.g. wiping LLM
    // narration messages) where we don't have a label/upsert flow.
    if (content && content.operation === 'delete_message') {
      const targetId = typeof content.messageId === 'string' ? content.messageId : null;
      if (!targetId || !this.client) return undefined;
      // Accept either bare Discord id or "<id>:<session>" combined form.
      const discordMsgId = targetId.includes(':') ? targetId.split(':')[0] : targetId;
      try {
        const ch = await this.client.channels.fetch(platformId);
        if (ch && 'messages' in ch) {
          const msg = await (ch as TextChannel).messages.fetch(discordMsgId).catch(() => null);
          if (msg) await msg.delete().catch(() => undefined);
        }
      } catch (err) {
        log.warn('Failed to delete Discord message', { discordMsgId, err: (err as Error).message });
      }
      return undefined;
    }

    // Unpin operation: {operation: "unpin_message", label} unpins the pinned
    // message stored under that label in message_labels.json and clears the
    // label entry. Used to retire pinned cards.
    if (content && content.operation === 'unpin_message') {
      const labelName = typeof content.label === 'string' ? content.label : null;
      const groupFolder = DiscordChannel.CHANNEL_FOLDERS[platformId];
      if (!labelName || !groupFolder || !this.client) return undefined;
      const labelsPath = path.resolve(process.cwd(), 'data', 'sessions', groupFolder, 'message_labels.json');
      try {
        const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8')) as Record<string, string | { id: string }>;
        const raw = labels[labelName];
        const pinnedId = typeof raw === 'string' ? raw : raw?.id;
        if (pinnedId) {
          const ch = await this.client.channels.fetch(platformId);
          if (ch && 'messages' in ch) {
            const msg = await (ch as TextChannel).messages.fetch(pinnedId).catch(() => null);
            if (msg) await msg.unpin().catch(() => undefined);
          }
          delete labels[labelName];
          fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2));
        }
      } catch (err) {
        log.warn('Failed to unpin labeled message', { platformId, labelName, err });
      }
      return undefined;
    }

    // Reaction operation: add_reaction MCP tool emits a chat-kind row with
    // {operation: "reaction", messageId, emoji}. Translate to a Discord
    // reaction; do not post a chat message.
    if (content && content.operation === 'reaction') {
      const rawId = String(content.messageId || '');
      const discordMsgId = rawId.split(':')[0]; // strip :agentGroupId suffix
      const emojiName = String(content.emoji || '');
      const emojiUnicode = REACTION_EMOJI_MAP[emojiName] || emojiName;
      if (!this.client || !discordMsgId || !emojiUnicode) return undefined;
      try {
        const ch = await this.client.channels.fetch(platformId);
        if (ch && 'messages' in ch) {
          const msg = await (ch as TextChannel).messages.fetch(discordMsgId);
          await msg.react(emojiUnicode);
        }
      } catch (err) {
        log.warn('Failed to add Discord reaction', { discordMsgId, emojiName, err });
      }
      return undefined;
    }

    let text: string;
    if (typeof content === 'string') {
      text = content;
    } else if (content && typeof content.text === 'string') {
      text = content.text;
    } else if (content && content.type === 'card') {
      // Chat SDK card format — extract description as plain text
      const card = content.card as Record<string, unknown> | undefined;
      const parts = [card?.title, card?.description].filter(Boolean);
      text = parts.join('\n') || (content.fallbackText as string) || '';
      // Propagate label/pin/upsert from the card payload if present
      if (!content.label && card?.label) content.label = card.label;
      if (!content.pin && card?.pin) content.pin = card.pin;
      if (!content.upsert && card?.upsert) content.upsert = card.upsert;
    } else if (content && content.type === 'ask_question') {
      // Render as plain text question + numbered options (Discord button cards
      // require interactions wiring we don't have yet; this at least posts the question).
      const title = (content.title as string) || '';
      const question = (content.question as string) || '';
      const options = Array.isArray(content.options) ? (content.options as unknown[]) : [];
      const optLines = options.map((o, i) => {
        const label =
          typeof o === 'string' ? o : ((o as Record<string, unknown>)?.label as string) || `Option ${i + 1}`;
        return `${i + 1}. ${label}`;
      });
      text = [title && `**${title}**`, question, optLines.join('\n')].filter(Boolean).join('\n\n');
    } else {
      text = JSON.stringify(content);
    }

    // Strip <internal>...</internal> blocks and any standalone [no-reply]
    // line. The sentinel is supposed to be the ENTIRE response when staying
    // silent, but models occasionally emit it as a leading marker followed
    // by real content. Strip it wherever it appears on its own line so the
    // user-visible output stays clean.
    text = text
      .replace(/<internal>[\s\S]*?<\/internal>/g, '')
      .replace(/(^|\n)\s*\[no-reply\]\s*(?=\n|$)/gi, '')
      .trim();
    if (!text) return undefined;

    // Intra-message paragraph dedup. Gemini-3-flash often emits the same
    // greeting/ack twice within a single message body — e.g. the opening
    // "hiii mama ☀️ big stretchhh! ga ga ga🧡" is repeated as a near-
    // identical closing line, with the log narrative in between (seen
    // 2026-06-02 in #emilio-care). Our message-level dedup catches
    // duplicate separate messages but not duplicated paragraphs within
    // one. Split on blank lines, compare each paragraph's normalized
    // word-set Jaccard against earlier paragraphs, drop near-duplicates.
    {
      const paragraphs = text.split(/\n\s*\n/);
      if (paragraphs.length > 1) {
        const tokenize = (s: string): Set<string> => {
          const norm = s
            .toLowerCase()
            .replace(/\p{Extended_Pictographic}/gu, '')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .trim();
          return new Set(norm.split(/\s+/).filter((w) => w.length > 1));
        };
        const sets = paragraphs.map(tokenize);
        const keep: number[] = [];
        for (let i = 0; i < paragraphs.length; i++) {
          let isDup = false;
          for (const j of keep) {
            const a = sets[i];
            const b = sets[j];
            if (a.size < 3 || b.size < 3) continue;
            let inter = 0;
            for (const w of a) if (b.has(w)) inter++;
            const union = a.size + b.size - inter;
            const jaccard = union === 0 ? 0 : inter / union;
            if (jaccard >= 0.7) {
              isDup = true;
              break;
            }
          }
          if (!isDup) keep.push(i);
        }
        if (keep.length < paragraphs.length) {
          const before = text;
          text = keep
            .map((i) => paragraphs[i])
            .join('\n\n')
            .trim();
          log.warn('Stripped duplicate paragraph(s) within message', {
            platformId,
            removed: paragraphs.length - keep.length,
            preview: before.slice(0, 120),
          });
        }
      }
    }
    if (!text) return undefined;

    // Drop trailing "I've completed X" / "What was done:" style completion
    // summaries. The container/CLAUDE.md tells the agent the deliverable IS
    // the summary, but Gemini-3-flash repeatedly emits a second message
    // narrating what it just did. The pattern is recognizable and we'd
    // rather drop than deliver it.
    //
    // Heuristic: short-ish message that opens with a first-person past-tense
    // accomplishment verb, OR contains a "What was done:" / "Summary of
    // what I did" header. We don't filter mid-conversation messages that
    // happen to start with these phrases because real chat replies are
    // almost always longer than 800 chars by the time they include these
    // openers and don't tend to be the entire reply.
    if (
      text.length < 800 &&
      /^(I['’]ve|I have)\s+(posted|completed|finished|updated|sent|done|logged|created|added|scheduled|written|queued|deleted|removed)\b/i.test(
        text,
      )
    ) {
      log.warn('Dropped completion-summary message', {
        platformId,
        preview: text.slice(0, 100),
      });
      return undefined;
    }
    if (/^\*?\*?(What was done|Summary of what I did|Here['’]s (a |the )?summary)/i.test(text)) {
      log.warn('Dropped completion-summary message', {
        platformId,
        preview: text.slice(0, 100),
      });
      return undefined;
    }

    // #silverthorne: strip trailing "chores list" blocks Claudio keeps
    // appending to conversational replies. Pattern is a header line like
    // "Today's chores:" / "Open chores:" / "Remaining chores:" / "Here are
    // today's chores:" followed by a bullet or numbered list to EOM. Only
    // strip if there's a real conversational preamble (>40 chars of non-
    // list content) before the header — otherwise the user actually asked
    // for the list and we keep it.
    if (DiscordChannel.CHANNEL_FOLDERS[platformId] === 'discord_silverthorne') {
      const choresListHeader =
        /(^|\n)\s*\*{0,2}_{0,2}\s*(Today['’]s|Open|Remaining|Outstanding|Pending|Here(?:'s| are)(?: the| your)?(?: today's)?)\s+chores?:?\s*_{0,2}\*{0,2}\s*\n+([ \t]*(?:[-*•]|\d+[.)])\s+.+(?:\n|$))+/i;
      const m = text.match(choresListHeader);
      if (m && m.index !== undefined) {
        const preamble = text.slice(0, m.index).trim();
        if (preamble.length > 40) {
          log.warn('Stripped appended chores list', {
            platformId,
            preview: text.slice(m.index, m.index + 80),
          });
          text = preamble;
        }
      }
    }

    // #emilio-care: drop duplicate-text messages. Claudio reliably emits
    // the same ack twice per turn — once with `subtext` (intended as the
    // chime) and once plain (echo). Earlier keyword-based filters caught
    // most cases but false-positived on Macy's first reply, leaving her
    // with no acknowledgement. Dedup is precise: same exact text within
    // 30s in the same channel = drop the second occurrence. The first
    // message wins (usually the one carrying subtext).
    if (shouldDropAsDuplicate(platformId, text)) {
      log.warn('Dropped duplicate Claudio message', {
        platformId,
        preview: text.slice(0, 100),
      });
      return undefined;
    }

    // Superset detection: if an earlier shorter Claudio message is now
    // subsumed by this comprehensive one (same opening, more content),
    // delete the earlier one from the channel after this one lands.
    // Originally added for #emilio-care chime echoes; now applies to all
    // channels because the same model failure shows up in #silverthorne
    // (status card edits, "I've updated X" / "Apologies, I've fixed X"
    // pairs where the second supersedes the first).
    const supersetVictim = findSupersetVictim(platformId, text);
    if (supersetVictim?.platformMsgId) {
      const victimId = supersetVictim.platformMsgId;
      log.warn('Scheduling delete of superseded chime', {
        platformId,
        victim: victimId,
        victimPreview: supersetVictim.text.slice(0, 80),
      });
      forgetRecent(platformId, victimId);
      // Fire after a short delay so the new message lands first.
      setTimeout(() => {
        void (async () => {
          if (!this.client) return;
          try {
            const ch = await this.client.channels.fetch(platformId);
            if (ch && 'messages' in ch) {
              const oldMsg = await (ch as TextChannel).messages.fetch(victimId).catch(() => null);
              if (oldMsg) await oldMsg.delete().catch(() => undefined);
            }
          } catch (err) {
            log.warn('Failed to delete superseded chime', {
              victimId,
              err: (err as Error).message,
            });
          }
        })();
      }, 500);
    }

    // #family-fun pin/label strip: defense-in-depth against the model
    // re-pinning status cards. CLAUDE.local.md forbids `send_message` with
    // `pin: true` or any `label` in this channel, but the LLM ignores the
    // rule under conversational pressure (e.g. responding to confusion about
    // resets). Strip the flags so the message posts as a plain reply.
    if (
      DiscordChannel.CHANNEL_FOLDERS[platformId] === 'discord_family-fun' &&
      content &&
      typeof content === 'object' &&
      (content.label || content.pin || content.upsert)
    ) {
      log.warn('Stripped pin/label flags from #family-fun message', {
        platformId,
        label: content.label,
        pin: content.pin,
        upsert: content.upsert,
      });
      delete content.label;
      delete content.pin;
      delete content.upsert;
    }

    // #family-fun word redaction: defense-in-depth against the model
    // leaking today's Saga Wordle word in chat. The agent prompt already
    // says "never reveal", but gemini ignores it on rollover days. Read
    // wordle_state.json and replace any case-insensitive occurrence of
    // the active word with `*****`. Best-effort: missing or unreadable
    // state file means no redaction (we'd rather post than block).
    if (DiscordChannel.CHANNEL_FOLDERS[platformId] === 'discord_family-fun') {
      try {
        const statePath = path.resolve(process.cwd(), 'groups', 'discord_family-fun', 'wordle_state.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { word?: string; resolved?: boolean };
        const word = (state?.word || '').trim();
        if (word.length === 5 && state.resolved !== true) {
          const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
          if (re.test(text)) {
            log.warn('Redacted Saga Wordle word from outgoing message', { platformId });
            text = text.replace(re, '`*****`');
          }
        }
      } catch {
        /* state file missing or unreadable — let the message through */
      }
    }

    // #silverthorne URL-in-status-card scrub. Claudio routinely takes a
    // pet image URL from chat and pastes it INTO the status card text in
    // place of the pet's emoji (e.g. "https://i.imgur.com/... **Voss**"
    // where it should be "🌋 **Voss**"). The URL belongs in the persona
    // config, not in the rendered message. Replace the URL with the pet's
    // canonical emoji so the card renders cleanly.
    if (DiscordChannel.CHANNEL_FOLDERS[platformId] === 'discord_silverthorne') {
      const PET_EMOJIS: Record<string, string> = {
        Voss: '🌋',
        Nyx: '🌙',
        Zima: '❄️',
      };
      const scrubbed = text.replace(
        /https?:\/\/\S+\s+\*\*(Voss|Nyx|Zima)\*\*/g,
        (_, name) => `${PET_EMOJIS[name as keyof typeof PET_EMOJIS]} **${name}**`,
      );
      if (scrubbed !== text) {
        log.warn('Scrubbed inline image URL from silverthorne status card', {
          platformId,
        });
        text = scrubbed;
      }
    }

    // #silverthorne addressee rewrite. Claudio routinely greets the wrong
    // person ("Got it, Danny!" when Paden posted). Detect a household-name
    // greeting in the opening and rewrite to match the actual inbound
    // sender. Mirror of the emilio-care subtext rewrite below.
    if (DiscordChannel.CHANNEL_FOLDERS[platformId] === 'discord_silverthorne') {
      const recentSender = getRecentInboundSender(platformId);
      if (recentSender && EMILIO_HOUSEHOLD.has(recentSender)) {
        const match = text.match(
          /^((?:Got it|Apologies|Thanks|Thank you|Hey|Hi|Done|Sure|Okay|Ok|Roger|Noted)[,\s]+)(Paden|Brenda|Danny)([!,.\s])/i,
        );
        if (match && match[2] !== recentSender) {
          log.warn('Rewrote silverthorne addressee', {
            platformId,
            wrong: match[2],
            correct: recentSender,
          });
          text = text.replace(match[0], `${match[1]}${recentSender}${match[3]}`);
        }
      }
    }

    // #emilio-care chime-rescue: post-compaction, Claudio sometimes loses
    // the `send_message({sender:"Emilio", subtext:"..."})` example shape
    // and writes plain messages with the subtext line baked into the body:
    //   "Logged. He had a 3oz bottle at 1:15 PM.\n\nEmilio · 3oz Bottle · 1:15 PM"
    // Detect that tail, peel it off, and promote the message to a proper
    // webhook chime so the avatar + grey subtext at least render. Voice in
    // the body stays whatever Claudio wrote (a session reset is the real
    // voice fix); this is the structural belt-and-suspenders.
    if (
      DiscordChannel.CHANNEL_FOLDERS[platformId] === 'discord_emilio-care' &&
      content &&
      typeof content === 'object' &&
      typeof content.sender !== 'string' &&
      (typeof content.subtext !== 'string' || !content.subtext.trim())
    ) {
      const m = text.match(/\n+\s*Emilio\s*·\s*([^\n]+?)\s*$/);
      if (m) {
        const subtextLine = m[1].trim();
        const body = text.slice(0, m.index).trim();
        if (body && subtextLine) {
          log.warn('Promoted body-embedded Emilio chime line to proper chime', {
            platformId,
            subtextPreview: subtextLine.slice(0, 60),
          });
          text = body;
          (content as Record<string, unknown>).sender = 'Emilio';
          (content as Record<string, unknown>).subtext = subtextLine;
        }
      }
    }

    // #emilio-care attribution + non-household chime suppression. Claudio
    // routinely (a) defaults the chime's leading name to "Paden" regardless
    // of who actually posted, and (b) emits chimes for Macy/non-household
    // senders even though the CLAUDE.local.md rule forbids it. Both are
    // model-behavior failures we patch at the adapter.
    let suppressSubtext = false;
    if (
      DiscordChannel.CHANNEL_FOLDERS[platformId] === 'discord_emilio-care' &&
      content &&
      typeof content.subtext === 'string' &&
      content.subtext.trim()
    ) {
      const recentSender = getRecentInboundSender(platformId);
      if (recentSender) {
        const subtextStr = content.subtext.trim();
        const leadingName = subtextStr.split('·')[0]?.trim() ?? '';

        if (!EMILIO_HOUSEHOLD.has(recentSender)) {
          // Non-household sender (Macy, guests). Per channel rule: no
          // Emilio chime — strip the subtext + webhook persona so the
          // message renders as a plain Claudio reply.
          log.warn('Suppressing Emilio chime for non-household sender', {
            platformId,
            recentSender,
            originalSubtext: subtextStr,
          });
          suppressSubtext = true;
          if (content && typeof content === 'object') delete content.sender;
        } else if (leadingName && EMILIO_HOUSEHOLD.has(leadingName) && leadingName !== recentSender) {
          // Wrong-attribution: subtext starts with one parent's name but
          // a different one actually posted. Rewrite.
          log.warn('Rewrote chime subtext attribution', {
            platformId,
            wrong: leadingName,
            correct: recentSender,
          });
          (content as Record<string, unknown>).subtext = subtextStr.replace(
            new RegExp(`^${leadingName}`),
            recentSender,
          );
        }
      }
    }

    // Snapshot the body BEFORE subtext is appended. Dedup runs against the
    // pre-subtext body so a chime ("text\n-# subtext") and a same-text plain
    // echo collide on `bodyForDedup` and the second is dropped. Without this,
    // every Claudio chime in #emilio-care is followed 1-2s later by an
    // identical sender-less echo that slipped through dedup because the
    // recorded chime text carried the appended subtext caption.
    const bodyForDedup = text;

    // Append `-# subtext` for Discord small-text caption (e.g. "Paden · 3oz · 6:15 PM"
    // under an Emilio chime). Only added when the agent passes the dedicated
    // `subtext` field on send_message; we don't try to detect or auto-format.
    if (content && typeof content.subtext === 'string' && content.subtext.trim() && !suppressSubtext) {
      let subtext = content.subtext.trim();
      // Nap-close enrichment: if this is an emilio-care chime ending a nap
      // and the subtext doesn't already carry feeding context, append the
      // last-fed marker so parents can assess whether Emilio needs to eat.
      // Works for both the /awake slash path AND the agent-driven path
      // (Macy / anyone saying "he's awake" → Claudio logs sleep + emits a
      // chime). Best-effort: any failure silently returns ''.
      if (
        DiscordChannel.CHANNEL_FOLDERS[platformId] === 'discord_emilio-care' &&
        isNapCloseSubtext(subtext) &&
        !subtextAlreadyEnriched(subtext)
      ) {
        const suffix = await buildLastFedSuffix();
        if (suffix) subtext += suffix;
      }
      text = `${text}\n-# ${subtext}`;
    }

    // Webhook persona routing
    if (content && typeof content.sender === 'string' && WEBHOOK_PERSONAS[content.sender]) {
      const persona = WEBHOOK_PERSONAS[content.sender];
      const webhookMsgId = await this.sendWebhookMessage(platformId, text, persona.name, persona.avatar);
      recordRecentText(platformId, bodyForDedup, webhookMsgId ?? null);
      return webhookMsgId;
    }

    // Label/upsert: edit the existing pinned message if label is set
    if (content && typeof content.label === 'string' && (content.upsert || content.pin)) {
      const groupFolder = DiscordChannel.CHANNEL_FOLDERS[platformId];
      if (groupFolder) {
        const labelsPath = path.resolve(process.cwd(), 'data', 'sessions', groupFolder, 'message_labels.json');
        let pinnedId: string | null = null;
        try {
          const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
          pinnedId = labels?.[content.label as string]?.id ?? null;
        } catch {
          /* no label file yet */
        }

        if (pinnedId) {
          try {
            const ch = await this.client?.channels.fetch(platformId);
            if (ch && 'messages' in ch) {
              const msg = await (ch as TextChannel).messages.fetch(pinnedId);
              await msg.edit(text);
              return pinnedId;
            }
          } catch {
            pinnedId = null; // fall through to post new
          }
        }

        // No existing pin — post, optionally pin, save label
        const msgId = await this.sendMessageWithId(platformId, text);
        if (msgId && content.pin) {
          try {
            const ch = await this.client?.channels.fetch(platformId);
            if (ch && 'messages' in ch) {
              const msg = await (ch as TextChannel).messages.fetch(msgId);
              await msg.pin();
            }
            const labels = (() => {
              try {
                return JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
              } catch {
                return {};
              }
            })();
            labels[content.label as string] = { id: msgId, date: new Date().toISOString().slice(0, 10) };
            fs.mkdirSync(path.dirname(labelsPath), { recursive: true });
            fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2));
          } catch {
            /* best effort */
          }
        }
        return msgId;
      }
    }

    const plainMsgId = await this.sendMessageWithId(platformId, text);
    recordRecentText(platformId, bodyForDedup, plainMsgId ?? null);
    return plainMsgId;
  }

  private async sendMessageWithId(platformId: string, text: string): Promise<string | undefined> {
    if (!this.client) {
      log.warn('Discord client not initialized');
      return undefined;
    }
    try {
      const channel = await this.client.channels.fetch(platformId);
      if (!channel || !('send' in channel)) {
        log.warn('Discord channel not found or not text-based', { platformId });
        return undefined;
      }
      const textChannel = channel as TextChannel;
      const MAX_LENGTH = 2000;
      let lastId: string | undefined;
      if (text.length <= MAX_LENGTH) {
        const m = await textChannel.send(text);
        lastId = m.id;
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const m = await textChannel.send(text.slice(i, i + MAX_LENGTH));
          lastId = m.id;
        }
      }
      log.info('Discord message sent', { platformId, length: text.length });
      return lastId;
    } catch (err) {
      log.error('Failed to send Discord message', { platformId, err });
      return undefined;
    }
  }

  private async sendWebhookMessage(
    platformId: string,
    text: string,
    username: string,
    avatarURL?: string,
  ): Promise<string | undefined> {
    if (!this.client?.user) {
      log.warn('Discord webhook skipped: client not ready', { platformId, username });
      return undefined;
    }
    try {
      const channel = await this.client.channels.fetch(platformId);
      if (!channel || !('fetchWebhooks' in channel)) {
        log.warn('Discord webhook skipped: channel unavailable', { platformId, username });
        return undefined;
      }
      const textChannel = channel as TextChannel;

      let webhook = this.webhookCache.get(platformId);
      if (!webhook) {
        const existing = await textChannel.fetchWebhooks();
        const ownHooks = existing.filter((w) => w.owner?.id === this.client!.user!.id);
        webhook = ownHooks.find((w) => w.name === 'NanoClaw Pets');
        if (!webhook) {
          webhook = await textChannel.createWebhook({ name: 'NanoClaw Pets' });
        }
        this.webhookCache.set(platformId, webhook);
      }

      const msg = await webhook.send({ content: text, username, avatarURL });
      log.info('Discord webhook message sent', { platformId, username, length: text.length });
      return typeof msg === 'string' ? undefined : msg.id;
    } catch (err) {
      log.error('Failed to send Discord webhook message', { platformId, username, err });
      return undefined;
    }
  }

  async setTyping(platformId: string, _threadId: string | null): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(platformId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      log.debug('Failed to send Discord typing indicator', { platformId, err });
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  async teardown(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      log.info('Discord bot stopped');
    }
  }
}

registerChannelAdapter('discord', {
  factory: () => {
    const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
    const token = process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
    if (!token) {
      log.warn('Discord: DISCORD_BOT_TOKEN not set');
      return null;
    }
    return new DiscordChannel(token);
  },
});
