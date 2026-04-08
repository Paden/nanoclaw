import { Channel, NewMessage } from './types.js';
import { logger } from './logger.js';
import { formatLocalTime } from './timezone.js';

// Phrases that the agent sometimes hallucinates when a tool call silently
// fails — a prior bug where the MCP allowlist silently disallowed Sheets
// caused the agent to invent "Sheets are offline" rather than surface the
// real error. We detect these outbound and log loudly so they show up in
// the daily operator digest. We do NOT mutate the message — the prompt
// rule in global CLAUDE.md asks the agent not to cry wolf; this is a
// belt-and-suspenders detector, not a rewriter.
const CRY_WOLF_PATTERNS: RegExp[] = [
  /\bsheets?\b.{0,20}\b(offline|unavailable|down|not (?:reachable|responding))\b/i,
  /\bcalendar\b.{0,20}\b(offline|unavailable|down)\b/i,
  /\b(bot|service|system)\b.{0,20}\b(offline|unavailable|down)\b/i,
  /\bi(?:'| a)m (?:offline|down|unavailable)\b/i,
  /\bwhen (?:sheets?|calendar|it) (?:comes?|come) back\b/i,
];

export function detectCryWolf(text: string): string | null {
  for (const re of CRY_WOLF_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" id="${escapeXml(m.id)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  const match = detectCryWolf(text);
  if (match) {
    logger.error(
      { match, preview: text.slice(0, 240) },
      'CRY-WOLF DETECTED — agent claimed service is offline. Check tool allowlist + session state.',
    );
  }
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
