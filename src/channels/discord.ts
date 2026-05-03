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

const execFileAsync = promisify(execFile);

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
        const attachmentDescriptions = [...message.attachments.values()].map((att) => {
          const contentType = att.contentType || '';
          if (contentType.startsWith('image/')) {
            return `[Image: ${att.name || 'image'}]`;
          } else if (contentType.startsWith('video/')) {
            return `[Video: ${att.name || 'video'}]`;
          } else if (contentType.startsWith('audio/')) {
            return `[Audio: ${att.name || 'audio'}]`;
          } else {
            return `[File: ${att.name || 'file'}]`;
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
        if (interaction.commandName === 'saga') {
          await this.handleSagaCommand(interaction);
          return;
        }
        if (interaction.commandName === 'emilio-week') {
          await this.handleEmilioWeekCommand(interaction);
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
        if (interaction.customId.startsWith('saga_nav:')) {
          await this.handleSagaNav(interaction);
          return;
        }
        if (interaction.customId.startsWith('emilio_day:')) {
          await this.handleEmilioHistoryNav(interaction);
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
              .setName('saga')
              .setDescription('Read the full Saga Wordle story so far (#family-fun only)')
              .toJSON(),
            new SlashCommandBuilder()
              .setName('emilio-week')
              .setDescription("Show Emilio's feeding, sleep, and poop summary for the last 7 days (#emilio-care only)")
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

    await interaction.editReply(
      formatWordleReply({
        status: result.status || 'error',
        message: result.message,
        history: result.history,
        solved: result.solved,
        guess_num: result.guess_num,
        budget: result.budget,
        word: result.word,
      }),
    );
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
      }),
    );
    log.info('Wordle status slash command ran', {
      player,
      status: result.status,
      guesses: result.history?.length,
      solved: result.solved,
    });
  }

  // --- /saga ---

  private loadSagaChapters(): Array<{ day: number; date: string; word: string; text: string }> {
    const sagaPath = path.resolve(process.cwd(), 'groups', 'discord_family-fun', 'saga_state.json');
    const saga = JSON.parse(fs.readFileSync(sagaPath, 'utf8')) as {
      chapters?: Array<{ day: number; date: string; word: string; text: string }>;
    };
    return saga.chapters ?? [];
  }

  private buildSagaReply(
    chapters: Array<{ day: number; date: string; word: string; text: string }>,
    idx: number,
  ): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
    const ch = chapters[idx];
    const content = `**Day ${ch.day} of ${chapters.length} — ${ch.date} — ${ch.word.toUpperCase()}**\n\n${ch.text}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`saga_nav:${idx - 1}`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(idx === 0),
      new ButtonBuilder()
        .setCustomId(`saga_nav:${idx + 1}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(idx === chapters.length - 1),
    );
    return { content, components: [row] };
  }

  private async handleSagaCommand(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      log.warn('Failed to defer /saga interaction', { err });
      return;
    }

    const channelFolder = DiscordChannel.CHANNEL_FOLDERS[interaction.channelId];
    if (!channelFolder || channelFolder !== 'discord_family-fun') {
      await interaction.editReply('⚠️ `/saga` is only available in #family-fun.');
      return;
    }

    let chapters: Array<{ day: number; date: string; word: string; text: string }>;
    try {
      chapters = this.loadSagaChapters();
    } catch (err) {
      log.error('Failed to read saga_state.json', { err });
      await interaction.editReply('⚠️ Could not read saga state.');
      return;
    }

    if (chapters.length === 0) {
      await interaction.editReply('No saga chapters yet.');
      return;
    }

    await interaction.editReply(this.buildSagaReply(chapters, 0));
    log.info('/saga slash command ran', { chapters: chapters.length });
  }

  private async handleSagaNav(interaction: ButtonInteraction): Promise<void> {
    const idx = parseInt(interaction.customId.split(':')[1], 10);
    let chapters: Array<{ day: number; date: string; word: string; text: string }>;
    try {
      chapters = this.loadSagaChapters();
    } catch (err) {
      log.error('Failed to read saga_state.json for nav', { err });
      await interaction.update({ content: '⚠️ Could not read saga state.', components: [] });
      return;
    }

    if (isNaN(idx) || idx < 0 || idx >= chapters.length) {
      await interaction.update({ content: '⚠️ Invalid chapter.', components: [] });
      return;
    }

    await interaction.update(this.buildSagaReply(chapters, idx));
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

    await interaction.editReply(result.table);
    log.info('/emilio-week slash command ran');
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
      const dataLine = result.totalXp ? `${result.fact} · +${result.totalXp} XP` : result.fact;
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
      const res = await execFileAsync('node', [scriptPath, interaction.commandName, userId, ...args], {
        timeout: 30_000,
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

    // Strip <internal>...</internal> blocks and [no-reply] sentinel
    text = text
      .replace(/<internal>[\s\S]*?<\/internal>/g, '')
      .replace(/\s*\[no-reply\]\s*$/i, '')
      .trim();
    if (!text) return undefined;

    // Append `-# subtext` for Discord small-text caption (e.g. "Paden · 3oz · 6:15 PM"
    // under an Emilio chime). Only added when the agent passes the dedicated
    // `subtext` field on send_message; we don't try to detect or auto-format.
    if (content && typeof content.subtext === 'string' && content.subtext.trim()) {
      text = `${text}\n-# ${content.subtext.trim()}`;
    }

    // Webhook persona routing
    if (content && typeof content.sender === 'string' && WEBHOOK_PERSONAS[content.sender]) {
      const persona = WEBHOOK_PERSONAS[content.sender];
      return this.sendWebhookMessage(platformId, text, persona.name, persona.avatar);
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

    return this.sendMessageWithId(platformId, text);
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
