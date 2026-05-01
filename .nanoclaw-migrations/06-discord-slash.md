# Discord Slash Commands

**Intent:** After `/add-discord` installs the v2 Discord channel, re-add all slash commands that were built on top of the v1 skill. The v2 Discord channel will have a different baseline — read it carefully before applying.

**How to apply:** Read `src/channels/discord.ts` in the v2 worktree after `/add-discord`, then add the following. Do not blindly paste — v2 may have restructured the class/imports.

---

## Imports to add

```typescript
import {
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  // ... (ActionRowBuilder already present from skill)
} from 'discord.js';
import { formatWordleReply, formatWordleStatusReply } from '../wordle-keyboard.js';
import { formatQotdStatusReply } from '../qotd-status.js';
import { stripCard, fitDiscordReply } from '../state-card.js';
```

---

## Static class members to add

```typescript
// Discord user ID → display name (used by /wordle, /qotd, /chore)
private static readonly PLAYER_NAMES: Record<string, string> = {
  '181867944404320256': 'Paden',
  '350815183804825600': 'Brenda',
  '280744944358916097': 'Danny',
};

// QOTD allowed users (Paden + Brenda only)
private static readonly QOTD_ALLOWED_USER_IDS = new Set([
  '181867944404320256',
  '350815183804825600',
]);

// State card commands — each wires a slash command to a group's build_status_card.mjs
private static readonly STATE_CARD_COMMANDS = [
  {
    name: 'emilio',
    description: "Show Emilio's today snapshot (#emilio-care only)",
    folder: 'discord_emilio-care',
    scriptPath: 'groups/discord_emilio-care/build_status_card.mjs',
  },
  {
    name: 'chore-status',
    description: 'Show chore + pet status card (#silverthorne only)',
    folder: 'discord_silverthorne',
    scriptPath: 'groups/discord_silverthorne/build_status_card.mjs',
  },
  {
    name: 'pumps',
    description: 'Show pumping status card (#liquid-gold only)',
    folder: 'discord_liquid-gold',
    scriptPath: 'groups/discord_liquid-gold/build_status_card.mjs',
  },
];
```

---

## Slash command registrations (add to the commands array in ready handler)

```typescript
new SlashCommandBuilder().setName('health')
  .setDescription('Run Claudio health check').toJSON(),
new SlashCommandBuilder().setName('wordle')
  .setDescription('Submit a 5-letter Wordle guess (#family-fun only)')
  .addStringOption(opt => opt.setName('word').setDescription('Your 5-letter guess')
    .setRequired(true).setMinLength(5).setMaxLength(5)).toJSON(),
new SlashCommandBuilder().setName('wordle-status')
  .setDescription("Show today's Wordle progress (#family-fun only)").toJSON(),
new SlashCommandBuilder().setName('saga')
  .setDescription('Read the full Saga Wordle story so far (#family-fun only)').toJSON(),
new SlashCommandBuilder().setName('emilio-week')
  .setDescription("Show Emilio's 7-day feeding/sleep/poop summary (#emilio-care only)").toJSON(),
new SlashCommandBuilder().setName('qotd')
  .setDescription('Answer a panda question (#panda only)')
  .addStringOption(opt => opt.setName('answer').setDescription('Your answer')
    .setRequired(true).setMinLength(1).setMaxLength(1500)).toJSON(),
new SlashCommandBuilder().setName('qotd-status')
  .setDescription('Show panda questions waiting for you (#panda only)').toJSON(),
...DiscordChannel.STATE_CARD_COMMANDS.map(c =>
  new SlashCommandBuilder().setName(c.name).setDescription(c.description).toJSON()),
new SlashCommandBuilder().setName('calendar')
  .setDescription("Show today's calendar agenda (#panda only)").toJSON(),
new SlashCommandBuilder().setName('chore')
  .setDescription('Check off a silverthorne chore (#silverthorne only)')
  .addStringOption(opt => opt.setName('chore').setDescription('Pick a chore')
    .setRequired(true).setAutocomplete(true)).toJSON(),
// Emilio care commands:
new SlashCommandBuilder().setName('asleep').setDescription('Log Emilio falling asleep (#emilio-care)')
  .addStringOption(opt => opt.setName('time').setDescription('Optional: 5m, 2:30pm. Defaults to now.').setRequired(false)).toJSON(),
new SlashCommandBuilder().setName('awake').setDescription('Close the open nap (#emilio-care)')
  .addStringOption(opt => opt.setName('time').setDescription('Optional: 5m, 2:30pm. Defaults to now.').setRequired(false)).toJSON(),
new SlashCommandBuilder().setName('feeding').setDescription('Log a feeding (#emilio-care)')
  .addNumberOption(opt => opt.setName('amount').setDescription('Ounces').setMinValue(0.1).setMaxValue(20).setRequired(true))
  .addStringOption(opt => opt.setName('time').setDescription('Optional time').setRequired(false))
  .addStringOption(opt => opt.setName('source').setDescription('Source').setRequired(false)
    .addChoices({ name: 'Formula', value: 'Formula' }, { name: 'Breast', value: 'Breast' })).toJSON(),
new SlashCommandBuilder().setName('update-feeding').setDescription('Correct a recent feeding (#emilio-care)')
  .addNumberOption(opt => opt.setName('amount').setDescription('Corrected oz').setMinValue(0.1).setMaxValue(20).setRequired(true))
  .addStringOption(opt => opt.setName('row').setDescription('Which feeding (autocomplete)').setRequired(false).setAutocomplete(true)).toJSON(),
new SlashCommandBuilder().setName('diaper').setDescription('Log a diaper change (#emilio-care)')
  .addStringOption(opt => opt.setName('type').setDescription('Diaper status').setRequired(true)
    .addChoices({ name: 'wet', value: 'wet' }, { name: 'Poopy', value: 'Poopy' }, { name: 'both', value: 'both' })).toJSON(),
```

---

## Interaction routing (add to InteractionCreate handler)

```typescript
// isChatInputCommand() block:
if (interaction.commandName === 'health') { await this.handleHealthCommand(interaction); return; }
if (interaction.commandName === 'wordle') { await this.handleWordleCommand(interaction); return; }
if (interaction.commandName === 'wordle-status') { await this.handleWordleStatusCommand(interaction); return; }
if (interaction.commandName === 'saga') { await this.handleSagaCommand(interaction); return; }
if (interaction.commandName === 'emilio-week') { await this.handleEmilioWeekCommand(interaction); return; }
if (interaction.commandName === 'qotd') { await this.handleQotdCommand(interaction); return; }
if (interaction.commandName === 'qotd-status') { await this.handleQotdStatusCommand(interaction); return; }
const stateCmd = DiscordChannel.STATE_CARD_COMMANDS.find(c => c.name === interaction.commandName);
if (stateCmd) { await this.handleStateCardCommand(interaction, stateCmd); return; }
if (interaction.commandName === 'calendar') { await this.handleCalendarCommand(interaction); return; }
if (interaction.commandName === 'chore') { await this.handleChoreCommand(interaction); return; }
if (['asleep','awake','feeding','update-feeding','diaper'].includes(interaction.commandName)) {
  await this.handleEmilioSlashCommand(interaction); return;
}

// isButton() block:
if (interaction.customId.startsWith('saga_nav:')) { await this.handleSagaNav(interaction); return; }
if (interaction.customId.startsWith('emilio_day:')) { await this.handleEmilioHistoryNav(interaction); return; }

// isAutocomplete() block:
if (interaction.commandName === 'chore') { await this.handleChoreAutocomplete(interaction); return; }
if (interaction.commandName === 'update-feeding') { await this.handleEmilioUpdateFeedingAutocomplete(interaction); return; }
```

---

## Handler methods to copy from old discord.ts

Copy these method bodies verbatim (they have no v2-breaking dependencies — they call scripts and read local files):

- `handleHealthCommand` — synthetic "health" message to pipeline
- `handleWordleCommand` — runs `scripts/wordle-slash.mjs`
- `handleWordleStatusCommand` — runs `scripts/wordle-status-slash.mjs`
- `handleSagaCommand` + `handleSagaNav` — reads `groups/discord_family-fun/saga_state.json`, Prev/Next buttons
- `handleEmilioWeekCommand` — runs `scripts/emilio-week-slash.mjs`
- `handleQotdCommand` — runs `scripts/qotd-slash.mjs`, may followUp with StringSelectMenu
- `handleQotdStatusCommand` — runs `scripts/qotd-status-slash.mjs`
- `handleStateCardCommand` — runs group's `build_status_card.mjs`; for `emilio`, adds Prev/Next Day buttons
- `handleCalendarCommand` — runs `scripts/calendar-slash.mjs`
- `handleChoreCommand` + `handleChoreAutocomplete` — runs `scripts/chore-slash.mjs`
- `handleEmilioSlashCommand` + `handleEmilioUpdateFeedingAutocomplete` — runs `scripts/emilio-slash.mjs`
- `handleQotdSelect` (StringSelectMenu handler) — followUp from `/qotd` when 2+ open questions
- Helper methods: `chicagoDateStr`, `prevDate`, `nextDate`, `runEmilioCard`, `buildEmilioHistoryReply`, `handleEmilioHistoryNav`
- Helper methods: `loadSagaChapters`, `buildSagaReply`

**OAuth env pattern** (used in all `execFileAsync` calls for scripts that need Google Sheets):
```typescript
env: {
  ...process.env,
  GOOGLE_OAUTH_CREDENTIALS:
    process.env.GOOGLE_OAUTH_CREDENTIALS ||
    path.resolve(process.cwd(), 'data', 'google-calendar', 'gcp-oauth.keys.json'),
  GOOGLE_CALENDAR_MCP_TOKEN_PATH:
    process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH ||
    path.resolve(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json'),
},
```

---

## Webhook persona + reaction support

Check if v2's Discord channel already supports webhooks and reactions. If not, re-add:

- `sendWebhookMessage()` method — looks up webhook by channel ID (cached in `webhookCache`), sends with name/avatar override. Falls back to regular `sendMessage` if no webhook found.
- Reaction handlers — `addReaction`, `removeReaction`, `DISCORD_REACTIONS_INBOUND` check in `Events.MessageReactionAdd` / `MessageReactionRemove`
- Inbound reaction routing — if `DISCORD_REACTIONS_INBOUND` is `'all'` or `'own'`, deliver reactions as messages to the agent pipeline
