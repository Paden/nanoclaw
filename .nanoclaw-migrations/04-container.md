# Container Agent-Runner Customizations

**⚠️ High risk.** Upstream v2 rewrote the container agent-runner from Node to Bun. Do NOT copy `container/agent-runner/src/index.ts` from the old tree — read the v2 version and re-apply each customization by intent.

**Files to copy wholesale (new, no upstream equivalent):**
```bash
cp "$OLD_TREE/container/agent-runner/src/system-prompt.ts" \
   "$WORKTREE/container/agent-runner/src/system-prompt.ts"
```

---

## 1. Custom slim system prompt

**Intent:** Replace the `claude_code` SDK preset (~4-8k tokens) with a ~500-700 token custom prompt focused on NanoClaw tool-use conventions. Reduces per-turn token overhead significantly.

**File:** `container/agent-runner/src/system-prompt.ts` (copy wholesale — new file)

**In `index.ts`:** Import and use instead of the `claude_code` system prompt:
```typescript
import { SYSTEM_PROMPT } from './system-prompt.js';
// Pass to SDK as system prompt instead of using systemPrompt: 'claude_code'
```

---

## 2. `sentViaIpc` flag with persona message fix

**Intent:** Suppresses the agent's final text result when it already posted content via `send_message` IPC mid-turn (avoids double-posting). Critical bug fix: persona messages (webhook chimes from Voss/Nyx/Zima/Emilio, which have `sender` field set) must NOT set this flag — otherwise the resolution post gets suppressed after a pet reacts.

**How to apply — in the tool-call streaming handler:**

```typescript
// When agent calls mcp__nanoclaw__send_message:
const input = b.input as {
  label?: string;
  pin?: boolean;
  upsert?: boolean;
  sender?: string;
} | undefined;
const isPinOrLabeled = !!(input?.label || input?.pin || input?.upsert);
// Persona messages (sender set = Voss/Nyx/Zima/Emilio) are supplementary
// flavor, not the agent's main reply. Don't suppress text output for them.
const isPersonaMessage = !!input?.sender;
if (!isPinOrLabeled && !isPersonaMessage) sentViaIpc = true;
```

---

## 3. Token usage tracking

**Intent:** Track per-turn token counts and costs. Accumulate `peakInputTokens` (single-call peak, not cumulative) for accurate compaction triggering. Report via `TokenUsage` interface.

**How to apply — add interface and accumulation in streaming callback:**

```typescript
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
}
// Track peakPerCallInputTokens — the highest input_tokens seen in a single
// streaming event (not summed across turns, which over-estimates).
let peakPerCallInputTokens = 0;
// On each streaming event with usage data, update peak and accumulate output/cache.
```

---

## 4. Enhanced globalClaudeMd loading

**Intent:** Auto-concatenate `sheets.md` and `date_time_convention.md` into the system prompt instead of letting agents Read them on every turn. Eliminates ~61× sheets.mjs reads and ~39× date_time_convention.md reads per session.

**How to apply — in the `load()` / system prompt construction section:**

```typescript
// After loading CLAUDE.md, also load these reference files with headers:
load('/workspace/group/sheets.md',
  '# Reference: Google Sheets (auto-loaded — do NOT Read this file)');
load('/workspace/global/date_time_convention.md',
  '# Reference: Date/Time Convention (auto-loaded)');
```

Note: `sheets.md` path should be group-specific (`/workspace/group/sheets.md`), not global.

---

## 5. Per-group MCP server pruning

**Intent:** Remove irrelevant MCP servers from agent context per group to reduce tool schema overhead.

**How to apply — add a `groupMcpConfig` map:**

```typescript
const groupMcpConfig: Record<string, {
  removeServers?: string[];
  disallowedTools?: string[];
}> = {
  // Chore/pet sheriff: Sheets + nanoclaw only, no ollama
  'discord_silverthorne': { removeServers: ['ollama'] },

  // Wordle/saga: no calendar needed
  'discord_family-fun': { removeServers: ['google-calendar'] },

  // Main/admin: no ollama, no airtable
  'discord_general': { removeServers: ['ollama', 'airtable'] },

  // Baby care: no calendar, no ollama; block direct sheet reads
  // (build_status_card.mjs already reads everything; row numbers are in AGENT REF)
  'discord_emilio-care': {
    removeServers: ['google-calendar', 'ollama'],
    disallowedTools: ['mcp__google-sheets__read_range'],
  },
};
```

---

## 6. Network env passthrough to MCP processes

**Intent:** Ensures proxy and CA certificate env vars pass through to MCP child processes, preventing OAuth call hangs on first MCP init in restricted network environments.

**How to apply — when spawning MCP server processes, forward:**

```typescript
const networkEnvVars = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'];
// Merge these from process.env into the MCP spawn env
```
