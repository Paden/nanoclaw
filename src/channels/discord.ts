import {
  ActionRowBuilder,
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

import {
  ASSISTANT_NAME,
  DISCORD_REACTIONS_INBOUND,
  TRIGGER_PATTERN,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  OnReaction,
  ReactionEvent,
  RegisteredGroup,
} from '../types.js';
import {
  formatWordleReply,
  formatWordleStatusReply,
} from '../wordle-keyboard.js';
import { formatQotdStatusReply } from '../qotd-status.js';
import { stripCard, fitDiscordReply } from '../state-card.js';

const execFileAsync = promisify(execFile);

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onReaction?: OnReaction;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private webhookCache = new Map<string, Webhook>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [
        Partials.Message,
        Partials.User,
        Partials.GuildMember,
        Partials.Reaction,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      logger.info(
        {
          guildId: message.guildId,
          channelId: message.channelId,
          authorId: message.author.id,
          authorBot: message.author.bot,
          contentLen: message.content.length,
        },
        'Discord MessageCreate fired',
      );
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      // DMs are outbound-only. The bot only talks INTO DMs (status cards,
      // announcements, scheduled nudges); inbound DM text is ignored.
      // Slash commands (/wordle, /qotd, /health) still work because they
      // arrive via InteractionCreate, not MessageCreate.
      if (!message.guild) {
        logger.debug(
          { channelId: message.channelId, authorId: message.author.id },
          'Ignoring inbound DM (outbound-only)',
        );
        return;
      }

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Only guild channels reach here (DMs early-returned above).
      const textChannel = message.channel as TextChannel;
      const chatName = `${message.guild!.name} #${textChannel.name}`;

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
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
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          const repliedText = (repliedTo.content ?? '')
            .replace(/\s+/g, ' ')
            .trim();
          const snippet =
            repliedText.length > 200
              ? `${repliedText.slice(0, 200)}…`
              : repliedText;
          const quoted = snippet ? ` "${snippet}"` : '';
          content = `[Reply to ${replyAuthor}${quoted}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery. Always a guild here.
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'discord', true);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Reaction handlers — inbound only if DISCORD_REACTIONS_INBOUND !== 'off'.
    const handleReaction = async (
      reaction: MessageReaction | PartialMessageReaction,
      user: User | PartialUser,
      action: 'add' | 'remove',
    ) => {
      if (DISCORD_REACTIONS_INBOUND === 'off') return;
      if (!this.client?.user) return;
      // Ignore bot reactions (including our own) to prevent feedback loops.
      if (user.bot || user.id === this.client.user.id) return;

      try {
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
      } catch (err) {
        logger.debug({ err }, 'Failed to fetch partial reaction');
        return;
      }

      // v1: unicode only. Custom emoji have a non-null id.
      if (reaction.emoji.id !== null) {
        logger.debug(
          { emoji: reaction.emoji.name },
          'Skipping custom emoji reaction (v1 unicode only)',
        );
        return;
      }
      const emoji = reaction.emoji.name;
      if (!emoji) return;

      const msg = reaction.message;
      const chatJid = `dc:${msg.channelId}`;
      if (!this.opts.registeredGroups()[chatJid]) return;

      const onBotMessage = msg.author?.id === this.client.user.id;
      if (DISCORD_REACTIONS_INBOUND === 'own' && !onBotMessage) return;

      try {
        if (!user.partial && !('username' in user && user.username)) {
          await user.fetch();
        }
      } catch {
        /* ignore */
      }

      const userName =
        ('globalName' in user && user.globalName) ||
        ('username' in user && user.username) ||
        'Unknown';
      const timestamp = new Date().toISOString();
      const snippet = (msg.content || '').slice(0, 60);

      const event: ReactionEvent = {
        id: `${msg.id}:${user.id}:${emoji}:${action}:${timestamp}`,
        chat_jid: chatJid,
        message_id: msg.id,
        user_id: user.id,
        user_name: userName as string,
        emoji,
        action,
        timestamp,
        on_bot_message: onBotMessage,
        target_snippet: snippet,
      };

      this.opts.onReaction?.(chatJid, event);
      logger.info(
        { chatJid, action, emoji, user: userName },
        'Discord reaction event',
      );
    };

    this.client.on(Events.MessageReactionAdd, (reaction, user) =>
      handleReaction(reaction, user, 'add'),
    );
    this.client.on(Events.MessageReactionRemove, (reaction, user) =>
      handleReaction(reaction, user, 'remove'),
    );

    // Slash command handler. /health routes into the normal message pipeline
    // (synthetic "health" message, reply via sendMessage). /wordle and /qotd
    // are fully programmatic — they run host-side, reply via
    // interaction.editReply, and never spawn a container. /qotd may follow up
    // with an ephemeral StringSelectMenu when the user has 2+ open Qs; that
    // menu's callback lands here too (isStringSelectMenu).
    this.client.on(
      Events.InteractionCreate,
      async (interaction: Interaction) => {
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
          if (interaction.commandName === 'qotd') {
            await this.handleQotdCommand(interaction);
            return;
          }
          if (interaction.commandName === 'qotd-status') {
            await this.handleQotdStatusCommand(interaction);
            return;
          }
          const stateCmd = DiscordChannel.STATE_CARD_COMMANDS.find(
            (c) => c.name === interaction.commandName,
          );
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
            interaction.commandName === 'update-feeding'
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
        if (interaction.isStringSelectMenu()) {
          if (interaction.customId.startsWith('qotd:pick:')) {
            await this.handleQotdSelect(interaction);
            return;
          }
        }
      },
    );

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );

        // Register global slash commands. Global commands can take up to
        // an hour to propagate to all clients; re-registering the same
        // command set is a no-op, so it's safe to run on every startup.
        try {
          const commands = [
            new SlashCommandBuilder()
              .setName('health')
              .setDescription(
                'Run Claudio health check (containers, tasks, sheets, disk)',
              )
              .toJSON(),
            new SlashCommandBuilder()
              .setName('wordle')
              .setDescription(
                'Submit a 5-letter Wordle guess (#family-fun only)',
              )
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
              .setName('qotd')
              .setDescription(
                'Answer a panda question of the day (#panda only)',
              )
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
              .setDescription(
                'Show panda questions still waiting for you (#panda only)',
              )
              .toJSON(),
            ...DiscordChannel.STATE_CARD_COMMANDS.map((c) =>
              new SlashCommandBuilder()
                .setName(c.name)
                .setDescription(c.description)
                .toJSON(),
            ),
            new SlashCommandBuilder()
              .setName('calendar')
              .setDescription("Show today's calendar agenda (#panda only)")
              .toJSON(),
            new SlashCommandBuilder()
              .setName('chore')
              .setDescription(
                'Check off a silverthorne chore (#silverthorne only)',
              )
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
                opt
                  .setName('time')
                  .setDescription(
                    'Optional: 5m, 2:30pm, 14:30. Defaults to now.',
                  )
                  .setRequired(false),
              )
              .toJSON(),
            new SlashCommandBuilder()
              .setName('awake')
              .setDescription('Close the open nap (#emilio-care)')
              .addStringOption((opt) =>
                opt
                  .setName('time')
                  .setDescription(
                    'Optional: 5m, 2:30pm, 14:30. Defaults to now.',
                  )
                  .setRequired(false),
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
                opt
                  .setName('time')
                  .setDescription(
                    'Optional: 5m, 2:30pm, 14:30. Defaults to now.',
                  )
                  .setRequired(false),
              )
              .addStringOption((opt) =>
                opt
                  .setName('source')
                  .setDescription('Source (default Formula)')
                  .setRequired(false)
                  .addChoices(
                    { name: 'Formula', value: 'Formula' },
                    { name: 'Breast', value: 'Breast' },
                  ),
              )
              .toJSON(),
            new SlashCommandBuilder()
              .setName('update-feeding')
              .setDescription('Correct a recent feeding amount (#emilio-care)')
              .addNumberOption((opt) =>
                opt
                  .setName('amount')
                  .setDescription('Corrected oz')
                  .setMinValue(0.1)
                  .setMaxValue(20)
                  .setRequired(true),
              )
              .addStringOption((opt) =>
                opt
                  .setName('row')
                  .setDescription('Which feeding (autocomplete shows last 5)')
                  .setRequired(false)
                  .setAutocomplete(true),
              )
              .toJSON(),
          ];
          await readyClient.application.commands.set(commands);
          logger.info(
            { count: commands.length },
            'Registered Discord slash commands',
          );
        } catch (err) {
          logger.error({ err }, 'Failed to register Discord slash commands');
        }

        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  private async handleHealthCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
  ): Promise<void> {
    try {
      await interaction.reply({
        content: '🩺 Running health check...',
        ephemeral: true,
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to ack /health interaction');
    }

    const chatJid = `dc:${interaction.channelId}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
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

    this.opts.onMessage(chatJid, {
      id: `slash-health-${Date.now()}`,
      chat_jid: chatJid,
      sender: interaction.user.id,
      sender_name:
        interaction.user.globalName || interaction.user.username || 'Unknown',
      content: `@${ASSISTANT_NAME} health`,
      timestamp: new Date().toISOString(),
      is_from_me: false,
    });
  }

  private async handleWordleCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
  ): Promise<void> {
    // Defer immediately — the subprocess + sheets round-trip can exceed the
    // 3-second interaction reply window. Ephemeral so only the guesser sees.
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      logger.warn({ err }, 'Failed to defer /wordle interaction');
      return;
    }

    const chatJid = `dc:${interaction.channelId}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (group.folder !== 'discord_family-fun') {
      await interaction.editReply(
        '⚠️ `/wordle` is only available in #family-fun.',
      );
      return;
    }

    const rawGuess = interaction.options.getString('word', true);
    const guess = rawGuess.trim();
    if (!/^[A-Za-z]{5}$/.test(guess)) {
      await interaction.editReply(
        `⚠️ "${rawGuess}" isn't a 5-letter word (letters only).`,
      );
      return;
    }

    // Attribute the guess to the invoking player via their Discord ID.
    const player = DiscordChannel.PLAYER_NAMES[interaction.user.id];
    if (!player) {
      await interaction.editReply(
        "⚠️ You're not a registered Saga Wordle player.",
      );
      return;
    }

    const scriptPath = path.resolve(
      process.cwd(),
      'scripts',
      'wordle-slash.mjs',
    );
    let stdout: string;
    try {
      const res = await execFileAsync(
        'node',
        [
          scriptPath,
          player,
          guess,
          group.folder,
          interaction.user.id,
          interaction.channelId,
        ],
        { timeout: 20_000, maxBuffer: 1_000_000 },
      );
      stdout = res.stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      logger.error(
        {
          err: e.message,
          stdout: e.stdout,
          stderr: e.stderr,
          player,
          guess,
          folder: group.folder,
        },
        'wordle-slash.mjs failed',
      );
      await interaction.editReply(
        `⚠️ Scoring failed: ${e.message || 'unknown error'}`,
      );
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
      const lastLine = stdout.trim().split('\n').pop() || '{}';
      result = JSON.parse(lastLine);
    } catch (err) {
      logger.error({ err, stdout }, 'wordle-slash.mjs returned non-JSON');
      await interaction.editReply('⚠️ Scoring returned unparseable output.');
      return;
    }

    if (result.submission_audit_error) {
      logger.warn(
        { err: result.submission_audit_error, player, guess },
        'Wordle submissions audit append failed',
      );
    }

    const reply = formatWordleReply({
      status: result.status || 'error',
      message: result.message,
      history: result.history,
      solved: result.solved,
      guess_num: result.guess_num,
      budget: result.budget,
      word: result.word,
    });

    await interaction.editReply(reply);
    logger.info(
      {
        player,
        guess: guess.toUpperCase(),
        status: result.status,
        solved: result.solved,
        guessNum: result.guess_num,
      },
      'Wordle slash command scored',
    );
  }

  private async handleWordleStatusCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
  ): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      logger.warn({ err }, 'Failed to defer /wordle-status interaction');
      return;
    }

    const chatJid = `dc:${interaction.channelId}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (group.folder !== 'discord_family-fun') {
      await interaction.editReply(
        '⚠️ `/wordle-status` is only available in #family-fun.',
      );
      return;
    }

    const player = DiscordChannel.PLAYER_NAMES[interaction.user.id];
    if (!player) {
      await interaction.editReply(
        "⚠️ You're not a registered Saga Wordle player.",
      );
      return;
    }

    const scriptPath = path.resolve(
      process.cwd(),
      'scripts',
      'wordle-status-slash.mjs',
    );
    let stdout: string;
    try {
      const res = await execFileAsync('node', [scriptPath, player], {
        timeout: 20_000,
        maxBuffer: 1_000_000,
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      logger.error(
        { err: e.message, stdout: e.stdout, stderr: e.stderr, player },
        'wordle-status-slash.mjs failed',
      );
      await interaction.editReply(
        `⚠️ Status lookup failed: ${e.message || 'unknown error'}`,
      );
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
      const lastLine = stdout.trim().split('\n').pop() || '{}';
      result = JSON.parse(lastLine);
    } catch (err) {
      logger.error(
        { err, stdout },
        'wordle-status-slash.mjs returned non-JSON',
      );
      await interaction.editReply('⚠️ Status returned unparseable output.');
      return;
    }

    const reply = formatWordleStatusReply({
      status: result.status || 'error',
      message: result.message,
      history: result.history,
      budget: result.budget,
      solved: result.solved,
      word: result.word,
    });

    await interaction.editReply(reply);
    logger.info(
      {
        player,
        status: result.status,
        guesses: result.history?.length,
        solved: result.solved,
      },
      'Wordle status slash command ran',
    );
  }

  // --- /qotd ---

  // Panda question-of-the-day intake. Deterministic, host-side:
  //   discovery → 0 open Qs  → "caught_up"
  //              → 1 open Q   → append directly
  //              → 2+ open Qs → return ephemeral StringSelectMenu
  //   forced-Q  → append directly (post-menu pick)
  //
  // Allowlist: Paden + Brenda only (no Danny). Pending-menu state is kept in
  // an in-memory Map keyed by a short custom_id token; entries self-expire.
  private qotdPending = new Map<
    string,
    { userId: string; player: string; answer: string; expiresAt: number }
  >();

  private static readonly QOTD_ALLOWED_USER_IDS = new Set([
    '181867944404320256', // Paden
    '350815183804825600', // Brenda
  ]);

  // Discord user ID → player display name. Used by /wordle (family-fun) and
  // /qotd (panda) to attribute submissions once we no longer derive the name
  // from a DM folder slug.
  private static readonly PLAYER_NAMES: Record<string, string> = {
    '181867944404320256': 'Paden',
    '350815183804825600': 'Brenda',
    '280744944358916097': 'Danny',
  };

  // Read-only state cards. Each entry wires a slash command to the group's
  // existing build_status_card.mjs, which already produces the agent's pinned
  // card output. The slash variant strips the trailing AGENT REF section and
  // replies ephemerally — no container wake, no card edit.
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
      description:
        'Show the silverthorne chore + pet status card (#silverthorne only)',
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

  private async handleQotdCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
  ): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      logger.warn({ err }, 'Failed to defer /qotd interaction');
      return;
    }

    if (!DiscordChannel.QOTD_ALLOWED_USER_IDS.has(interaction.user.id)) {
      await interaction.editReply(
        '⚠️ `/qotd` is just for Paden and Brenda — panda game is theirs.',
      );
      return;
    }

    const chatJid = `dc:${interaction.channelId}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (group.folder !== 'discord_parents') {
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

    const result = await this.runQotdScript([
      player,
      interaction.user.id,
      answer,
    ]);
    if (!result) {
      await interaction.editReply('⚠️ Scoring returned unparseable output.');
      return;
    }

    if (result.ok === false || result.status === 'error') {
      await interaction.editReply(
        `⚠️ ${result.message || 'Something went wrong recording that.'}`,
      );
      return;
    }

    if (result.status === 'caught_up') {
      await interaction.editReply(
        result.message ||
          "You're all caught up — no open panda Qs for you right now.",
      );
      return;
    }

    if (result.status === 'appended') {
      await interaction.editReply(
        `✅ Logged for Q${result.qNum} — _${result.question}_`,
      );
      return;
    }

    if (result.status === 'needs_choice' && Array.isArray(result.candidates)) {
      const token = `${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 8)}`;
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
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        select,
      );

      await interaction.editReply({
        content: `You have ${result.candidates.length} open panda Qs — which one does this answer go to?`,
        components: [row],
      });
      return;
    }

    await interaction.editReply(
      `⚠️ Unexpected response: ${JSON.stringify(result)}`,
    );
  }

  private async handleQotdSelect(
    interaction: StringSelectMenuInteraction,
  ): Promise<void> {
    try {
      await interaction.deferUpdate();
    } catch (err) {
      logger.warn({ err }, 'Failed to deferUpdate qotd select');
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
      await interaction.editReply({
        content: "⚠️ That picker isn't yours.",
        components: [],
      });
      return;
    }
    this.qotdPending.delete(token);

    const qNum = interaction.values[0];
    const result = await this.runQotdScript([
      pending.player,
      pending.userId,
      pending.answer,
      qNum,
    ]);
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

  private async handleQotdStatusCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
  ): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      logger.warn({ err }, 'Failed to defer /qotd-status interaction');
      return;
    }

    if (!DiscordChannel.QOTD_ALLOWED_USER_IDS.has(interaction.user.id)) {
      await interaction.editReply(
        '⚠️ `/qotd-status` is just for Paden and Brenda.',
      );
      return;
    }

    const chatJid = `dc:${interaction.channelId}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (group.folder !== 'discord_parents') {
      await interaction.editReply(
        '⚠️ `/qotd-status` is only available in #panda.',
      );
      return;
    }

    const scriptPath = path.resolve(
      process.cwd(),
      'scripts',
      'qotd-status-slash.mjs',
    );
    let stdout: string;
    try {
      const res = await execFileAsync(
        'node',
        [scriptPath, interaction.user.id],
        { timeout: 20_000, maxBuffer: 1_000_000 },
      );
      stdout = res.stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      logger.error(
        {
          err: e.message,
          stdout: e.stdout,
          stderr: e.stderr,
          userId: interaction.user.id,
        },
        'qotd-status-slash.mjs failed',
      );
      await interaction.editReply(
        `⚠️ Status lookup failed: ${e.message || 'unknown error'}`,
      );
      return;
    }

    let result: {
      ok?: boolean;
      status?: string;
      message?: string;
      currentQNum?: number;
      currentDay?: number;
      today?: string;
      open?: Array<{
        qNum: number;
        day: number;
        date: string;
        question: string;
      }>;
      skippedOpen?: Array<{
        qNum: number;
        day: number;
        date: string;
        question: string;
      }>;
      totalAnswered?: number;
    };
    try {
      const lastLine = stdout.trim().split('\n').pop() || '{}';
      result = JSON.parse(lastLine);
    } catch (err) {
      logger.error({ err, stdout }, 'qotd-status-slash.mjs returned non-JSON');
      await interaction.editReply('⚠️ Status returned unparseable output.');
      return;
    }

    const reply = formatQotdStatusReply({
      status: result.status || 'error',
      message: result.message,
      currentQNum: result.currentQNum,
      currentDay: result.currentDay,
      today: result.today,
      open: result.open,
      skippedOpen: result.skippedOpen,
      totalAnswered: result.totalAnswered,
    });

    await interaction.editReply(reply);
    logger.info(
      {
        userId: interaction.user.id,
        status: result.status,
        open: result.open?.length,
        currentQNum: result.currentQNum,
      },
      'Qotd status slash command ran',
    );
  }

  private async handleStateCardCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
    cfg: (typeof DiscordChannel.STATE_CARD_COMMANDS)[number],
  ): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      logger.warn({ err }, `Failed to defer /${cfg.name} interaction`);
      return;
    }

    const chatJid = `dc:${interaction.channelId}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (group.folder !== cfg.folder) {
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
          // Route sheets.mjs at the host-local OAuth artifacts, same as
          // wordle-slash / qotd-slash wrappers do.
          GOOGLE_OAUTH_CREDENTIALS:
            process.env.GOOGLE_OAUTH_CREDENTIALS ||
            path.resolve(
              process.cwd(),
              'data',
              'google-calendar',
              'gcp-oauth.keys.json',
            ),
          GOOGLE_CALENDAR_MCP_TOKEN_PATH:
            process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
            path.resolve(
              os.homedir(),
              '.config',
              'google-calendar-mcp',
              'tokens.json',
            ),
        },
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      logger.error(
        {
          err: e.message,
          stdout: e.stdout,
          stderr: e.stderr,
          script: cfg.scriptPath,
        },
        `/${cfg.name} script failed`,
      );
      await interaction.editReply(
        `⚠️ Status lookup failed: ${e.message || 'unknown error'}`,
      );
      return;
    }

    const card = stripCard(stdout);
    if (!card) {
      await interaction.editReply('⚠️ Card script returned empty output.');
      return;
    }
    await interaction.editReply(fitDiscordReply(card));
    logger.info(
      { command: cfg.name, folder: cfg.folder, cardLength: card.length },
      'State-card slash command ran',
    );
  }

  private async handleCalendarCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
  ): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      logger.warn({ err }, 'Failed to defer /calendar interaction');
      return;
    }

    const chatJid = `dc:${interaction.channelId}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (group.folder !== 'discord_parents') {
      await interaction.editReply(
        '⚠️ `/calendar` is only available in #panda.',
      );
      return;
    }

    const scriptPath = path.resolve(
      process.cwd(),
      'scripts',
      'calendar-slash.mjs',
    );
    let stdout: string;
    try {
      const res = await execFileAsync('node', [scriptPath], {
        timeout: 20_000,
        maxBuffer: 2_000_000,
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      logger.error(
        { err: e.message, stdout: e.stdout, stderr: e.stderr },
        '/calendar script failed',
      );
      await interaction.editReply(
        `⚠️ Calendar lookup failed: ${e.message || 'unknown error'}`,
      );
      return;
    }
    const card = stdout.replace(/\s+$/, '');
    if (!card) {
      await interaction.editReply('⚠️ Calendar script returned empty output.');
      return;
    }
    await interaction.editReply(fitDiscordReply(card));
    logger.info({ cardLength: card.length }, '/calendar slash command ran');
  }

  private async handleChoreAutocomplete(
    interaction: AutocompleteInteraction,
  ): Promise<void> {
    const chatJid = `dc:${interaction.channelId}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group || group.folder !== 'discord_silverthorne') {
      try {
        await interaction.respond([]);
      } catch {
        /* ignore */
      }
      return;
    }
    const focused = interaction.options.getFocused();
    const scriptPath = path.resolve(
      process.cwd(),
      'scripts',
      'chore-slash.mjs',
    );
    try {
      const res = await execFileAsync(
        'node',
        [scriptPath, 'autocomplete', interaction.user.id, focused],
        { timeout: 2500, maxBuffer: 1_000_000 },
      );
      const lastLine = res.stdout.trim().split('\n').pop() || '{}';
      const parsed = JSON.parse(lastLine) as {
        ok?: boolean;
        options?: Array<{ value: string; label: string }>;
      };
      const choices = (parsed.options || []).slice(0, 25).map((o) => ({
        // Discord caps each at 100 chars
        name: o.label.slice(0, 100),
        value: o.value.slice(0, 100),
      }));
      await interaction.respond(choices);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, userId: interaction.user.id },
        'chore autocomplete failed; returning empty choices',
      );
      try {
        await interaction.respond([]);
      } catch {
        /* ignore */
      }
    }
  }

  private async handleChoreCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
  ): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      logger.warn({ err }, 'Failed to defer /chore interaction');
      return;
    }

    const chatJid = `dc:${interaction.channelId}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await interaction.editReply('⚠️ This channel is not registered.');
      return;
    }
    if (group.folder !== 'discord_silverthorne') {
      await interaction.editReply(
        '⚠️ `/chore` is only available in #silverthorne.',
      );
      return;
    }

    const value = interaction.options.getString('chore', true);
    const scriptPath = path.resolve(
      process.cwd(),
      'scripts',
      'chore-slash.mjs',
    );
    let stdout: string;
    try {
      const res = await execFileAsync(
        'node',
        [scriptPath, 'submit', interaction.user.id, value],
        { timeout: 25_000, maxBuffer: 2_000_000 },
      );
      stdout = res.stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      logger.error(
        {
          err: e.message,
          stdout: e.stdout,
          stderr: e.stderr,
          userId: interaction.user.id,
          value,
        },
        '/chore submit failed',
      );
      await interaction.editReply(
        `⚠️ Chore log failed: ${e.message || 'unknown error'}`,
      );
      return;
    }

    let result: {
      ok?: boolean;
      error?: string;
      doneBy?: string;
      petName?: string;
      fact?: string;
      voice?: string;
      totalXp?: number;
      chores?: Array<{
        chore_id: string;
        name?: string;
        xp?: number;
        skipped?: string;
        error?: string;
      }>;
    };
    try {
      const lastLine = stdout.trim().split('\n').pop() || '{}';
      result = JSON.parse(lastLine);
    } catch (err) {
      logger.error({ err, stdout }, '/chore-slash returned non-JSON');
      await interaction.editReply('⚠️ Chore log returned unparseable output.');
      return;
    }

    if (!result.ok) {
      await interaction.editReply(
        `⚠️ ${result.error || 'something went wrong'}`,
      );
      return;
    }

    // Ephemeral confirmation to the clicker
    const doneChores = (result.chores || []).filter((c) => c.xp && !c.skipped);
    const skippedChores = (result.chores || []).filter((c) => c.skipped);
    const ackLines: string[] = [];
    if (doneChores.length) {
      for (const c of doneChores) {
        ackLines.push(`✅ ${c.name} · +${c.xp} XP`);
      }
    }
    for (const c of skippedChores) {
      ackLines.push(`↩ ${c.name} · already logged`);
    }
    if (!ackLines.length) ackLines.push('Nothing new to log.');
    await interaction.editReply(ackLines.join('\n'));

    // Public webhook pet ack — only if something actually happened.
    // Format mirrors the emilio-care fold: pet voice on top, dim data subtitle below.
    if (doneChores.length && result.petName && result.fact) {
      const dataLine = result.totalXp
        ? `${result.fact} · +${result.totalXp} XP`
        : result.fact;
      const text = result.voice ? `${result.voice}\n-# ${dataLine}` : dataLine;

      // IPC drop routes through webhook because `sender` matches a persona in
      // groups/discord_silverthorne/webhook_personas.json.
      const ipcFile = path.resolve(
        process.cwd(),
        'data',
        'ipc',
        'discord_silverthorne',
        'messages',
        `chore-ack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
      );
      try {
        await fs.promises.writeFile(
          ipcFile,
          JSON.stringify({
            type: 'message',
            chatJid,
            sender: result.petName,
            text,
          }),
        );
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, ipcFile },
          'Failed to drop pet webhook IPC for /chore',
        );
      }
    }

    logger.info(
      {
        userId: interaction.user.id,
        value,
        doneCount: doneChores.length,
        totalXp: result.totalXp,
      },
      '/chore slash command ran',
    );
  }

  private async handleEmilioSlashCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
  ): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      logger.warn(
        { err, command: interaction.commandName },
        'Failed to defer Emilio slash interaction',
      );
      return;
    }

    const userId = interaction.user.id;
    const args: string[] = [];
    if (
      interaction.commandName === 'asleep' ||
      interaction.commandName === 'awake'
    ) {
      args.push(interaction.options.getString('time') || '');
    } else if (interaction.commandName === 'feeding') {
      args.push(String(interaction.options.getNumber('amount', true)));
      args.push(interaction.options.getString('time') || '');
      args.push(interaction.options.getString('source') || '');
    } else {
      // update-feeding
      args.push(String(interaction.options.getNumber('amount', true)));
      args.push(interaction.options.getString('row') || '');
    }

    const scriptPath = path.resolve(
      process.cwd(),
      'scripts',
      'emilio-slash.mjs',
    );
    let stdout: string;
    try {
      const res = await execFileAsync(
        'node',
        [scriptPath, interaction.commandName, userId, ...args],
        { timeout: 30_000, maxBuffer: 1_000_000 },
      );
      stdout = res.stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      logger.error(
        {
          err: e.message,
          stdout: e.stdout,
          stderr: e.stderr,
          userId,
          command: interaction.commandName,
          args,
        },
        'emilio-slash.mjs failed',
      );
      await interaction.editReply(
        `⚠️ slash error: ${e.message || 'unknown error'}`,
      );
      return;
    }

    let result: { ok?: boolean; reply?: string; error?: string };
    try {
      const lastLine = stdout.trim().split('\n').pop() || '{}';
      result = JSON.parse(lastLine);
    } catch (err) {
      logger.error(
        { err, stdout, command: interaction.commandName },
        'emilio-slash returned non-JSON',
      );
      await interaction.editReply('⚠️ slash returned unparseable output.');
      return;
    }

    if (result.ok) {
      await interaction.editReply(result.reply || 'Done.');
    } else {
      await interaction.editReply(`⚠️ ${result.error || 'Unknown error'}`);
    }

    logger.info(
      {
        userId,
        command: interaction.commandName,
        ok: result.ok,
      },
      'emilio slash command ran',
    );
  }

  private async handleEmilioUpdateFeedingAutocomplete(
    interaction: AutocompleteInteraction,
  ): Promise<void> {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'row') {
      try {
        await interaction.respond([]);
      } catch {
        /* ignore */
      }
      return;
    }
    const scriptPath = path.resolve(
      process.cwd(),
      'scripts',
      'emilio-slash.mjs',
    );
    try {
      const res = await execFileAsync(
        'node',
        [scriptPath, 'autocomplete-feeding-row', interaction.user.id],
        { timeout: 5_000, maxBuffer: 200_000 },
      );
      const lastLine = res.stdout.trim().split('\n').pop() || '{}';
      const parsed = JSON.parse(lastLine) as {
        ok?: boolean;
        options?: Array<{ value: string; label: string }>;
      };
      const choices = (parsed.options || []).slice(0, 25).map((o) => ({
        name: o.label.slice(0, 100),
        value: o.value.slice(0, 100),
      }));
      await interaction.respond(choices);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, userId: interaction.user.id },
        'update-feeding autocomplete failed; returning empty choices',
      );
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
      const e = err as { stdout?: string; stderr?: string; message?: string };
      logger.error(
        { err: e.message, stdout: e.stdout, stderr: e.stderr, args },
        'qotd-slash.mjs failed',
      );
      return null;
    }
    try {
      const lastLine = stdout.trim().split('\n').pop() || '{}';
      return JSON.parse(lastLine);
    } catch (err) {
      logger.error({ err, stdout }, 'qotd-slash.mjs returned non-JSON');
      return null;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  async sendMessageWithId(
    jid: string,
    text: string,
  ): Promise<string | undefined> {
    if (!this.client) return undefined;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return undefined;
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
      return lastId;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message with id');
      return undefined;
    }
  }

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.edit(text.slice(0, 2000));
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to edit Discord message');
    }
  }

  async deleteMessage(jid: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.delete();
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to delete Discord message');
    }
  }

  async pinMessage(jid: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.pin();
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to pin Discord message');
    }
  }

  async unpinMessage(jid: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.unpin();
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to unpin Discord message');
    }
  }

  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.react(emoji);
      logger.info({ jid, messageId, emoji }, 'Discord reaction added');
    } catch (err) {
      logger.error(
        { jid, messageId, emoji, err },
        'Failed to add Discord reaction',
      );
    }
  }

  async removeReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.client?.user) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      const r = msg.reactions.resolve(emoji);
      if (r) await r.users.remove(this.client.user.id);
      logger.info({ jid, messageId, emoji }, 'Discord reaction removed');
    } catch (err) {
      logger.error(
        { jid, messageId, emoji, err },
        'Failed to remove Discord reaction',
      );
    }
  }

  async sendWebhookMessage(
    jid: string,
    text: string,
    username: string,
    avatarURL?: string,
  ): Promise<string | undefined> {
    if (!this.client?.user) {
      logger.warn(
        { jid, username },
        'Discord webhook skipped: client not ready',
      );
      return undefined;
    }
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        logger.warn(
          { jid, username, channelId },
          'Discord webhook skipped: channel fetch returned null',
        );
        return undefined;
      }
      if (!('fetchWebhooks' in channel)) {
        logger.warn(
          { jid, username, channelId, channelType: channel.type },
          'Discord webhook skipped: channel does not support webhooks',
        );
        return undefined;
      }
      const textChannel = channel as TextChannel;

      // Lazily create or reuse a shared webhook per channel
      let webhook = this.webhookCache.get(channelId);
      if (!webhook) {
        const existing = await textChannel.fetchWebhooks();
        const ownHooks = existing.filter(
          (w) => w.owner?.id === this.client!.user!.id,
        );
        webhook = ownHooks.find((w) => w.name === 'NanoClaw Pets');
        if (!webhook) {
          logger.info(
            {
              jid,
              channelId,
              existingCount: existing.size,
              ownCount: ownHooks.size,
              existingNames: existing.map((w) => w.name),
            },
            'Discord webhook: creating new NanoClaw Pets hook',
          );
          webhook = await textChannel.createWebhook({
            name: 'NanoClaw Pets',
          });
        }
        this.webhookCache.set(channelId, webhook);
      }

      const msg = await webhook.send({
        content: text,
        username,
        avatarURL,
      });
      logger.info(
        { jid, username, length: text.length },
        'Discord webhook message sent',
      );
      return typeof msg === 'string' ? undefined : msg.id;
    } catch (err) {
      logger.error(
        { jid, username, err },
        'Failed to send Discord webhook message',
      );
      return undefined;
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
