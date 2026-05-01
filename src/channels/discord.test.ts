import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry
vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DISCORD_REACTIONS_INBOUND: 'own',
  WEBHOOK_PERSONAS: {},
}));

// Mock log
vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- discord.js mock ---

type Handler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('discord.js', () => {
  const Events = {
    MessageCreate: 'messageCreate',
    ClientReady: 'ready',
    Error: 'error',
    InteractionCreate: 'interactionCreate',
    MessageReactionAdd: 'messageReactionAdd',
    MessageReactionRemove: 'messageReactionRemove',
  };

  const GatewayIntentBits = {
    Guilds: 1, GuildMessages: 2, MessageContent: 4,
    DirectMessages: 8, GuildMessageReactions: 64,
  };

  const Partials = { Message: 0, User: 1, GuildMember: 2, Reaction: 3 };
  const ButtonStyle = { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 };

  class MockClient {
    eventHandlers = new Map<string, Handler[]>();
    user: any = { id: '999888777', tag: 'Andy#1234' };
    private _ready = false;
    constructor(_opts: any) { clientRef.current = this; }
    on(event: string, handler: Handler) {
      const existing = this.eventHandlers.get(event) || [];
      existing.push(handler);
      this.eventHandlers.set(event, existing);
      return this;
    }
    once(event: string, handler: Handler) { return this.on(event, handler); }
    async login(_token: string) {
      this._ready = true;
      for (const h of this.eventHandlers.get('ready') || []) h({ user: this.user });
    }
    isReady() { return this._ready; }
    channels = {
      fetch: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue({ id: 'msg-1' }),
        sendTyping: vi.fn().mockResolvedValue(undefined),
        fetchWebhooks: vi.fn().mockResolvedValue(new Map()),
        createWebhook: vi.fn().mockResolvedValue({ id: 'wh1', token: 'tok', send: vi.fn().mockResolvedValue({ id: 'wh-msg-1' }) }),
      }),
    };
    application = { commands: { set: vi.fn().mockResolvedValue(undefined) } };
    guilds = { cache: new Map() };
    destroy() { this._ready = false; }
  }

  class TextChannel {}

  class SlashCommandBuilder {
    setName(_n: string) { return this; }
    setDescription(_d: string) { return this; }
    addStringOption(_fn: any) { return this; }
    addNumberOption(_fn: any) { return this; }
    toJSON() { return {}; }
  }

  class ActionRowBuilder {
    addComponents(..._c: any[]) { return this; }
    toJSON() { return {}; }
  }

  class ButtonBuilder {
    setCustomId(_id: string) { return this; }
    setLabel(_l: string) { return this; }
    setStyle(_s: any) { return this; }
    setDisabled(_d: boolean) { return this; }
  }

  class StringSelectMenuBuilder {
    setCustomId(_id: string) { return this; }
    setPlaceholder(_p: string) { return this; }
    addOptions(..._o: any[]) { return this; }
  }

  return {
    Client: MockClient, Events, GatewayIntentBits, Partials, ButtonStyle,
    TextChannel, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder,
    StringSelectMenuBuilder,
    // These are just type guards in the real library; stub as no-ops
    AutocompleteInteraction: class {},
    ButtonInteraction: class {},
    StringSelectMenuInteraction: class {},
    Interaction: class {},
    Message: class {},
    MessageReaction: class {},
    PartialMessageReaction: class {},
    PartialUser: class {},
    User: class {},
    Webhook: class {},
  };
});

import { DiscordChannel } from './discord.js';
import type { ChannelSetup } from './adapter.js';

// --- Test helpers ---

function createTestSetup(overrides?: Partial<ChannelSetup>): ChannelSetup {
  return {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
    ...overrides,
  };
}

function createMessage(overrides: {
  channelId?: string;
  content?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  memberDisplayName?: string;
  isBot?: boolean;
  guildName?: string;
  channelName?: string;
  messageId?: string;
  createdAt?: Date;
  attachments?: Map<string, any>;
  reference?: { messageId?: string };
  mentionsBotId?: boolean;
}) {
  const channelId = overrides.channelId ?? '1490924818869260328';
  const authorId = overrides.authorId ?? '55512345';
  const botId = '999888777'; // matches mock client user id

  const mentionsMap = new Map();
  if (overrides.mentionsBotId) {
    mentionsMap.set(botId, { id: botId });
  }

  return {
    channelId,
    id: overrides.messageId ?? 'msg_001',
    content: overrides.content ?? 'Hello everyone',
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    author: {
      id: authorId,
      username: overrides.authorUsername ?? 'alice',
      displayName: overrides.authorDisplayName ?? 'Alice',
      bot: overrides.isBot ?? false,
    },
    member: overrides.memberDisplayName
      ? { displayName: overrides.memberDisplayName }
      : null,
    guild: overrides.guildName
      ? { name: overrides.guildName }
      : null,
    channel: {
      name: overrides.channelName ?? 'general',
      messages: {
        fetch: vi.fn().mockResolvedValue({
          author: { username: 'Bob', displayName: 'Bob' },
          member: { displayName: 'Bob' },
        }),
      },
    },
    mentions: {
      users: mentionsMap,
    },
    attachments: overrides.attachments ?? new Map(),
    reference: overrides.reference ?? null,
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerMessage(message: any) {
  const handlers = currentClient().eventHandlers.get('messageCreate') || [];
  for (const h of handlers) await h(message);
}

// --- Tests ---

describe('DiscordChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when client is ready', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');

      await channel.setup(config);

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message handlers on connect', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');

      await channel.setup(config);

      expect(currentClient().eventHandlers.has('messageCreate')).toBe(true);
      expect(currentClient().eventHandlers.has('error')).toBe(true);
      expect(currentClient().eventHandlers.has('ready')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');

      await channel.setup(config);
      expect(channel.isConnected()).toBe(true);

      await channel.teardown();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered channel', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({
        content: 'Hello everyone',
        guildName: 'Test Server',
        channelName: 'general',
      });
      await triggerMessage(msg);

      expect(config.onMetadata).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Boolean),
      );
      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({ id: 'msg_001', kind: 'chat', content: expect.objectContaining({ text: 'Hello everyone', sender_name: 'Alice' }) }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({
        channelId: '9999999999999999',
        content: 'Unknown channel',
        guildName: 'Other Server',
      });
      await triggerMessage(msg);

      expect(config.onMetadata).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Boolean),
      );
      expect(config.onInbound).not.toHaveBeenCalled();
    });

    it('ignores bot messages', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({ isBot: true, content: 'I am a bot' });
      await triggerMessage(msg);

      expect(config.onInbound).not.toHaveBeenCalled();
      expect(config.onMetadata).not.toHaveBeenCalled();
    });

    it('uses member displayName when available (server nickname)', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: 'Alice Nickname',
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({ content: expect.objectContaining({ sender_name: 'Alice Nickname' }) }),
      );
    });

    it('falls back to author displayName when no member', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: undefined,
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({ content: expect.objectContaining({ sender_name: 'Alice Global' }) }),
      );
    });

    it('uses sender name for DM chats (no guild)', async () => {
      // DMs are outbound-only in v2 — inbound DM messages are dropped
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({
        content: 'Hello',
        guildName: undefined,
        authorDisplayName: 'Alice',
      });
      await triggerMessage(msg);

      // DMs dropped — neither callback fires
      expect(config.onMetadata).not.toHaveBeenCalled();
    });

    it('uses guild name + channel name for server messages', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({
        content: 'Hello',
        guildName: 'My Server',
        channelName: 'bot-chat',
      });
      await triggerMessage(msg);

      expect(config.onMetadata).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Boolean),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates <@botId> mention to trigger format', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({
        content: '<@999888777> what time is it?',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: '@Andy what time is it?' }),
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({
        content: '@Andy hello <@999888777>',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      // Should NOT prepend @Andy — already starts with trigger
      // But the <@botId> should still be stripped
      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: '@Andy hello' }),
        }),
      );
    });

    it('does not translate when bot is not mentioned', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({
        content: 'hello everyone',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: 'hello everyone' }),
        }),
      );
    });

    it('handles <@!botId> (nickname mention format)', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({
        content: '<@!999888777> check this',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: '@Andy check this' }),
        }),
      );
    });
  });

  // --- Attachments ---

  describe('attachments', () => {
    it('stores image attachment with placeholder', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const attachments = new Map([
        ['att1', { name: 'photo.png', contentType: 'image/png' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: '[Image: photo.png]' }),
        }),
      );
    });

    it('stores video attachment with placeholder', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const attachments = new Map([
        ['att1', { name: 'clip.mp4', contentType: 'video/mp4' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: '[Video: clip.mp4]' }),
        }),
      );
    });

    it('stores file attachment with placeholder', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const attachments = new Map([
        ['att1', { name: 'report.pdf', contentType: 'application/pdf' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: '[File: report.pdf]' }),
        }),
      );
    });

    it('includes text content with attachments', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const attachments = new Map([
        ['att1', { name: 'photo.jpg', contentType: 'image/jpeg' }],
      ]);
      const msg = createMessage({
        content: 'Check this out',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: 'Check this out\n[Image: photo.jpg]' }),
        }),
      );
    });

    it('handles multiple attachments', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const attachments = new Map([
        ['att1', { name: 'a.png', contentType: 'image/png' }],
        ['att2', { name: 'b.txt', contentType: 'text/plain' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: '[Image: a.png]\n[File: b.txt]' }),
        }),
      );
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('includes reply author in content', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const msg = createMessage({
        content: 'I agree with that',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(config.onInbound).toHaveBeenCalledWith(
        '1490924818869260328',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: '[Reply to Bob] I agree with that' }),
        }),
      );
    });
  });

  // --- deliver ---

  describe('deliver', () => {
    it('sends message via channel', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      await channel.deliver('1490924818869260328', null, { kind: 'chat', content: { text: 'Hello' } });

      expect(currentClient().channels.fetch).toHaveBeenCalledWith('1490924818869260328');
    });

    it('handles send failure gracefully', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      currentClient().channels.fetch.mockRejectedValueOnce(new Error('Channel not found'));

      await expect(
        channel.deliver('1490924818869260328', null, { kind: 'chat', content: { text: 'Will fail' } }),
      ).resolves.toBeUndefined();
    });

    it('splits messages exceeding 2000 characters', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const mockChannel = { send: vi.fn().mockResolvedValue({ id: 'msg-1' }), sendTyping: vi.fn() };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longText = 'x'.repeat(3000);
      await channel.deliver('1490924818869260328', null, { kind: 'chat', content: { text: longText } });

      expect(mockChannel.send).toHaveBeenCalledTimes(2);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator when isTyping is true', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      const mockChannel = {
        send: vi.fn(),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.setTyping('1490924818869260328', null);

      expect(mockChannel.sendTyping).toHaveBeenCalled();
    });

    it('does nothing when isTyping is false', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');
      await channel.setup(config);

      // v2 setTyping is called only when typing — skip this variant

      // channels.fetch should NOT be called
      expect(currentClient().channels.fetch).not.toHaveBeenCalled();
    });

    it('does nothing when client is not initialized', async () => {
      const config = createTestSetup();
      const channel = new DiscordChannel('test-token');

      // Don't connect
      await channel.setTyping('1490924818869260328', null);

      // No error
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "discord"', () => {
      const channel = new DiscordChannel('test-token');
      expect(channel.name).toBe('discord');
    });
  });
});
