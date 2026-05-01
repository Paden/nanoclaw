# NanoClaw Migration Guide

Generated: 2026-05-01
Base: a81e1651b5e48c9194162ffa2c50a22283d5ecd3
HEAD at generation: e2248373e86bca2f1e730e4d4d4ca375bcefe69b
Upstream target: 8c962d3f73edcb627c3043b5fe7595d7d8755422 (v2.0.23)

## Migration Plan

This fork is a fully customized family assistant ("Claudio Portillo") built on NanoClaw. The
customizations are substantial and span every layer: identity, groups, host scripts, src/, and
the container agent-runner.

**v2 Breaking Changes That Affect This Fork:**

1. **Discord is now in the `channels` branch** — use `/add-discord` skill instead of `git merge upstream/skill/discord`
2. **Container runtime moved from Node to Bun** — `container/agent-runner/src/index.ts` will be heavily rewritten upstream; our customizations must be re-applied by diff, not file copy
3. **Two-DB session split** — `store/messages.db` schema changes; apply our `db.ts` additions carefully to the new structure
4. **Per-group agent-runner overlays removed** — v2 uses a single shared agent-runner; our per-group MCP pruning stays in `container/agent-runner/src/index.ts`
5. **New entity model** — registered groups structure may differ; validate channel registration after swap

**Order of operations:**

1. Start clean worktree from `upstream/main` (v2.0.23)
2. Run `/add-discord` skill to install Discord channel (replaces `skill/discord` merge)
3. Apply src/ new files (copy wholesale — they have no upstream equivalent)
4. Apply src/ modifications (config.ts, db.ts, container-runner.ts, index.ts, types.ts) — diff-based, v2 will have changed these files
5. Apply container/agent-runner changes (system prompt, sentViaIpc fix, MCP pruning, token tracking)
6. Copy scripts/ new files wholesale
7. Copy groups/ wholesale (entirely user content)
8. Apply package.json additions
9. Build + test
10. Live test before swap

**Risk areas:**
- `src/container-runner.ts` — heavily changed in v2 (new entity model, Bun runtime refs); our additions (Ollama routing, Google Calendar mount, pet isolation) must be surgically re-applied
- `src/db.ts` — two-DB split means schema is restructured; add our tables/functions to the new structure
- `container/agent-runner/src/index.ts` — Node→Bun rewrite upstream; re-apply our changes by intent, not file copy

---

## Applied Skills

| Skill | Branch | Action in v2 |
|-------|--------|--------------|
| Discord channel | `skill/discord` | Run `/add-discord` skill (channel now in `channels` branch) |

No other upstream skill branches were merged. All other installed skills in `.claude/skills/` are operational/instruction-only and require no code merge.

---

## Skill Interactions

None — only one code skill (Discord) was applied.

---

## Sections

- [01-groups.md](01-groups.md) — Copy entire `groups/` tree
- [02-src-new-files.md](02-src-new-files.md) — New `src/` files (copy wholesale)
- [03-src-modified.md](03-src-modified.md) — Modified src/ files (config, db, container-runner, index, types)
- [04-container.md](04-container.md) — Container agent-runner customizations
- [05-scripts.md](05-scripts.md) — Host scripts (copy wholesale)
- [06-discord-slash.md](06-discord-slash.md) — Discord slash commands added post-skill
- [07-package.md](07-package.md) — package.json additions
