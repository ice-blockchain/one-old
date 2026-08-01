# Synthetic-prompt templates for senior-eng-orchestrator

> **Marker contract:** every spawn/continuation prompt built from these
> templates MUST include `[t1-role: senior-<role>]`. These templates put it on
> the first line for consistency, but role parsing accepts it anywhere in a
> recognized user/task record because shipped continuation and retry prompts do
> not all place it first. Substitute the actual role before calling the host
> tool; never copy the `<role>` placeholder literally.


These are the canonical templates the orchestrator uses when spawning each
subagent via `Task`. Substituting placeholders (`<user-request>`, `<run-id>`,
etc.) is the orchestrator's job; the templates stay lean so the
subagent's context stays clean. The `<run-id>` substitution rules are below.

On Codex, structured task identity is mandatory. Use the exact underscore-form
task name (`senior_architect`, `senior_frontend`, `senior_backend`,
`senior_reviewer`, `senior_tester`, or `senior_shipper`), pass the role's exact
runtime-resolved `model` AND its `reasoning_effort` from the run policy, and set
`fork_turns: "none"` on every fresh spawn. For example:

```json
{
  "task_name": "senior_architect",
  "message": "[t1-role: senior-<role>]\n...",
  "fork_turns": "none",
  "model": "<runtime-model>",
  "reasoning_effort": "<runtime-effort>"
}
```

If the spawn tool this Codex session exposes has NO `task_name` field (schemas
vary across builds — some expose only `model` and `message` with no
task-identity or fork field), do NOT improvise pseudo-metadata: the
`[t1-role: senior-<role>]` marker on the FIRST line of the message is the
identity channel — current child rollouts record the spawn prompt readably and
the gates recover the role from it (the bind may complete on the child's first
tool call). Everything else (exact model, effort, run-id) stays mandatory.

Line-zero `session_meta` (from `task_name`) is the strongest child-side
identity; the marker is the fallback. The live hooks provide the actual model
evidence checked against the immutable run policy. Senior-role spawns and
replacements are issued by the ROOT orchestrator only — never nested from
another senior child (the host attributes a nested child's edits to the
spawning child, so its writes to the replaced role's files are denied).

## Per-role model / profile mapping

Each role runs at a specific model tier (it can be overridden per role in the wizard, e.g.
frontend → balanced).

On Cursor, model-gate prints the exact role→model spawn map from the active local host snapshot
and the user's locally captured available model ids. **Pass that value in the `Task` `model`
parameter for every spawn.** Project `.cursor/agents/<role>.md` files are model-agnostic role
contracts and are not a model source. If you omit `model`, the subagent inherits the orchestrator
model. The spawn gate denies a missing/wrong value and names the exact runtime value to pass.

On Windsurf / Devin Local, Traffic One materializes role contracts at
`.devin/agents/<role>/AGENT.md`, but profiles created during onboarding are not registered
until a new Devin session. **Spawn every role with `run_subagent` profile
`subagent_general`**, put `[t1-role: senior-<role>]` on the FIRST task line, and immediately
tell the child to read its matching `.devin/agents/<role>/AGENT.md` contract. Pass NO
`model` argument. Read a background subagent's result with `read_subagent`. Do NOT
use `opencode_delegate` to spawn a role — on Windsurf that MCP tool is only the optional
free accelerator for bounded units (and requires `openCode.enabled`); `run_subagent` is the
role-spawn path and does not depend on OpenCode.

On OpenCode, Traffic One materializes project-scoped global markdown agents under
`~/.config/opencode/agents/`, named `traffic-one-<projectHash12>-<role>`, with the local role
model pinned in frontmatter. Spawn the exact generated name shown by SessionStart/the gate and
pass no `model` argument unless this OpenCode build documents the field. Built-in `general`
inherits the parent model and is not a safe fallback. If the generated agent is not listed,
ensure materialization exists and restart OpenCode so its global agent registry reloads.

On Kilo, Traffic One materializes project-local role contracts at
`.kilo/agents/<role>.md`. Spawn the built-in writable `general` Task subagent,
omit `model` so Kilo preserves the active session/per-agent model, and put
`[t1-role: senior-<role>]` on the first line. Immediately tell the child to
read `.kilo/agents/<role>.md` before acting. Do not use `explore` or switch to
main-agent simulation: `general` plus the marker-and-contract protocol is the
supported Kilo subagent path.

## Run-id format

The run-id is `currentRunId`: a plain epoch-**millisecond digit string** (e.g. `"1715091785000"`),
**pre-minted by Traffic One into `.traffic-one/.one.json` before Phase 0** (the onboarding
gate announces it the moment the build starts). Do NOT generate it — and NEVER use
`date`/ISO/UTC (e.g. `2026-06-17T10-08-00Z`). A self-generated id splits run state into a
second `runs/<id>/` tree, so the run-team gate finds no `assignments.json` under
`currentRunId` and blocks every implementer write ("New subagent — Couldn't start"). This is
now **doubly enforced**: the SPAWN gate DENIES a subagent spawn whose prompt references any
run-id other than `currentRunId` (so you cannot even hand a worker a wrong id), and the plan
gate DENIES any write to `.traffic-one/runs/<id>/…` or `digests/<id>/…` whose `<id>` is not
`currentRunId` — both naming the correct value. Wherever a template shows `<run-id>`,
**substitute `currentRunId` (read from `.traffic-one/.one.json`) into every occurrence
BEFORE spawning** — like every other placeholder, so each subagent receives fully concrete
paths. The literal `<run-id>` placeholder itself never trips the spawn gate (the gate reads
it as `currentRunId`, and hosts that support hook input rewrite correct the child's prompt
in-flight), so a missed substitution cannot block a spawn — but then the child must resolve
the placeholder itself from its `Run ID:` line / `.one.json`, and the plan gate still
rejects any WRITE to a literal `runs/<run-id>/…` path. Substituting up front is the
reliable path. The
claim files, `opencode-attempts`/`opencode-gate-denies` markers, `assignments.json`, and the
digest folder all key off this one value.

Use project-relative `.traffic-one/...` paths in all role prompts. Do not paste
absolute `.traffic-one/runs`, `.traffic-one/digests`, or `.traffic-one/fix-cycles`
paths; a copied or corrupted absolute root (for example an extra path segment)
will make OpenCode ask for external-directory permission or read the wrong
project. For scratch build logs, print to stdout or write under
`.traffic-one/tmp/<run-id>/`; never write model-command logs under `/tmp`,
`/private/tmp`, or `/var/tmp`.

## Phase 1 — Architect

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and verify every run-id in the paths below equals it. If a path still shows the literal `<run-id>`, substitute that exact value. The user's request is:

> <user-request quoted verbatim>

Read .traffic-one/.one.json,
.traffic-one/runs/<run-id>/capability-v1.json, and
.traffic-one/runs/<run-id>/baseline-v1.json plus existing project memory:
.traffic-one/product.md, .traffic-one/stack.md, .traffic-one/rules/*.md,
.traffic-one/known-issues.md, and .traffic-one/agent-log.md when present.
Also read the codebase-graph artefact at the active provider's location (per
rules/common/codebase-graph.md): `.traffic-one/.gitnexus/` when codeGraphProvider is
"gitnexus", `.traffic-one/graphify-out/GRAPH_REPORT.md` when "graphify". Skip silently if
missing.

Produce .traffic-one/plan.md (≤250 lines, sections: Goal, Stack & rationale,
Module map, Routes, Public contracts, Risks, Cut-list, plus OpenCode delegation queue only
when delegation is active on a non-OpenCode/Kilo host). Cite skills by name; do not
inline their content.

When the current host is OpenCode or Kilo, do not include an "OpenCode delegation queue"
section and do not write `<!-- opencode-delegate:start -->` markers; OpenCode/Kilo
cannot delegate to OpenCode from inside a peer self host, so implementer work runs directly on the current host.
When `openCode.enabled` is active on a non-OpenCode/Kilo host, the "OpenCode
delegation queue" section is REQUIRED: list every bounded, low-risk unit
(boilerplate/CRUD scaffolding, dummy/seed/fixture data, simple test scaffolding,
mechanical refactors/renames, formatting/codemods) in the machine-readable
`<!-- opencode-delegate:start -->`…`<!-- opencode-delegate:end -->` block (one
self-contained `- id: … | role: … | kind: … | files: … | task: …` line each;
add `depends: <earlier-id>` when a later unit overlaps an earlier files/area).
The `files:` value is an enforced allowlist: list every legitimate source
path/area the unit may touch, or the runner rejects the diff before apply.
Derive paths from the modules you declared — runtime compiles per-role
ownership from them AFTER your `PLAN_READY`, and a unit whose files fall
outside its role's compiled assignment is rejected at Step-0 delegation
(pre-model, paid fallback). Scope mismatches never block `PLAN_READY`, so do
not try to guess the compiled allowlist — declare the owning module instead.
The compiled path per module is DETERMINISTIC (closed kind list: app-shell,
page, component, feature, service, store, edge-function, test): `feature` → `<features-root>/
<kebab(name)>/index<profile-native-extension>` (`.tsx` for React/React Native);
`page` → `<pages-root>/<Pascal(name)>.tsx`;
`component` → `<components-root>/<Pascal(name)>.tsx`; `app-shell` → the app
shell entry (router/shell only); `test` → `tests/<kebab(name)>.test.ts`;
`service`/`store` compile into backend-owned api-client files whenever a
backend role exists; `edge-function` (Supabase-family backends only) →
`supabase/functions/<kebab(name)>/index.ts`, backend-owned and Deno, so it
stays outside the app's tsconfig/lint surface and gets no compiled unit test.
Standing scaffold files are also unit-safe when the
role owns them: `README.md`, the source i18n catalog, backend seed/migrations.
There is NO compiled helpers/util file for the frontend when a backend role
exists — never queue invented paths (`src/lib/format.ts`, `features/<x>/
demo-content.ts`): the rejected unit's files are unwritable for the
implementers too, so fold helper/demo content into the owning feature entry or
a declared component instead. If
the task mentions tests, testability, Vitest, Playwright, specs, or config/deps,
the allowlist must include the exact test/spec/config/package files it may
touch; otherwise remove that acceptance and leave verification/config work to
the paid implementer/reviewer. NEVER queue
architecture/contracts/security/data-model/migrations/cross-file-invariant work.
The orchestrator delegates these to OpenCode before the implementers, so a
thorough queue is what actually saves the user's tokens. See the
senior-architect role instructions for the exact format.

For `mode: new-project`, run `project-memory` and
`auto-documentation-generator` after the plan even when the user did not ask for
memory/docs. Only when the runtime capability profile contains `web-ui`, invoke
`seo` for generated websites/public web routes and include the route metadata
contract. Include the profile-selected i18n contract and the Supabase/env setup
CTA contract (`https://traffic.io/` plus href regression) only when those exact
surfaces exist. Create/update only the `.traffic-one/` memory baseline. For
`mode: existing-codebase` or `existing-with-supabase`, run them before normal feature work,
and apply SEO/i18n reconciliation only when the runtime profile contains the
matching web UI/catalog surface. Create missing memory/docs and update existing
files in place without inventing web metadata or translation systems for API,
CLI, worker, data-only, or native-only profiles.

Write semantic ArchitectureInputV1 to
.traffic-one/runs/<run-id>/architecture-input-v1.json: route ids/paths and
module ids, semantic modules (`app-shell`, `page`, `component`, `feature`,
`service`, `store`, `edge-function`, or `test`), exact demand-driven `uiPrimitives` identifiers
from the active adapter's official catalog, optional `placement: "shared-ui"`
only for reusable domain-agnostic component modules, optional semantic `i18n` intent
(`sourceLocale`, supported `locales`, exact `literalBrands`), and only narrowly
justified exception requests. New UI projects default to `en` only when the
brief is silent.
Do not include profile ids, roots, entrypoints, output paths, owner roles,
assignments, scanner limits, baseline data, QA impact, or hashes.

If the request is a redesign, an important visual change, has material
performance risk, or specifies Lighthouse thresholds, add exactly one strict
block to `.traffic-one/plan.md`:
<!-- traffic-one-verification:start -->
{"schemaVersion":1,"redesign":true,"performanceRisk":true,"explicitLighthouse":{"performanceMin":95}}
<!-- traffic-one-verification:end -->
Keep only applicable fields. Exact user thresholds belong in
`explicitLighthouse`; optional non-exact targets belong in
`advisoryLighthouse`. Include `seoMin` only when explicitly required. Omit the
block when none applies. `agentRaisedImpact` may request `behavioral`/`visual`
for web or `native-ui` for native, but runtime accepts it only when stricter
than the mechanically derived result. Never put paths, baseline, scan controls,
screenshots, or browser requirements in this block; runtime derives them and
the plan can only raise verification.

Do not create package/workspace/config/source/test files, Tailwind assets,
barrels, or assignments. Do not create or edit architecture-v1.json,
verification-v2.json, assignments.json, model policy, or bootstrap envelopes.
When the architect digest writes PLAN_READY, runtime compiles and hashes those
contracts, generates disjoint assignments, and atomically publishes each
eligible WorkUnitContractV1/bootstrap. If compilation denies, change only the
semantic plan/input and retry.

On finish, write your handoff digest to:
  .traffic-one/digests/<run-id>/architect.md
Format and read protocol: rules/common/agent-handoff-digests.md.

Do not write `materializedStack`, `materializedAt`, or
`materializedVersion` by hand. Those fields are output from the materializer
only.

Before emitting PLAN_READY, verify project-local context is materialized. If
`.traffic-one/manifest.json`, `.traffic-one/rules`, `.traffic-one/skills`,
root `AGENTS.md`, or root `CLAUDE.md` is missing, report the runtime
materialization blocker instead of creating or repairing runtime-owned files.

End your reply with the literal token PLAN_READY on its own line.
```

## Phase 2 — Frontend/UI implementer (when eligible)

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and verify every run-id in the paths below equals it. If a path still shows the literal `<run-id>`, substitute that exact value. The architect digest is at:
  .traffic-one/digests/<run-id>/architect.md

Read in priority order:
  1. .traffic-one/runs/<run-id>/bootstrap/senior-frontend/active.json. Verify
     its envelope/work-unit/architecture/verification hashes and obey its
     outputs, allowlist, and excluded paths. Its rules/skills are hash
     references; the bodies are already materialized under .traffic-one/rules/
     and .traffic-one/skills/ (indexed in AGENTS.md) — do not read the envelope
     expecting bodies.
  1b. Your role-scoped rule and skill bodies are already materialized in this
     project: `.traffic-one/rules/**` and `.traffic-one/skills/<name>/SKILL.md`
     (your SessionStart header carries the role-scoped index plus your
     integration requirements). Read the specific files your work needs, ONE
     file per Read/shell command, in separate turns — NEVER concatenate
     several into one command (`for f in …; do cat …`, multi-file `sed`,
     `Promise.all`) and NEVER lower `max_output_tokens`: host exec output is
     truncated middle-out (~10K tokens on Codex) and the middle files vanish
     silently (measured 8co: 7 of 25 files survived one batched read).
  2. .traffic-one/digests/<run-id>/architect.md
  3. .traffic-one/product.md, .traffic-one/stack.md, .traffic-one/coding.md,
     .traffic-one/known-issues.md if present
  4. .traffic-one/plan.md § Routes + § Public contracts + § Module map (only your work unit)
  5. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.traffic-one/.gitnexus/` for gitnexus,
     `.traffic-one/graphify-out/GRAPH_REPORT.md` for graphify. Scope it to the
     compiled allowlist.
  6. Specific source files only when 1–5 don't answer the question.

Create any scaffold/package/config/barrel outputs assigned to this work unit,
then implement its modules. Write ONLY inside the work unit's outputs and
allowlist. If a required output is missing, stop and surface a replan request in
your digest; never edit assignments or widen the bootstrap.

Implement only the frontend/native-UI layer assigned by the work unit. If the
assignments manifest also contains an independent `senior-backend` work unit,
that sibling may run in parallel; assume only its compiled public contract.
When no backend work unit exists, do not wait for or refer to one. Surface
contract gaps in your digest's "Open questions / blockers" section.

Only when the work unit contains public web routes, apply `rules/common/seo.md`
before finishing: route-aware metadata, JSON-LD, robots/sitemap,
favicon/PWA/OG assets, site-url env docs, private/admin noindex, and metadata
regression coverage for every created or changed public route.

Apply `rules/frontend/component-system.md` to every web UI work unit. Inventory
all controls and reachable UI states, reuse `@app/ui`, and search the active
adapter's official catalog by name, behavior, and synonyms before creating a
component. Add compiled `uiPrimitives` through the adapter CLI into
`packages/ui` and export them through its package API. A custom base component
requires recorded evidence that the official catalog has no equivalent.

Apply `rules/frontend/i18n.md` whenever the work unit includes web or native UI.
New UI projects wire the compiled profile-native baseline; existing localized
projects extend their selected provider/catalog. Every static React child uses
`<Trans>` with literal `ns`, literal `i18nKey`, and fallback; `t()` is only for
string-valued props, metadata, validation, and imperative APIs. Update every
declared locale. Native UI follows its platform localization contract.

Only for a Supabase-backed web/Ionic work unit with a changed missing-env surface, apply
`rules/frontend/react/supabase-client.md` before finishing. Create or repair the
shared EnvBanner/SupabaseConfigAlert/ConfigurePromptCard setup CTA so every
website-facing missing-config link points to `https://traffic.io/`, and add or
update a regression test for that exact `href`.

Missing Supabase/env config is not a license to ship sparse UI: create typed,
product-specific demo/seed fixture data inside your owned frontend scope and
render the actual workflow in demo/degraded mode until live data is configured.
Do not invent a backend contract beyond the plan; make fixtures conform to the
planned public contract and surface any contract gaps in your digest.

Do not add `@ts-nocheck`, `@ts-ignore`, or the selected stack's equivalent broad
type/static-analysis suppression. Convert repository/API results into explicit
domain types where the language supports them. A successful live response must
drive every affected rendered surface; fixtures are permitted only for absent
configuration, empty results, or handled errors.

On finish, write your digest to:
  .traffic-one/digests/<run-id>/frontend.md
Format: rules/common/agent-handoff-digests.md. Digest verdict line:
`IMPLEMENTED` (or `BLOCKED <one-line reason>`) — never PLAN_READY, APPROVED,
CHANGES_REQUESTED, or TESTS_GREEN; those tokens belong to other roles.

Don't read more than ~3 files outside the scope above unless the
digest/plan/graph all came up empty for the question.

End your reply with a one-line status of what you produced and what's
pending.
```

## Phase 2 — Backend implementer (when eligible)

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and verify every run-id in the paths below equals it. If a path still shows the literal `<run-id>`, substitute that exact value. The architect digest is at:
  .traffic-one/digests/<run-id>/architect.md

Read in priority order:
  1. .traffic-one/runs/<run-id>/bootstrap/senior-backend/active.json. Verify
     its envelope/work-unit/architecture/verification hashes and obey its
     outputs, allowlist, and excluded paths. Its rules/skills are hash
     references; the bodies are already materialized under .traffic-one/rules/
     and .traffic-one/skills/ (indexed in AGENTS.md) — do not read the envelope
     expecting bodies.
  1b. Your role-scoped rule and skill bodies are already materialized in this
     project: `.traffic-one/rules/**` and `.traffic-one/skills/<name>/SKILL.md`
     (your SessionStart header carries the role-scoped index plus your
     integration requirements). Read the specific files your work needs, ONE
     file per Read/shell command, in separate turns — NEVER concatenate
     several into one command (`for f in …; do cat …`, multi-file `sed`,
     `Promise.all`) and NEVER lower `max_output_tokens`: host exec output is
     truncated middle-out (~10K tokens on Codex) and the middle files vanish
     silently (measured 8co: 7 of 25 files survived one batched read).
  2. .traffic-one/digests/<run-id>/architect.md
  3. .traffic-one/product.md, .traffic-one/stack.md, .traffic-one/security.md,
     .traffic-one/schema.sql, .traffic-one/known-issues.md if present
  4. .traffic-one/plan.md § Routes + § Public contracts
  5. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.traffic-one/.gitnexus/` for gitnexus,
     `.traffic-one/graphify-out/GRAPH_REPORT.md` for graphify. Scope it to the
     compiled allowlist.
  6. Specific source / migration files only when 1–5 don't answer the question.

Create any scaffold/package/config outputs assigned to this work unit, then
implement its modules. Write ONLY inside the work unit's outputs and allowlist.
If a required output is missing, stop and surface a replan request in your
digest; never edit assignments or widen the bootstrap.

Implement only the backend layer of the plan. If the assignments manifest also
contains an independent `senior-frontend` work unit, that sibling may run in
parallel; assume only its compiled public contract. When no frontend work unit
exists, do not wait for or refer to one. If you change a public contract, write
the new signature in your digest's "Public contracts (delta only)" section.
After migrations, refresh .traffic-one/schema.sql and note the schema refresh in
your backend digest.

On finish, write your digest to:
  .traffic-one/digests/<run-id>/backend.md
Format: rules/common/agent-handoff-digests.md. Digest verdict line:
`IMPLEMENTED` (or `BLOCKED <one-line reason>`) — never PLAN_READY, APPROVED,
CHANGES_REQUESTED, or TESTS_GREEN; those tokens belong to other roles.

Don't read more than ~3 files outside the scope above unless the
digest/plan/graph all came up empty for the question.

End your reply with a one-line status of what you produced.
```

## Phase 3 — Reviewer (parallel with Tester)

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and verify every run-id in the paths below equals it. If a path still shows the literal `<run-id>`, substitute that exact value. The capability-eligible implementer digests for this run are:
  <IMPLEMENTER_DIGEST_PATHS>

Read in priority order:
  1. Every implementer digest listed above. The orchestrator derives this list
     from immutable work units/assignments; do not require a missing
     frontend/backend sibling that was not eligible.
  2. .traffic-one/coding.md, .traffic-one/security.md,
     .traffic-one/known-issues.md, and .traffic-one/.agentignore if present.
  3. `git diff --name-only HEAD`, then `git diff HEAD <file>` ONLY for files
     listed in the digests' "Touched" or "Next-phase reading hints" sections.
  4. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.traffic-one/.gitnexus/` or
     `.traffic-one/graphify-out/GRAPH_REPORT.md`. Use it to find neighbors of changed
     nodes.
  5. Full file Reads only when a violation requires it.

Verdict format: end with one of
  APPROVED — <one line on why this passes>.
  CHANGES_REQUESTED — <one line summary>.
    1. <file:line> — <issue> — <suggested fix>.
    2. …

If the user asked "safe to ship", production readiness, launch score, or release
approval, also run the `verification-loop` Production-Readiness Score and include
the score, hard blockers, and 12-factor / AWS Well-Architected / OWASP mapping.

For generated websites or changed public web routes, request changes if the SEO
baseline from `rules/common/seo.md` is missing or only partial for any created
or changed public route. Request changes if changed UI ignores an existing i18n
module, ships hardcoded user-facing strings, omits catalog entries, or uses
`t()` as rendered React child instead of `<Trans>` with fallback. Request changes if any touched
missing-config setup CTA lacks `href="https://traffic.io/"`.
Request changes when the UI-needs inventory is incomplete, a component already
exists in `@app/ui` or the active official shadcn catalog but was hand-rolled,
an adapter primitive bypasses its CLI/package export, a second UI system was
introduced, or a custom base component has no recorded negative lookup and
composition justification.

Write your digest to:
  .traffic-one/digests/<run-id>/reviewer.md

Don't full-scroll files; read targeted line ranges.
```

## Phase 3 — Tester (parallel with Reviewer)

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and verify every run-id in the paths below equals it. If a path still shows the literal `<run-id>`, substitute that exact value. The capability-eligible implementer digests for this run are:
  <IMPLEMENTER_DIGEST_PATHS>

Read in priority order:
  1. Every implementer digest listed above. The orchestrator derives this list
     from immutable work units/assignments; do not require a missing
     frontend/backend sibling that was not eligible.
  2. .traffic-one/product.md, .traffic-one/known-issues.md, and
     .traffic-one/schema.sql if present.
  3. .traffic-one/plan.md § Public contracts.
  4. `git diff --name-only HEAD` + existing test files adjacent to the touched code.
  5. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.traffic-one/.gitnexus/` or
     `.traffic-one/graphify-out/GRAPH_REPORT.md`. Use it to find related modules and call
     sites that should be covered.

Add or update tests for the changed surface. Run them. Verdict format:
  TESTS_GREEN — <count> tests passed; coverage <%> on changed files.
  TESTS_FAILING — <count> failing.
    1. <test name> — <file:line> — <error excerpt>.
    2. …

Read `.traffic-one/runs/<run-id>/verification-v2.json` before testing.
`TESTS_GREEN` is legal only when the mechanical tests pass and the canonical
`.traffic-one/reports/qa/<run-id>/report-v2.json` is a fresh, parser-valid
`QaReportV2` (`schemaVersion: 2`) with the exact run, contract, and source
hashes. Screenshots alone, arbitrary JSON, and Lighthouse reports are not
functional QA evidence.

Follow `uiImpact` without inventing a frontend/backend exemption:
- `none`: relevant stack build/test/lint only; no browser or screenshots.
- `nonvisual`: unit/component checks and axe only when a DOM fixture exists; no
  required browser E2E.
- `behavioral`: local headless Playwright on the built app; assert DOM,
  actions, routing, hydration, console, and network. Screenshots are optional.
- `visual`: all behavioral checks plus fresh screenshots at every
  `requiredScreenshotWidths` value (normally 390 and 1440; 768 only when the
  contract detected tablet risk).
- `native-ui`: use the selected simulator/emulator adapter, never a browser.

For behavioral/visual QA, build current source, start the built app on a free
strict port owned by this run, and record run/source/build hashes, PID, port,
start time, URL, expected fingerprint, and the fingerprint observed over HTTP.
Reject a stale server, reused port, foreign fingerprint, or artifact older than
the server. Write route evidence for every changed route and prove its planned
final path rather than accepting a fallback shell or redirect.

If a required browser/native runtime is genuinely unavailable after all other
checks complete, set report status `blocked-environment` with a bounded safe
reason and return `TESTS_FAILING`; never convert it to green. A browser cannot
block `none` or `nonvisual`. The interactive browser plugin is optional
diagnosis and never substitutes for the canonical local Playwright report.

For generated websites or changed web routes, include metadata regression
coverage for every created or changed public route's title, description,
canonical URL, OG image, JSON-LD, sitemap inclusion, and private/admin noindex.
For changed UI in a project with i18n, include tests that assert translated
accessible labels/names through the rendered UI. For touched EnvBanner or
missing-config setup surfaces, assert the setup link href is exactly
`https://traffic.io/`.

Write your digest to:
  .traffic-one/digests/<run-id>/tester.md
```

## Run-ledger settlement (orchestrator only)

The parent orchestrator, not a verifier role, records the current run through
the shipped idempotent helper. Call it through the version-stable shim below
exactly as written — the shim resolves the live plugin root itself, so it keeps
working across plugin upgrades and needs no `*_PLUGIN_ROOT` environment variable
(your shell has none). Replace `<run-id>` with the current run id, and never
hand-edit `run.json`.

```bash
# Reviewer cap after the second unsuccessful cycle.
node ~/.traffic-one/bin/run-status.cjs --run-id "<run-id>" --status blocked --outcome review-cycle-cap

# Tester cap after the second unsuccessful implementation/test fix cycle.
node ~/.traffic-one/bin/run-status.cjs --run-id "<run-id>" --status blocked --outcome test-cycle-cap

# Browser/sandbox/usage-limit/timeout blocker that remains unresolved.
node ~/.traffic-one/bin/run-status.cjs --run-id "<run-id>" --status blocked --outcome environment-blocked

# Unrecoverable orchestration/role-agent failure only.
node ~/.traffic-one/bin/run-status.cjs --run-id "<run-id>" --status failed --outcome agent-failed

# Same-run resume only after explicit user authorization.
node ~/.traffic-one/bin/run-status.cjs --run-id "<run-id>" --status active --reason user-authorized-extra-cycle

# Strictly verified terminal run; reviewer + tester + QA/backend-only gate passed.
node ~/.traffic-one/bin/run-status.cjs --run-id "<run-id>" --status completed --outcome verified

# Successful shipper digest after the deploy actually completed.
node ~/.traffic-one/bin/run-status.cjs --run-id "<run-id>" --status completed --outcome shipped
```

The completed commands are evidence-gated. Never infer them from green text,
deploy intent, or delegated-only output. Blocked/failed settlement preserves
the run and its role agents for the unresolved-run flow.

When reading `run.json`, know that its top-level `status`/`outcome` are a
compatibility projection for older runtimes, NOT the run's truth: a V2 run
that is still verifying is deliberately projected as `status: "failed"` /
`outcome: "agent-failed"` so a rolled-back runtime cannot resume it.
`canonicalStatus` (and `runtimeV2RollbackGuard.canonicalStatus`) is the truth —
e.g. `canonicalStatus: "validating"` means verification is still settling, not
that any agent died. Never build a recovery story from the projected
`failed`/`agent-failed` pair, and never request `--status active --reason
user-authorized-extra-cycle` for it (that edge exists only for a canonically
`blocked` run). If a `completed` command is rejected, the stderr names the
exact failed check (reviewer/tester verdict, QA evidence, claims) — fix that
named check and re-run the same command.

## Phase 4 — Shipper (only on explicit deploy intent)

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and verify every run-id in the paths below equals it. If a path still shows the literal `<run-id>`, substitute that exact value. The reviewer + tester digests are at:
  .traffic-one/digests/<run-id>/reviewer.md     (must contain "verdict: APPROVED")
  .traffic-one/digests/<run-id>/tester.md       (must contain "verdict: TESTS_GREEN")

Read in priority order:
  1. Both verifier digests above. If either is not green/approved, STOP and
     report; do not stamp shipper approval.
  2. .traffic-one/plan.md § Risks + § Cut-list.
  3. .traffic-one/deployments.jsonl, .traffic-one/stack.md,
     and .traffic-one/known-issues.md if present.
  4. .env.example to surface missing env vars.

Before any stamp or deploy, read
`.traffic-one/runs/<run-id>/verification-v2.json` and require its canonical
`.traffic-one/reports/qa/<run-id>/report-v2.json` to be a fresh, parser-valid
`QaReportV2` with matching run/contract/source hashes and every derived
requirement passed. `none/nonvisual` require no browser, `behavioral` requires
functional Playwright but no screenshot, `visual` requires the listed widths,
and `native-ui` requires its native adapter. If QA is missing, failed, blocked,
stale, or hash-mismatched, STOP; do not stamp, deploy, or advertise shipping.

Run `predeploy-security-check --strict --stamp`, then run the `verification-loop`
Production-Readiness Score. If the score has hard blockers or is below 80/100
for a production deploy, STOP and route fixes back to the orchestrator.

If release-facing docs or project memory changed or are missing, run
`project-memory` and `auto-documentation-generator` before stamping shipper
approval.

Stamp .traffic-one/.one.json's `lastShipperApprovalAt` field with `nowIso()` BEFORE
running any deploy command (the deploy-gate hook reads this stamp; 10-min
window).

Run the active-stack deploy command. Capture the URL, git SHA, and rollback
command in your digest. Include the Production-Readiness Score in the digest.
Append one JSON line to .traffic-one/deployments.jsonl and a short release
summary to .traffic-one/agent-log.md. Never log secrets.

Write your digest to:
  .traffic-one/digests/<run-id>/shipper.md

Set its literal verdict to `SHIPPED` only after the deploy and post-deploy
checks complete successfully; otherwise set `FAILED`. End the reply with the
same literal token. A created/nonempty shipper digest is not proof of success.
```

## Cleanup (Phase 5 — orchestrator does this, not a subagent)

Run cleanup only after strict terminal settlement: reviewer approved, tester
green, and strict QA passed (or genuinely backend-only), or shipper completed.
For blocked/nonterminal verification, preserve the current run id, digests, QA
artifacts, fix-cycle state, and role agents; do not stamp maintenance or run
this cleanup. After a terminal Phase 4 (or terminal Phase 3 if no shipper), keep
the last 3 run folders under `.traffic-one/digests/`. Remove older ones.
Implementation:

```bash
ls -t .traffic-one/digests | tail -n +4 | xargs -I{} rm -rf .traffic-one/digests/{}
```

This keeps recent history auditable without unbounded growth. The whole
`.traffic-one/digests/` tree is gitignored.
