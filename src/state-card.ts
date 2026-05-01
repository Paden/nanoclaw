// Helper for state-card slash commands (/emilio, /chores, /pumps).
// Strips the AGENT REF section from build_status_card.mjs output — the agent
// needs row numbers for corrections, a user looking at the card does not.

const AGENT_REF_MARKER = '═══ AGENT REF';
const DISCORD_REPLY_MAX = 1900; // Discord hard-caps at 2000; leave room for "... (truncated)"

export function stripCard(output: string): string {
  const idx = output.indexOf(AGENT_REF_MARKER);
  const card = idx === -1 ? output : output.slice(0, idx);
  return card.replace(/\s+$/, '');
}

export function fitDiscordReply(text: string): string {
  if (text.length <= DISCORD_REPLY_MAX) return text;
  return `${text.slice(0, DISCORD_REPLY_MAX)}\n… (truncated)`;
}
