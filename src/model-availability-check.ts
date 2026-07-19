/**
 * Model-availability check — daily poll of the configured LLM backend's
 * /v1/models endpoint to catch retirements before they cause a silent
 * outage across every agent group.
 *
 * On 2026-07-15 Ollama Pro retired `gemini-3-flash-preview:cloud` at
 * midnight PDT. Every agent group ran into `410 …retired` errors for
 * ~15 hours before anyone noticed. This check would have surfaced the
 * problem within a day and posted a warning to a visible channel.
 *
 * Design:
 *   - Once per 24h, throttled via lastRunMs
 *   - Fetches models from `${ANTHROPIC_BASE_URL || http://127.0.0.1:11435}/v1/models`
 *     (containers use host.docker.internal:11435 → same upstream)
 *   - If ANTHROPIC_MODEL isn't in the returned list, WARN log + post to
 *     #silverthorne with an ⚠️ prefix. Debounced so a multi-day outage
 *     doesn't spam the channel — post once every 24h until resolved.
 *   - Best-effort: any fetch/parse failure logs a debug and returns
 *     rather than crashing the sweep.
 */
import { log } from './log.js';
import { ANTHROPIC_MODEL } from './config.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const WARN_INTERVAL_MS = 24 * 60 * 60 * 1000; // don't re-post more than once per day
const DEFAULT_BASE_URL = 'http://127.0.0.1:11435';
// #silverthorne — Paden's most-active channel; alerts land where he'll see them.
const ALERT_GROUP_FOLDER = 'discord_silverthorne';
const ALERT_CHAT_JID = 'discord:1490895684789075968';

let lastRunMs = 0;
let inFlight = false;
let lastWarnMs = 0;

interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

/**
 * Non-throwing tick. Safe to call from host-sweep every minute; internal
 * throttle limits real work to once per 24h.
 */
export async function checkModelAvailabilityTick(): Promise<void> {
  const now = Date.now();
  if (now - lastRunMs < CHECK_INTERVAL_MS) return;
  if (inFlight) return;
  if (!ANTHROPIC_MODEL) return; // no configured model → nothing to check
  inFlight = true;
  lastRunMs = now;
  try {
    await checkNow();
  } catch (err) {
    log.debug('Model availability check failed', { err: (err as Error).message });
  } finally {
    inFlight = false;
  }
}

/** Force a check (for tests / one-off invocations). */
export async function checkNow(): Promise<{ ok: boolean; configured: string; found: string[] }> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL;
  const url = `${baseUrl.replace(/\/$/, '')}/v1/models`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) {
    log.warn('Model availability check: upstream returned non-OK', { url, status: resp.status });
    return { ok: false, configured: ANTHROPIC_MODEL, found: [] };
  }
  const json = (await resp.json()) as ModelsResponse;
  const found = (json.data || []).map((m) => String(m.id || '')).filter(Boolean);
  const present = found.includes(ANTHROPIC_MODEL);
  if (!present) {
    log.error('CONFIGURED MODEL NOT FOUND in upstream /v1/models', {
      configured: ANTHROPIC_MODEL,
      upstream: url,
      availableCount: found.length,
    });
    await maybePostAlert(found);
  } else {
    log.debug('Model availability check: OK', { configured: ANTHROPIC_MODEL, upstreamCount: found.length });
  }
  return { ok: present, configured: ANTHROPIC_MODEL, found };
}

async function maybePostAlert(availableModels: string[]): Promise<void> {
  const now = Date.now();
  if (now - lastWarnMs < WARN_INTERVAL_MS) return;
  lastWarnMs = now;
  try {
    // Lazy-import to avoid a module-load-time DB dependency in tests.
    const { writeIpcMessage } = await import('./ipc-writer.js');
    // Suggest closest alternatives — cloud-tier models with 'flash' or 'cloud' suffix.
    const suggestions = availableModels.filter((m) => /cloud/i.test(m) && !/^(glm|kimi)/i.test(m)).slice(0, 6);
    const text =
      `⚠️ **Admin alert — configured LLM model missing from upstream**\n` +
      `\`ANTHROPIC_MODEL=${ANTHROPIC_MODEL}\` is not in \`/v1/models\` response.\n` +
      `Likely retired or renamed. Agent groups will silently fail on the next turn.\n\n` +
      `**Available cloud models**: ${suggestions.join(', ') || '(none)'}\n\n` +
      `Fix: update \`.env\` \`ANTHROPIC_MODEL\` + \`COMPACT_MODEL\`, ` +
      `rewrite each \`data/v2-sessions/*/.claude-shared/settings.json\`, ` +
      `then \`docker kill\` all agent containers to respawn.`;
    await writeIpcMessage(ALERT_GROUP_FOLDER, {
      type: 'message',
      chatJid: ALERT_CHAT_JID,
      text,
    });
  } catch (err) {
    log.warn('Failed to post model-availability alert', { err: (err as Error).message });
  }
}
