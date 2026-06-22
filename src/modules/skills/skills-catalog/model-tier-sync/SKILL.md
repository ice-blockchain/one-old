---
name: model-tier-sync
description: >
  Keep the Traffic One model-tier table current as providers launch new models.
  Updates the plugin's HOST_MODELS model-tier table (scripts/config/model-tiers.js in an installed plugin; src/config/model-tiers.ts in the plugin authoring repo) so the
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

Keeps the plugin's model-tier table (`HOST_MODELS`) pointed at the newest
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
  repo, where the table lives at `src/config/model-tiers.ts` (run `npm run plugin:build` after edits). In an installed plugin the compiled copy at `scripts/config/model-tiers.js` is refreshed by plugin updates; editing the cached copy in a user's
  plugin install would be overwritten on the next plugin update. If asked there,
  say so and point the user at the plugin repo.

## What the tiers mean (do not change this contract)

Three host-agnostic capability tiers, ordered most → least capable:

- `highest`  — the most capable model for hard reasoning / architecture.
- `balanced` — the strong mid-tier used for most implementation + review.
- `cheapest` — the fast, low-cost model used for QA and high-volume work.

Each performance level maps agents to tiers (see `src/shared/performance-config.ts`);
this skill only changes which concrete model each tier resolves to per host. Never
reorder or rename the tiers, and never change `src/shared/performance-config.ts`.

## Procedure

1. **Locate the file.** In the plugin authoring repo it is `src/config/model-tiers.ts` —
   read it and note the current `HOST_MODELS` table (claude / cursor / codex rows).
   (In an installed plugin the compiled copy is `scripts/config/model-tiers.js`, but
   that is overwritten on every plugin update — edit the source, see *Skip when*.)

2. **Research the current model lineup — official sources only.** Use WebSearch /
   WebFetch against the providers' own docs. Do NOT guess or use a model name you
   cannot confirm from an official page.
   - **Anthropic (claude row)**: confirm the family aliases `opus`, `sonnet`,
     `haiku` still exist. These aliases auto-resolve to the newest version of each
     family, so the claude row usually needs NO change. Only edit it if Anthropic
     renames a tier or introduces a new capability tier worth adopting.
   - **OpenAI / Codex (codex row)**: find the current top coding model, a strong
     general model, and a fast/mini model. These use concrete versioned ids
     (e.g. a `*-codex`, a flagship `gpt-*`, and a `*-mini`/`*-nano`) and DO drift,
     so this row is the one that most often needs updating.
   - **Cursor (enforced — bare model FAMILIES, matched family-aware)**: the `cursor` row in
     HOST_MODELS holds bare model-FAMILY anchors (currently highest `claude-opus-4-8` / balanced
     `claude-4.6-sonnet` / cheapest `composer-2.5`) — NOT full reasoning-variant slugs and NOT the
     Anthropic aliases (Cursor rejects `opus`/`sonnet`). The spawn gate matches FAMILY-aware
     (`modelMatchesExpected`: `passed === family || passed.startsWith(family + '-')`), so ANY
     reasoning variant the user's plan/build offers satisfies the tier (`claude-opus-4-8-thinking-max`,
     `…-thinking-high`, `…-thinking-max-fast` all match `claude-opus-4-8`). This is deliberate:
     the reasoning suffix is plan/build-SPECIFIC, so pinning one (e.g. `-thinking-high`) wrongly
     rejected a higher plan's `-thinking-max` variant of the SAME family. `CURSOR_MODEL_ALTERNATES`
     holds same-tier FALLBACK FAMILIES (highest→`claude-opus-4-7`,`claude-fable-5`,`composer-2.5`;
     balanced→`gpt-5.5`,`composer-2.5`) with `composer-2.5` as the universal floor. The CONCRETE
     build slug (with its suffix) is NOT hardcoded — it is discovered at build time from
     `.traffic-one/cursor-models.json` (the in-Cursor orchestrator enumerates its Task-tool list;
     see `shared/materialize/cursor-models.ts`/`pickCursorSlug`) and written into
     `.cursor/agents/<role>.md`. So when SYNCING you only change a FAMILY here when a generation
     bumps (opus-4-8 → opus-5); you do NOT chase reasoning suffixes. Keep capability/cost order
     highest ≥ balanced ≥ cheapest; `composer-2.5` is Cursor's own cost-optimized model (always
     available, survives API-budget exhaustion).

3. **Map newest → tiers per host**, preserving capability order
   (`highest` strictly ≥ `balanced` ≥ `cheapest` in capability). Verify the
   spawn tool on each host accepts the identifier you choose:
   - Claude Code Task/Agent `model` param accepts `opus` | `sonnet` | `haiku`.
   - Codex `spawn_agent` `model` param accepts the provider's concrete ids.

4. **Edit ONLY the `HOST_MODELS` object** in `src/config/model-tiers.ts`. Do not
   touch `TIER_IDS`, `TIER_ALIASES`, the resolver functions, or any other file.
   Keep the existing formatting and comments.

5. **Validate** (from the authoring repo root):
   ```bash
   npm run typecheck && npm test
   ```
   `src/shared/__tests__/model-tiers.test.ts` exercises `resolveModel(tier, host)`
   for every tier × host and asserts the expected ids — update its expected values
   to match any cell you changed, or the test will fail. Then run `npm run plugin:build`
   to refresh the compiled `scripts/config/model-tiers.js`.

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
