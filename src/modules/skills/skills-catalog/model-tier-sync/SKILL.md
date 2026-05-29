---
name: model-tier-sync
description: >
  Keep the Traffic One model-tier table current as providers launch new models.
  Updates the HOST_MODELS table in scripts/hook-runtime/model-tiers.cjs so the
  performance system (highest/balanced/cheapest tiers → per-host model ids) always
  points at the newest Claude, OpenAI/Codex, and Cursor models. TRIGGER when the
  user says "update the models", "sync model tiers", "refresh model list", "use the
  latest models", "a new model launched", "update model-tiers", "are we on the
  newest models", or runs /model-tier-sync. Plugin-maintenance skill: it edits the
  plugin source, not user-project files. Researches official provider docs before
  changing anything and never invents model names.
metadata:
  source: traffic-one
  adapted_for: traffic-one
---

# Model Tier Sync

Keeps `scripts/hook-runtime/model-tiers.cjs` → `HOST_MODELS` pointed at the newest
available model for each capability tier on each host. This is the single source
of truth the performance levels (Balanced / High) resolve against, so updating it
here updates every spawn across Claude Code, Codex, and Cursor.

## When to trigger

- "update the models", "sync model tiers", "use the latest models",
  "a new model launched", "are we on the newest models", `/model-tier-sync`.
- After a provider announces a new model generation (new Opus/Sonnet/Haiku, new
  GPT/Codex model, etc.).
- On a schedule — pair with the `schedule` skill (e.g. weekly) for true auto-update.

## Skip when

- You are inside a generated user project rather than the Traffic One plugin
  repo. `model-tiers.cjs` is plugin source; editing the cached copy in a user's
  plugin install would be overwritten on the next plugin update. If asked there,
  say so and point the user at the plugin repo.

## What the tiers mean (do not change this contract)

Three host-agnostic capability tiers, ordered most → least capable:

- `highest`  — the most capable model for hard reasoning / architecture.
- `balanced` — the strong mid-tier used for most implementation + review.
- `cheapest` — the fast, low-cost model used for QA and high-volume work.

Each performance level maps agents to tiers (see `performance-config.cjs`); this
skill only changes which concrete model each tier resolves to per host. Never
reorder or rename the tiers, and never change `performance-config.cjs`.

## Procedure

1. **Locate the file.** It lives at
   `${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime/model-tiers.cjs`.
   Read it and note the current `HOST_MODELS` table (claude / cursor / codex rows).

2. **Research the current model lineup — official sources only.** Use WebSearch /
   WebFetch against the providers' own docs. Do NOT guess or use a model name you
   cannot confirm from an official page.
   - **Anthropic (claude, cursor)**: confirm the family aliases `opus`, `sonnet`,
     `haiku` still exist. These aliases auto-resolve to the newest version of each
     family, so the claude/cursor rows usually need NO change. Only edit them if
     Anthropic renames a tier or introduces a new capability tier worth adopting.
   - **OpenAI / Codex (codex row)**: find the current top coding model, a strong
     general model, and a fast/mini model. These use concrete versioned ids
     (e.g. a `*-codex`, a flagship `gpt-*`, and a `*-mini`/`*-nano`) and DO drift,
     so this row is the one that most often needs updating.
   - **Cursor**: if Cursor exposes its own model identifiers distinct from the
     Anthropic aliases, map those; otherwise keep the Anthropic aliases.

3. **Map newest → tiers per host**, preserving capability order
   (`highest` strictly ≥ `balanced` ≥ `cheapest` in capability). Verify the
   spawn tool on each host accepts the identifier you choose:
   - Claude Code Task/Agent `model` param accepts `opus` | `sonnet` | `haiku`.
   - Codex `spawn_agent` `model` param accepts the provider's concrete ids.

4. **Edit ONLY the `HOST_MODELS` object.** Do not touch `TIER_IDS`,
   `TIER_ALIASES`, the resolver functions, or any other file. Keep the existing
   formatting and comments.

5. **Validate**:
   ```bash
   node -e "const m=require('./scripts/hook-runtime/model-tiers.cjs'); for (const t of m.TIER_IDS) for (const h of m.HOST_IDS) { const v=m.resolveModel(t,h); if(!v) throw new Error('missing '+t+'/'+h); console.log(t,h,v); }"
   node -e "require('./scripts/hook-runtime/agents-performance-prompt.cjs'); require('./scripts/hook-runtime/directives/directives.cjs'); require('./scripts/hook-runtime/handlers/handlers.cjs'); console.log('load OK')"
   ```

6. **Bump the plugin version** (patch) in all three manifests so a reload picks
   up the change: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
   `.cursor-plugin/plugin.json`.

7. **Report a diff table** — for every host/tier cell that changed, show
   `old → new` and cite the official source you confirmed it from. If you could
   not confirm a newer model for a cell, leave it unchanged and say so explicitly.

## Guardrails

- Never invent or assume a model id. Unconfirmed → leave the cell unchanged and
  flag it as unverified in the report.
- Never downgrade a tier's capability or break the highest ≥ balanced ≥ cheapest
  ordering.
- Only `model-tiers.cjs` (the `HOST_MODELS` table) and the three `plugin.json`
  version fields may change. Anything else is out of scope for this skill.
