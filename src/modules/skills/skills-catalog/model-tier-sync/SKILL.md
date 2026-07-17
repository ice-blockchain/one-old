---
name: model-tier-sync
description: >
  Keep the Traffic One plan-aware model catalog current as providers launch new
  models. Updates each host's preferred-first model arrays, plan overrides, and
  catalog date in the plugin authoring repo so
  the performance system (highest/balanced/cheapest tiers → per-host model ids)
  stays current on every supported host. TRIGGER when the
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

Keeps the plugin's plan-aware model-tier config pointed at the newest available
models for each capability tier on every host. `HOST_MODELS` is the bundled
offline source of truth. The public `traffic-one-mcp.get_config` rows use
payload schema v2: one complete base `tiers` set plus optional complete
plan-specific sets under `plans`. The hook resolves the active plan and maps
remote `high`/`balanced`/`low` to the local
`highest`/`balanced`/`cheapest` runtime snapshot. Remote `auto` mirrors
`balanced`; it is validated and fingerprinted as catalog data but never drives
a subagent tier or the applied fingerprint.

```json
{
  "payloadSchemaVersion": 2,
  "tiers": {
    "high": ["..."],
    "balanced": ["..."],
    "low": ["..."],
    "auto": ["..."]
  },
  "plans": {
    "<canonical-plan-id>": {
      "high": ["..."],
      "balanced": ["..."],
      "low": ["..."],
      "auto": ["..."]
    }
  }
}
```

Every recognized plan override in the remote row is complete even though
`HOST_MODELS` stores sparse overrides: omitted local tiers are expanded from
the base and `auto` is generated as a mirror of the resolved `balanced` row.

## When to trigger

- "update the models", "sync model tiers", "use the latest models",
  "a new model launched", "are we on the newest models", `/model-tier-sync`.
- After a provider announces a new model generation (new Opus/Sonnet/Haiku, new
  GPT/Codex model, etc.).
- On a schedule — pair with the `schedule` skill (e.g. weekly) for true auto-update.

## Skip when

- You are inside a generated user project rather than the Traffic One plugin
  authoring repo, where the source config lives at `src/config/model-tiers.ts`.
  An installed plugin's `scripts/**` files are generated copies and will be
  overwritten by the next plugin update. If asked there, say so and point the
  user at the authoring repo.

## What the tiers mean (do not change this contract)

Three host-agnostic capability tiers, ordered most → least capable:

- `highest`  — the most capable model for hard reasoning / architecture.
- `balanced` — the strong mid-tier used for most implementation + review.
- `cheapest` — the fast, low-cost model used for QA and high-volume work.

Each performance level maps agents to tiers (see `src/shared/performance-config.ts`);
this skill only changes which concrete model each tier resolves to per host. Never
reorder or rename the tiers, and never change `src/shared/performance-config.ts`.

## Procedure

1. **Read the complete bundled catalog.** In `src/config/model-tiers.ts`, inspect
   every `HOST_MODELS` host entry: its `updatedAt`, base `tiers`, plan overrides,
   and `HOST_PLAN_IDS`. Each tier array is preferred-first; the first model is the
   default and the remaining models are accepted fallbacks.

2. **Research the current model lineup — official sources only.** Use WebSearch /
   WebFetch against the providers' own docs. Do NOT guess or use a model name you
   cannot confirm from an official page.
   - **Anthropic (claude row)**: confirm the family aliases `opus`, `sonnet`,
     `haiku` still exist. These aliases auto-resolve to the newest version of each
     family, so the claude row usually needs NO change. Only edit it if Anthropic
     renames a tier or introduces a new capability tier worth adopting.
   - **OpenAI / Codex (codex row)**: the milestone-1 catalog is intentionally
     fixed to `highest: ["gpt-5.6-sol"]`, `balanced: ["gpt-5.6-terra"]`, and
     `cheapest: ["gpt-5.6-terra"]`; generated `auto` mirrors `balanced`. Do not
     infer a mini/fast tier or replace these ids from general model-lineup
     research. Change this temporary rollout profile only after an explicit
     maintainer decision, then regenerate the operator manifest from
     `HOST_MODELS` so bundled and remote rows cannot diverge.
   - **Cursor (enforced — bare model FAMILIES, matched family-aware)**: the
     `cursor` row in `HOST_MODELS` holds bare model-family anchors, not full
     reasoning-variant slugs and not Anthropic aliases (Cursor rejects
     `opus`/`sonnet`). The spawn gate matches family-aware
     (`modelMatchesExpected`: `passed === family || passed.startsWith(family + '-')`), so ANY
     reasoning variant the user's plan/build offers satisfies the tier
     (`claude-fable-5-thinking-high` matches `claude-fable-5`). This is deliberate:
     the reasoning suffix is plan/build-SPECIFIC, so pinning one (e.g. `-thinking-high`) wrongly
     rejected a higher plan's `-thinking-max` variant of the SAME family. The
     preferred-first Cursor tier arrays hold the same-tier FALLBACK FAMILIES
     and must mirror the current Task-tool catalog; `composer-2.5` remains the
     universal floor. The CONCRETE
     build slug (with its suffix) is NOT hardcoded — it is captured into the
     user's local per-project/per-host preferences from the in-Cursor Task-tool
     list. So when SYNCING you only change a FAMILY here when a generation
     bumps (opus-4-8 → opus-5); you do NOT chase reasoning suffixes. Keep capability/cost order
     highest ≥ balanced ≥ cheapest; `composer-2.5` is Cursor's own cost-optimized model (always
     available, survives API-budget exhaustion).

3. **Map newest → tiers per host and plan**, preserving capability order
   (`highest` strictly ≥ `balanced` ≥ `cheapest` in capability). For hosts with
   model-pinned spawn tools, verify the tool accepts the identifier; otherwise
   verify the catalog identifier used by onboarding/session recommendations:
   - Claude Code Task/Agent `model` param accepts `opus` | `sonnet` | `haiku`.
   - Codex `spawn_agent` accepts an explicit `model`. Resolve the exact role
     model from the immutable run policy and pass it together with the canonical
     underscore-form `task_name` and `fork_turns: "none"`; live child hooks
     verify the observed model exactly.
   - Kilo CLI model ids include the provider prefix (for example
     `kilo/kilo-auto/frontier`); confirm them with `kilo models kilo --refresh`.
   - OpenCode Free and Go model ids must come from the corresponding official
     provider catalog. Keep a reachable Free fallback at the tail of every Go row.

4. **Edit the smallest relevant `HOST_MODELS` arrays.** Change the base tier or
   plan override that owns the verified behavior. An override replaces the full
   tier array; omitted tiers inherit the base. Keep `TIER_IDS`, `TIER_ALIASES`,
   and performance-to-tier policy unchanged unless explicitly requested.

5. **Bump every affected host date and regenerate its operator row.** Set
   `HOST_MODELS[host].updatedAt` to today's `YYYY-MM-DD` whenever any base or
   plan-specific model array changes. This is mandatory even if the preferred
   model stayed the same. Changing a resolved tier array without a date bump is
   an invalid snapshot contract. `npm run gen` emits the schema-v2 operator
   manifest at `operator/one-mcp-model-configs.json` and the reviewed CAS
   template at `operator/one-mcp-publish-cas.sql`; do not hand-author a second
   catalog. The generator expands sparse overrides into complete plan rows,
   sets `auto = balanced`, and requires the published row's integer `version`
   and `updated_at` to advance. The client fingerprint catches same-day
   semantic changes, but it cannot fetch them unless the row version advances.

6. **Run the repository verification chain** (from the authoring repo root):
   ```bash
   npm run typecheck
   npm test
   npm run gen
   ```
   Update model-tier expectations for every affected plan, verify snapshot
   validation and preferred-first fallback behavior, then run `npm run build`,
   `npm run golden:update`, `npm run plugin:check`, and `npm run smoke`.

7. **Report the publication prerequisite and a diff table.** Generation creates
   the operator manifest and CAS SQL but does not publish them. Before public
   sync is enabled, all seven `plugin_config` rows must match the generated
   `payloadSchemaVersion: 2` manifest exactly, with host-specific base tiers,
   complete recognized-plan overrides, a version bump, and fresh `updated_at`.
   For every changed host/plan/tier array, show `old → new`, the date bump,
   and the official source. If you could not confirm a newer model, leave it
   unchanged and say so explicitly.

## Guardrails

- Never invent or assume a model id. Unconfirmed → leave the cell unchanged and
  flag it as unverified in the report.
- Never downgrade a tier's capability or break the highest ≥ balanced ≥ cheapest
  ordering.
- Never change a preferred model, plan override, or fallback set/order without
  bumping that `HOST_MODELS` entry's `updatedAt`.
- Never hand-edit generated `dist/scripts/**`; edit source config/tests and
  regenerate.
- Never hand-maintain a second model catalog in the operator artefacts. Generate
  them from `HOST_MODELS`, then publish the reviewed rows independently.
