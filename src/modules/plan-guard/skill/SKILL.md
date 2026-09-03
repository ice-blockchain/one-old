---
name: traffic-one-plan-guard
description: Wording source for the Traffic One plan-write gate deny reasons. Read at runtime via skillBlock(); the deny conditions live in TS.
---

# Traffic One Plan Guard

Deny-reason wording for the PreToolUse file-write/file-edit plan gate.
Enforcement (the actual conditions + `permissionDecision:"deny"`) is implemented
by the installed Traffic One runtime. `{{PLACEHOLDER}}` tokens are filled by the
gate. Each block has a verbatim fallback in code, so a missing block never disables a gate.

<!-- T1BLOCK:BEGIN monorepo-package-json -->
New-project monorepo gate: stack=default / React-Vite new projects must start with the Traffic One Turborepo root package.json: `private: true`, `packageManager: pnpm@...`, and a workspace declaration (`pnpm-workspace.yaml` or package.json `workspaces`) for `apps/*` and `packages/*`. Read `rules/modes/new-project.md` and scaffold the monorepo before feature code.
<!-- T1BLOCK:END monorepo-package-json -->

<!-- T1BLOCK:BEGIN monorepo-root-vite -->
New-project monorepo gate: root Vite app files are not allowed for this stack. Use `apps/web/` for the React app and create the required `packages/*` workspaces first; see `rules/modes/new-project.md`.
<!-- T1BLOCK:END monorepo-root-vite -->

<!-- T1BLOCK:BEGIN monorepo-root-flat-scaffold -->
New-project monorepo gate: root-level TypeScript app config files (`tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, etc.) are not allowed for this stack. Complete the architect phase and scaffold the Turborepo workspace (`pnpm-workspace.yaml`, `apps/web/`, `packages/*`, `tsconfig.base.json`) instead of creating a flat root Vite layout.
<!-- T1BLOCK:END monorepo-root-flat-scaffold -->

<!-- T1BLOCK:BEGIN state-gate -->
State gate: root .traffic-one/.one.json is missing or incomplete. Write the Traffic One state file with mode, stack, backend, realtime, confirmed, onboardingComplete, and confirmedAt before writing feature source. The .traffic-one/ folder is project memory, not the stack-selection state file.
<!-- T1BLOCK:END state-gate -->

<!-- T1BLOCK:BEGIN state-mode-downgrade -->
State mode gate: this project was onboarded as `new-project`; rewriting `.traffic-one/.one.json` to any other mode mid-run would disarm the architecture gates that mode selects. An UNRECOGNIZED `mode` counts — `workspace`, `brownfield`, anything the mode table does not name stands the same gates down as `existing-codebase` while the run's compiled architecture and verification contracts stay frozen against the old profile. An empty, absent or null `mode` is refused for a different reason: state normalization repairs it back to `new-project` on the next materialization pass, so the write does not survive as written and any gate reading the file before that pass reads a mode this project never declared. Mode changes go through onboarding, not a state-file edit. If the user explicitly wants this project treated as an existing codebase, re-run Traffic One onboarding.
<!-- T1BLOCK:END state-mode-downgrade -->

<!-- T1BLOCK:BEGIN materialization-gate -->
Materialization gate: stack context for {{FINGERPRINT}} has not been materialized on disk yet. Run `node -e "const p=require('node:path'),e=process.env,r=p.resolve(e.TRAFFIC_ONE_PLUGIN_ROOT||e.CURSOR_PLUGIN_ROOT||e.CODEX_PLUGIN_ROOT||e.CLAUDE_PLUGIN_ROOT||process.cwd());process.argv.splice(1,0,'traffic-one-runtime');require(p.join(r,'scripts','hook-runtime.cjs'))" materialize-project` from the project root and verify `.traffic-one/rules/**`, `.traffic-one/skills/**`, `.traffic-one/manifest.json`, root `AGENTS.md`, and root `CLAUDE.md` exist before writing feature source.
<!-- T1BLOCK:END materialization-gate -->

<!-- T1BLOCK:BEGIN plan-gate -->
Plan gate: .traffic-one/plan.md is missing on a new project. Run the `senior-architect` subagent (or the `senior-eng-orchestrator` skill) to produce the plan before writing feature source files. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.
<!-- T1BLOCK:END plan-gate -->

<!-- T1BLOCK:BEGIN plan-main-agent-gate -->
Plan gate: .traffic-one/plan.md is missing on a new project in Low/main-agent mode. Do NOT call `run_subagent`, `Task`, `spawn_agent`, `task`, or another subagent tool. You are the architect in this thread: write `.traffic-one/plan.md` and required `.traffic-one/` project memory before root config, workspace scaffold, or feature-source writes; then resume the same ordered phases. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.
<!-- T1BLOCK:END plan-main-agent-gate -->

<!-- T1BLOCK:BEGIN plan-architect-self-gate -->
Plan gate: .traffic-one/plan.md is missing on this new project. You ARE the `senior-architect` for this run — write `.traffic-one/plan.md`, project memory, and semantic ArchitectureInputV1; do not spawn another architect and do not scaffold implementation files.
<!-- T1BLOCK:END plan-architect-self-gate -->

<!-- T1BLOCK:BEGIN architect-memory-baseline-gate -->
Architect completion gate: do not write `PLAN_READY` until the required `.traffic-one` project-memory baseline exists with real content. Missing or incomplete: {{MISSING}}. Write the missing memory files yourself (do not delegate `.traffic-one/*` to OpenCode), then update `.traffic-one/digests/<runId>/architect.md` and only then emit `PLAN_READY`.
<!-- T1BLOCK:END architect-memory-baseline-gate -->

<!-- T1BLOCK:BEGIN architect-planning-allowlist-gate -->
Architect scope gate: `senior-architect` may write only the semantic plan/project-memory files, NEW ADRs under `.traffic-one/decisions/<name>.md` (existing ones are append-only across runs — use the `<runId>-` prefix to rewrite your own), `.traffic-one/runs/<runId>/architecture-input-v1.json`, and its architect digest. `{{TARGET}}` is runtime- or implementer-owned. Do not scaffold packages, workspace/config/source files, barrels, Tailwind assets, tests, or assignments; emit semantic ArchitectureInputV1 and let runtime compile the work units.
<!-- T1BLOCK:END architect-planning-allowlist-gate -->

<!-- T1BLOCK:BEGIN architect-opencode-queue-gate -->
Architect completion gate: OpenCode is enabled but the plan is missing at least 3 runnable machine-readable delegation units. Include `<!-- opencode-delegate:start -->` … `<!-- opencode-delegate:end -->` with 3–6 bounded units (`- id: <stable-unit-id> | role: … | files: … | task: …`) in `.traffic-one/plan.md` before emitting `PLAN_READY`. The orchestrator runs `opencode_delegate_from_plan` from that block BEFORE spawning implementers.
<!-- T1BLOCK:END architect-opencode-queue-gate -->

<!-- T1BLOCK:BEGIN architect-opencode-self-delegation-gate -->
Architect completion gate: this run is already hosted by OpenCode/Kilo, so `.traffic-one/plan.md` must not include an OpenCode delegation queue or `opencode-delegate` marker. Remove the self-delegation block before emitting `PLAN_READY`; implementer work runs directly on the current host.
<!-- T1BLOCK:END architect-opencode-self-delegation-gate -->

<!-- T1BLOCK:BEGIN plan-opencode-queue-gate -->
Plan gate: OpenCode is enabled — `.traffic-one/plan.md` must include the machine-readable `<!-- opencode-delegate:start -->` … `<!-- opencode-delegate:end -->` block with at least 3 runnable bounded units (`- id: <stable-unit-id> | role: frontend|backend|tester|docs | files: … | task: …`). Prose-only or incomplete OpenCode lists are ignored by `opencode_delegate_from_plan`. A rewrite may omit the block only after a queue was accepted for the current run — runtime then preserves and re-appends it. Concrete example of a runnable unit row:
`<!-- opencode-delegate:start -->`
`- id: seed-demo-data | role: backend | files: supabase/seed.sql | task: Seed the demo rows the plan data section describes`
`<!-- opencode-delegate:end -->`
<!-- T1BLOCK:END plan-opencode-queue-gate -->

<!-- T1BLOCK:BEGIN plan-opencode-self-delegation-gate -->
Plan gate: this run is already hosted by OpenCode/Kilo, so `.traffic-one/plan.md` must not include an OpenCode delegation queue or `opencode-delegate` marker. Remove the self-delegation block; implementer work runs directly on the current host.
<!-- T1BLOCK:END plan-opencode-self-delegation-gate -->

<!-- T1BLOCK:BEGIN architect-opencode-queue-policy-gate -->
Architect completion gate: OpenCode queue files or metadata do not match this run's compiled contract: {{ERRORS}}. This is a recoverable architect rewrite, not a crashed run. Fix the queue block in `.traffic-one/plan.md` (stable unique ids, parseable `files:`, explicit `depends:` edges for overlaps) and re-emit `PLAN_READY`. Scope errors above list the owning role's real compiled in-scope files — retarget each unit's `files:` to those exact paths, or declare the module in ArchitectureInputV1 so runtime compiles the output you need.
<!-- T1BLOCK:END architect-opencode-queue-policy-gate -->

<!-- T1BLOCK:BEGIN supabase-local-stack-gate -->
Supabase gate: the local Supabase stack is not part of this project's flow — do not run `supabase start`/`stop`, `supabase db reset`, `supabase functions serve`, or the `db:start`/`db:stop`/`db:reset`/`functions:serve` scripts, and do not boot Docker/OrbStack/Colima for them. Author `supabase/config.toml`, `supabase/migrations/*.sql`, and `supabase/functions/**` in the repo only; the user connects the real project (env keys, migration apply) through the traffic.io platform — every setup CTA links to `https://traffic.io/` — and the app must run in not-configured demo mode behind the EnvBanner until then. Verify SQL by review and committed migrations, not against a local database; `supabase db push --linked` stays a shipper-gated deploy action.
<!-- T1BLOCK:END supabase-local-stack-gate -->

<!-- T1BLOCK:BEGIN plan-opencode-queue-policy-gate -->
Plan gate: OpenCode queue metadata is unsafe: {{ERRORS}}. Add stable unique `id` fields, exact `files` allowlists, and `depends` edges for overlapping areas.
<!-- T1BLOCK:END plan-opencode-queue-policy-gate -->

<!-- T1BLOCK:BEGIN scaffold-stack-gate -->
Stack gate: this scaffolder conflicts with the runtime-derived capability contract ({{PROFILE_SUMMARY}}). Use `.traffic-one/plan.md` and `CompiledArchitectureV1` outputs for the detected framework and roots. If the requested stack differs, replan and correct capability evidence before scaffolding.
<!-- T1BLOCK:END scaffold-stack-gate -->

<!-- T1BLOCK:BEGIN scaffold-plan-gate -->
Plan gate: run the `senior-architect` subagent FIRST to produce `.traffic-one/plan.md` before scaffolding a new project. On Windsurf/Devin spawn it with `run_subagent` (profile `senior-architect`); the runtime derives the actual framework, roots, allowed roles, skills, and QA before implementation. Do not run `create-*` app scaffolders or invent layout conventions before the compiled plan exists. Runtime contract: {{PROFILE_SUMMARY}}.
<!-- T1BLOCK:END scaffold-plan-gate -->

<!-- T1BLOCK:BEGIN scaffold-main-agent-plan-gate -->
Plan gate: `.traffic-one/plan.md` is missing and this project is in Low/main-agent mode. Do NOT call `run_subagent` or another subagent tool. You are the architect in this thread: write the plan and required `.traffic-one/` project memory before root config or workspace scaffolding, then continue with the same ordered phases. Do not run `create-*` app scaffolders before the plan exists. Follow the runtime capability contract, not a frontend default: {{PROFILE_SUMMARY}}.
<!-- T1BLOCK:END scaffold-main-agent-plan-gate -->

<!-- T1BLOCK:BEGIN runtime-assignments-owner-gate -->
Runtime contract gate: `.traffic-one/runs/<runId>/assignments.json` is generated atomically from CompiledArchitectureV1 and VerificationContractV2. Agents and the parent may not create, edit, widen, or replace it; change ArchitectureInputV1 and re-run PLAN_READY compilation instead.
<!-- T1BLOCK:END runtime-assignments-owner-gate -->

<!-- T1BLOCK:BEGIN runtime-sidecar-owner-gate -->
Runtime sidecar gate: `{{TARGET}}` is published by the runtime. Do not create, edit, delete, or repair it.
Read it if you need the contents. To change run state, change the semantic input or invoke the owning runtime transition.
Write/Edit/apply_patch of this path are refused. Unrecognised shell that names this path is refused.
<!-- T1BLOCK:END runtime-sidecar-owner-gate -->

<!-- T1BLOCK:BEGIN reset-record-owner-gate -->
Reset record gate: `.traffic-one/runs/.resets.json` is the project's record of every reset — how many have happened, and what each successor run inherited because of them. Traffic One's own recovery command is its only writer, and no agent, child or parent may create, edit, delete, truncate, move, replace or repair it through any channel. There is no correct run directory to write it under, so this refusal has no "write it somewhere else" remedy: it is not a run artifact and does not live inside a run. Erasing it USED to do two things — make the next reset free again, and drop the terminal model exhaustion a reset at or past the widening threshold handed the current run, which is what stops a role whose model is exhausted from respawning without the user's enable/retry answer. Both of those facts are now MIRRORED into the successor run's own `runs/<runId>/run.json` by the same reset that records them, and both readers take the record UNION that mirror with the user's enable/retry discharge ahead of both, so erasing THIS FILE ALONE moves neither decision: measured after a real `rm` through a spelling this fence does not see, the next reset is still priced at the height the ladder had reached and the inherited exhaustion still stands, and the user's answer still clears it in place. That is not the same claim as "erasing the record no longer pays", and it is deliberately not that claim — the mirror is a second copy inside the same project, so a command that takes the whole `runs/` directory takes both of them, and what the successor's `run.json` has instead of immunity is a fence of its own (`runtime-sidecar-owner-gate`) which was measured answering the three spellings below exactly as this fence answers them — the second copy is not better hidden, it is a different file, and being a different file is the whole of what it buys. READING it is allowed: `cat`, `head`, `tail`, `grep`, `jq`, `wc`, `sed -n` and an interpreter read of the path are all permitted. A command that names the record with any other verb is refused, because a file with no legitimate agent write has nothing to tell an unrecognised one apart from; so is a command that destroys a directory containing it (`rm -rf .traffic-one/runs`, `git clean -fdx`). A shell line that hides the path from static reading stood here as a five-member list — assembled by `cd`, a variable, `$(…)`, `eval`, or joined inside interpreter code — and the round that taught this fence to read the shell the way its sibling does falsified three of the five, so what follows is what was re-measured rather than what was inherited. REFUSED now, in all three project states: `cd .traffic-one/runs && rm -f .resets.json` and its `;` spelling, `R=.traffic-one/runs; rm -rf "$R"`, and an interpreter join that leaves any fragment spelling `.traffic-one` or this file's own name (`'.traffic-one/' + 'runs/.resets.json'`). STILL UNSEEN, which is a breach this gate cannot see rather than a route it permits, each one measured erasing this file in real bash at no refusal: what a substitution PRINTS (`rm -rf "$(cat where)"`); a `$( … )` body or a literal `eval` in the two states where no run directory exists for a sibling fence to answer first (`rm -rf "$(echo .traffic-one/runs)"` and `eval "rm -rf .traffic-one/runs"` are refused while a run directory is live and were measured NOT REFUSED once it is gone, which is when this file is the only thing left below `runs/`); and a join that splits both names through the middle (`'.tra' + 'ffic-one/runs/.res' + 'ets.json'`). That is what has been MEASURED to be unseen, in the states it was measured in, and not a proof that nothing else is. WHAT THOSE THREE NOW BUY is the other half of the same measurement, and it is the mirror above rather than any refusal that changed it: aimed at this file alone, they buy nothing — both decisions read the same before and after the erasure. Aimed at the whole `runs/` directory they still take both copies at no refusal, and the printed-substitution spelling was measured doing exactly that; aimed at either file alone they take one copy and the other still answers. So the unseen list above is unchanged, only the payoff of its narrowest use has moved, and a tree-wide erasure is recorded here as a known breach rather than implied to be closed. If the record itself is genuinely in the way, that is an operator decision made outside the agent, not a write to re-issue.
<!-- T1BLOCK:END reset-record-owner-gate -->

<!-- T1BLOCK:BEGIN architecture-input-owner-gate -->
Architecture input gate: only the parent-bound `senior-architect` planning role may write ArchitectureInputV1; active role is `{{ROLE}}`. Retrying the write, or making it through shell instead, draws the same refusal — the owner is decided by the run's role claim, not by the tool. Record the semantic change you wanted (routes, modules including component placement, exact UI primitive identifiers, i18n locale/exact-brand intent, or a narrow exception request) in your own digest instead, and let the orchestrator route it to `senior-architect`, who owns this artifact and re-runs PLAN_READY compilation from it.
<!-- T1BLOCK:END architecture-input-owner-gate -->

<!-- T1BLOCK:BEGIN architecture-input-gate -->
Architecture input gate: ArchitectureInputV1 may contain only semantic routes, modules (including component placement), exact UI primitive identifiers, i18n locale/exact-brand intent, and narrow exception requests. Runtime owns profiles, roots, roles, limits, output paths, and the baseline. Fix: {{ERRORS}}.
<!-- T1BLOCK:END architecture-input-gate -->

<!-- T1BLOCK:BEGIN architecture-input-shell-unverified -->
Architecture input gate: this shell command references `{{TARGET}}` but its write payload cannot be reconstructed for validation, and the current on-disk file is not valid ArchitectureInputV1 ({{ERRORS}}). Read-only checks pass once the on-disk file is valid; to (re)write it, use the role-scoped Write/Edit tools with the complete semantic JSON instead of shell eval.
<!-- T1BLOCK:END architecture-input-shell-unverified -->

<!-- T1BLOCK:BEGIN architecture-assignment-gate -->
Architecture assignment gate: the runtime-compiled outputs are not covered before spawn. {{ERRORS}}. Amend semantic ArchitectureInputV1 and re-run PLAN_READY compilation; never edit or widen runtime-owned assignments.
<!-- T1BLOCK:END architecture-assignment-gate -->

<!-- T1BLOCK:BEGIN architecture-contract-gate -->
Architecture contract gate: do not emit `PLAN_READY` until the run's `architecture-input-v1.json` is valid and runtime compilation succeeds. {{ERROR}}. The architect may change only semantic routes/modules/component placement/uiPrimitives/i18n/exceptions; runtime owns roots, roles, outputs, baseline, and hashes.
<!-- T1BLOCK:END architecture-contract-gate -->

<!-- T1BLOCK:BEGIN architecture-scan-bound-gate -->
Architecture scan bound: compilation listed {{COUNT}} source-surface files, which exceeds the compile listing bound. Narrow `sourceRoots` / `layerRoots` or declare generated trees in `buildOutputs` so the listing stays inside the owned surface.
<!-- T1BLOCK:END architecture-scan-bound-gate -->

<!-- T1BLOCK:BEGIN contract-self-conflict -->
Contract satisfiability gate: the compiled plan demands outputs its own write gates forbid — {{CONFLICTS}}. `PLAN_READY` is denied before any implementer spawns: a role facing this contract would be hard-denied on a mandatory output and the run would deadlock. Fix the semantic ArchitectureInputV1 (routes/modules/placement/i18n/exceptions) so every compiled output is writable, then re-emit `PLAN_READY`.
<!-- T1BLOCK:END contract-self-conflict -->

<!-- T1BLOCK:BEGIN capability-no-implementer-gate -->
Capability gate: this project's saved stack selection resolves to a capability profile with NO implementation role — {{PROFILE}}. `PLAN_READY` is denied because neither `senior-frontend` nor `senior-backend` is eligible, so no implementer can be spawned and nothing planned here could ever be built. This is a STACK-SELECTION defect in the project's `.traffic-one/.one.json`, not a planning mistake: no change to `architecture-input-v1.json` can fix it, and re-emitting `PLAN_READY` will be denied identically. Tell the user their saved selection names no buildable surface, and ask them to re-run Traffic One setup (or correct `frontend`/`backend` in `.traffic-one/.one.json`) so the project has a real web/native UI, a real backend, or both. Runtime freezes the capability profile when a run id is minted, so the corrected selection takes effect only in a NEW run — run `{{RUN_ID}}` must be replaced, not retried.
<!-- T1BLOCK:END capability-no-implementer-gate -->

<!-- T1BLOCK:BEGIN verification-contract-scan-gate -->
Verification contract gate: STRUCT_SCAN_INCOMPLETE ({{ERROR}}). Runtime could not derive the complete diff from the immutable baseline. `PLAN_READY` proceeds and the contract published below carries the truncation: `uiImpact` is pinned to the truncated-scan floor, so this run owes the browser evidence that floor requires. It cannot be CERTIFIED in this state, though — settlement re-derives the source identity from the same baseline and rejects the QA report as `scan-incomplete` whenever THAT scan is still truncated, no matter what evidence the tester gathers (it is the live re-derivation that decides, not the `scanComplete` field frozen into this contract; they agree only while the cause below is unfixed). Clear the cause named above (resolve the Git worktree, drop the symlink, narrow the generated/output roots the walk is counting) so the diff recompiles complete before the run reaches QA.
<!-- T1BLOCK:END verification-contract-scan-gate -->

<!-- T1BLOCK:BEGIN verification-contract-refresh-gate -->
Verification refresh gate: `IMPLEMENTED` is forbidden because runtime could not rederive and atomically republish VerificationContractV2 from the immutable baseline ({{ERROR}}). Repair the semantic plan or runtime prerequisite and retry the same digest; stale UI-impact requirements never reach QA.
<!-- T1BLOCK:END verification-contract-refresh-gate -->

<!-- T1BLOCK:BEGIN verification-contract-refresh-gate-approved -->
Verification refresh gate: `APPROVED` is forbidden because {{ERROR}}. Re-read the newly published bootstrap/verification hash and repeat the review under the final risk contract.
<!-- T1BLOCK:END verification-contract-refresh-gate-approved -->

<!-- T1BLOCK:BEGIN verification-contract-refresh-gate-tests-green -->
Verification refresh gate: `TESTS_GREEN` is forbidden because {{ERROR}}. Re-read the newly published verification hash, regenerate risk-proportional evidence, and retry the tester verdict.
<!-- T1BLOCK:END verification-contract-refresh-gate-tests-green -->

<!-- T1BLOCK:BEGIN bootstrap-publication-gate -->
Bootstrap gate: the parent could not atomically refresh the role/rule/skill and work-unit envelopes against the compiled architecture and verification contracts. No implementer may spawn until the immutable envelopes are published.
<!-- T1BLOCK:END bootstrap-publication-gate -->

<!-- T1BLOCK:BEGIN frontend-structure-hot-gate -->
Structural gate: {{FINDINGS}}. Entrypoints may only bootstrap the app; route pages must be separate compiled modules. Formatting the same monolith across more lines does not satisfy this gate.
<!-- T1BLOCK:END frontend-structure-hot-gate -->

<!-- T1BLOCK:BEGIN frontend-structure-scan-incomplete -->
Frontend completion gate: STRUCT_SCAN_INCOMPLETE after {{SCANNED}} product source files. This is recorded, not blocking: hitting the scan bound raises `uiImpact` to the truncated-scan floor on this run's verification contract, so the run owes more browser evidence rather than less. Narrow generated/output roots or split the project contract so the whole owned tree is judged.
<!-- T1BLOCK:END frontend-structure-scan-incomplete -->

<!-- T1BLOCK:BEGIN frontend-collapse-gate -->
Frontend completion gate: do not write `IMPLEMENTED` with collapsed source. `{{FILE}}` packs an entire component/route onto one line. Collapsed or minified product source is a defect even when build and typecheck pass. Format it and split routes, pages, features, and shared components according to the compiled architecture before re-emitting `IMPLEMENTED`.
<!-- T1BLOCK:END frontend-collapse-gate -->

<!-- T1BLOCK:BEGIN implementer-collapse-gate -->
Implementer completion gate: do not write `IMPLEMENTED` with collapsed source. `{{FILE}}` packs an entire function/component onto a single line — collapsed/minified source is a defect even when build, typecheck and lint pass, and the project formatter could not repair it. Write one statement per line, run the project formatter, and re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END implementer-collapse-gate -->

<!-- T1BLOCK:BEGIN frontend-emit-config-gate -->
Frontend completion gate: {{PROBLEMS}}. The stock Vite template emits compiled `.js`/`.d.ts` next to every source on the first build, and the stale output can shadow the module at import time. Fix exactly this: set `"noEmit": true` in the app tsconfig, remove `"composite": true`, and use `"build": "tsc --noEmit && vite build"`, `"typecheck": "tsc --noEmit"`. Then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END frontend-emit-config-gate -->

<!-- T1BLOCK:BEGIN frontend-eslint-survival-gate -->
Frontend completion gate: {{PROBLEMS}}. The scaffolded eslint config is the project's quality bar — the error-grade rules (`max-lines`, `no-restricted-imports`) replaced retired deterministic gates and CI runs them after this build ends. Extend the config freely, but restore the scaffolded error rules before re-emitting `IMPLEMENTED`.
<!-- T1BLOCK:END frontend-eslint-survival-gate -->

<!-- T1BLOCK:BEGIN implementer-format-parity-gate -->
Implementer format parity gate: role `{{ROLE}}` owns formatter config `{{CONFIG}}`, but `prettier` is not declared in `{{MANIFEST}}` dependencies/devDependencies. A script or config that names an absent tool makes verification meaningless. Add `prettier` with the selected package manager at tooling root `{{TOOLING_ROOT}}`, then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END implementer-format-parity-gate -->

<!-- T1BLOCK:BEGIN implementer-format-toolchain-gate -->
Implementer format toolchain gate: role `{{ROLE}}` owns compiled formatter outputs at `{{TOOLING_ROOT}}`, but no Prettier config, `format`/`format:check` scripts, or `prettier` dependency is present. Create `{{CONFIG}}`, add matching scripts and the dependency to `{{MANIFEST}}`, run the formatter, then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END implementer-format-toolchain-gate -->

<!-- T1BLOCK:BEGIN implementer-format-coverage-gate -->
Implementer format coverage gate: the `{{MANIFEST}}` "{{SCRIPT}}" script runs `{{COMMAND}}`, whose arguments never reach compiled outputs including {{UNCOVERED}}. A formatter that skips owned source proves nothing — it passes while those files are unformatted. Check the whole project instead (`prettier --check .`) and put build output, lockfiles, and `.traffic-one` in `.prettierignore`, then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END implementer-format-coverage-gate -->

<!-- T1BLOCK:BEGIN registry-probe-gate -->
Registry probe gate: do not query the npm registry (`npm view`/`show`/`info`/`outdated`, `pnpm view`, `yarn info`) to pick scaffold or dependency versions during new-project setup. Versions come from the active stack contract — install with the pinned ranges (`pnpm add <pkg>` resolves the latest matching minor/patch). Only an explicit user request for a newer major overrides a pin, recorded as an ADR in `.traffic-one/decisions/`.
<!-- T1BLOCK:END registry-probe-gate -->

<!-- T1BLOCK:BEGIN implementer-typecheck-toolchain-gate -->
Implementer typecheck gate: role `{{ROLE}}` owns compiled TypeScript outputs, but no `typescript` dependency or `typecheck` script exists in {{MANIFESTS}}. `IMPLEMENTED` without a runnable compiler is unverifiable — the type errors surface later in a sibling role's build instead. Add `typescript` and a `typecheck` script (`tsc --noEmit`) to the tooling root, run it clean, then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END implementer-typecheck-toolchain-gate -->

<!-- T1BLOCK:BEGIN implementer-verification-skipped-gate -->
Implementer verification gate: this digest reports a required command as skipped or unavailable — "{{EVIDENCE}}" — directly alongside `IMPLEMENTED`. A verdict is a claim that the owned scope was verified, so an unrun build/typecheck/lint makes it unverifiable and the errors surface later in a sibling role's build. Install the toolchain at its owning manifest, run the command to completion, record the real outcome, then re-emit `IMPLEMENTED`. If the command genuinely does not apply, say why without claiming it was skipped.
<!-- T1BLOCK:END implementer-verification-skipped-gate -->

<!-- T1BLOCK:BEGIN implementer-test-toolchain-gate -->
Implementer test toolchain gate: role `{{ROLE}}` owns `{{MANIFEST}}`, and the contract compiles tester-owned runner configs there, but {{MISSING}} is absent. The tester owns the configs and never the manifest, so it cannot install its own runner — it inherits a config for a tool that is not there and has no way to run the suite. When the verification contract requires performance evidence, project-local `lighthouse` belongs in the same manifest for the same reason. Add the missing dependencies and scripts to `{{MANIFEST}}`, then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END implementer-test-toolchain-gate -->

<!-- T1BLOCK:BEGIN implementer-crawl-origin-gate -->
Implementer crawl origin gate: `{{FILE}}` ships an unusable production origin — {{DETAIL}}. Crawl assets are published verbatim, so an invented origin is a live defect, not a placeholder. Generate these files from the public site-url env var (`VITE_SITE_URL` or the framework equivalent) and fail generation when it is unset; leave the deploy origin `Unverified` in project memory until the user supplies it. Then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END implementer-crawl-origin-gate -->

<!-- T1BLOCK:BEGIN implementer-typecheck-invocation-gate -->
Implementer typecheck gate: the root `package.json` "typecheck" script runs `{{SCRIPT}}`, which never invokes the per-package `typecheck` this contract demanded in {{MANIFESTS}}. A compiler that is installed, scripted, and never run is not coverage — the project's own command reports success while the errors stay unreported. Broadcast to every workspace member (`pnpm -r typecheck`, `turbo run typecheck` with no filter) or name each package in the filter, run it clean, then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END implementer-typecheck-invocation-gate -->

<!-- T1BLOCK:BEGIN implementer-contract-delivery-gate -->
Implementer completion gate: `IMPLEMENTED` is forbidden while {{COUNT}} of role `{{ROLE}}`'s {{PLANNED}} compiled modules do not exist and were never observed as changed ({{MISSING}}). `changedPaths` unions the observed diff with every PLANNED output, so a contract can look complete while the files were never written — a verdict must describe what was delivered, not what was planned. Write the missing modules, or report `BLOCKED` naming them. Do not re-emit `IMPLEMENTED` until each one exists.
<!-- T1BLOCK:END implementer-contract-delivery-gate -->

<!-- T1BLOCK:BEGIN lighthouse-claim-reconciliation-gate -->
Page-speed claim gate: this digest reports Lighthouse performance {{CLAIMED}} — "{{EVIDENCE}}" — but the canonical QA runner measured {{MEASURED}} for run `{{RUN_ID}}`. A self-run audit is not the run's evidence: it can use a different Lighthouse version, a dev server, or a build from another run, and its report files are not run-scoped. Quote the runner's number (`.traffic-one/reports/qa/{{RUN_ID}}/lighthouse-evidence-v1.json`), or re-run the canonical sweep and quote the fresh one.
<!-- T1BLOCK:END lighthouse-claim-reconciliation-gate -->

<!-- T1BLOCK:BEGIN frontend-structure-completion-gate -->
Frontend completion gate: the runtime structure report failed ({{FINDINGS}}). Fix every blocking finding, then write `IMPLEMENTED` again — the gate re-scans the current tree on that write. Per-component LOC, function-count, and component-count findings remain warnings during this rollout; module size is owned by the compiled eslint `max-lines` rule — the project's own `lint` run refuses an oversized module, so split it. Integration findings block too: orphan modules, unused API packages, inert styling, a missing i18n runtime (`STRUCT_I18N_RUNTIME`), and catalog validation (`STRUCT_I18N_CATALOG` — keys non-empty in every declared locale). Hardcoded-copy findings (`STRUCT_HARDCODED_COPY`, `STRUCT_I18N_REACT_TRANS`) block only on profiles without a compiled AST lint layer; where the scaffolded eslint config carries the i18n rule, the project's own `lint` run owns them. React child copy uses `<Trans>` with namespace, key, and fallback.
<!-- T1BLOCK:END frontend-structure-completion-gate -->

<!-- T1BLOCK:BEGIN implementer-lint-toolchain-gate -->
Implementer lint gate: role `{{ROLE}}` owns the compiled `{{CONFIG}}`, whose AST rules are this run's quality verdict for UI source, but {{MISSING}} is absent from `{{MANIFEST}}`. The write-time lexical copy scanners are warnings on this profile on exactly the promise that the project's own `lint` runs — a lint layer that cannot run is an enforcement gap, not a style nit. Add the missing entries (the scaffold seeds `eslint` plus the plugins the config imports), run `lint` clean, then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END implementer-lint-toolchain-gate -->

<!-- T1BLOCK:BEGIN implementer-lint-invocation-gate -->
Implementer lint gate: the root `package.json` "lint" script runs `{{SCRIPT}}`, which never invokes the per-package `lint` in {{MANIFESTS}}. A linter that is installed, scripted, and never run is not coverage — the compiled AST quality rules silently stop applying to those packages. Broadcast to every workspace member (`pnpm -r lint`, `turbo run lint` with no filter) or name each package in the filter, run it clean, then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END implementer-lint-invocation-gate -->

<!-- T1BLOCK:BEGIN reviewer-structure-gate -->
Reviewer gate: `APPROVED` is forbidden while the complete runtime structure report contains errors ({{FINDINGS}}). Review the compiled architecture and request fixes.
<!-- T1BLOCK:END reviewer-structure-gate -->

<!-- T1BLOCK:BEGIN finding-allowlist-gap -->
Finding-satisfiability gate: {{PATHS}} is named as work to do, but it is outside EVERY role's runtime-owned WorkUnitContract for run `{{RUN_ID}}`. The role you would hand this to cannot write it — the run-team gate denies the write with STRUCT_ASSIGNMENT_ALLOWLIST_GAP, and a fix cycle cannot replan, so the loop never closes. Do one of three things instead: point the finding at a path a role already owns; drop it; or record it explicitly as DEFERRED (or REPLAN) on the same line, with the reason, so the next run's ArchitectureInputV1 compiles a home for it. Never hand a role an instruction its allowlist forbids.
<!-- T1BLOCK:END finding-allowlist-gap -->

<!-- T1BLOCK:BEGIN tester-planned-module-gate -->
Tester completion gate: `TESTS_GREEN` is forbidden while a compiled test module the tester owns is missing ({{MISSING}}). The complete structure scan blocks the reviewer's `APPROVED` on the same finding, so writing this verdict now spends a fix cycle to discover it. Create the module, run it, then re-emit `TESTS_GREEN`.
<!-- T1BLOCK:END tester-planned-module-gate -->

<!-- T1BLOCK:BEGIN tester-qa-v2-gate -->
Tester completion gate: VerificationContractV2 rejected this verdict ({{ERROR}}). Dimensions: {{DIMENSIONS}}. Re-run only the failing dimension for uiImpact={{UI_IMPACT}}; a blocked environment is not `TESTS_GREEN`, and an `advisory-warning` is never the thing to fix. The sidecar is runtime evidence: produce it with the canonical runner — `node ~/.traffic-one/bin/qa-evidence-runner.cjs browser …` per the browser-qa skill, or `stack --run-id <id>` for no-browser contracts (the shim runs the plugin's `scripts/qa-evidence-runner.cjs`) — never by hand-editing `report-v2.json`. Hand-authoring it does not work: on a browser contract the runtime Playwright evidence is content-hashed against the report, and on a no-browser contract every excused check is cross-checked against the runner's own resolution record under `.traffic-one/runs/<id>/`, which is a runtime-owned sidecar no agent may write.
<!-- T1BLOCK:END tester-qa-v2-gate -->

<!-- T1BLOCK:BEGIN tester-no-test-evidence-disclosure -->
Tester completion gate: this run settled with NO TEST EVIDENCE and the digest does not say so. The QA runner excused {{EXCUSED}} because this project declares no such command — no manifest script and no pinned language default — so nothing was measured for it and nothing here says the code is covered. That is allowed to settle, and it is not allowed to settle quietly: a reader of this digest must not have to open `report-v2.json` to discover that the test dimension was skipped rather than passed. Add a line to this digest containing the token `NO_TEST_EVIDENCE` and naming what was not measured (for example: "NO_TEST_EVIDENCE — {{EXCUSED}} was excused: this project declares no test command, so no tests ran"), then re-emit `TESTS_GREEN`. Do not add a placeholder test script to silence this; a script that runs nothing is worse than the honest absence.
<!-- T1BLOCK:END tester-no-test-evidence-disclosure -->

<!-- T1BLOCK:BEGIN tester-stale-qa-gate -->
Tester completion gate: do not write `TESTS_GREEN` on a stale QA report. The report was generated at {{GENERATED_AT}} but `{{DIGEST}}` was re-emitted at {{DIGEST_AT}}. Re-run QA against the current implementation and write fresh evidence before re-emitting `TESTS_GREEN`.
<!-- T1BLOCK:END tester-stale-qa-gate -->

<!-- T1BLOCK:BEGIN tester-qa-build-identity-missing -->
Tester completion gate: do not write `TESTS_GREEN` when the report does not identify the build served over HTTP. Expected current builds: {{EXPECTED}}. Re-run `node ~/.traffic-one/bin/qa-evidence-runner.cjs` with `--build-dir` pointing at this run's output root. Do not start a preview server.
<!-- T1BLOCK:END tester-qa-build-identity-missing -->

<!-- T1BLOCK:BEGIN tester-qa-build-identity-mismatch -->
Tester completion gate: the QA sweep validated a different application. Expected {{EXPECTED}}, observed {{OBSERVED}}. Re-run `node ~/.traffic-one/bin/qa-evidence-runner.cjs` with `--build-dir` pointing at this run's output root. Do not start a preview server.
<!-- T1BLOCK:END tester-qa-build-identity-mismatch -->

<!-- T1BLOCK:BEGIN run-team-shell -->
Run-team enforcement gate: implementation writes via shell command (`>`, `>>`, `tee`, `cat <<`, `python -c`/`node -e` eval writes, `sed -i`, `rm`, `mv`, `cp`, `find -delete`) are denied because the hook cannot verify role ownership from a shell line — use the role-scoped Write/Edit tools instead. Run-state bookkeeping (heredocs targeting `.traffic-one/digests/`, `fix-cycles/`, or `runs/`) is exempt. Two shell shapes ARE verifiable and stay allowed: a single `cp`/`mv` importing one file from outside the project, and a single `rm <path>` (at most `-f`, never `-r`, no globs, one operand) removing a stray file that is present on disk, untracked, absent from the immutable baseline, and owned by nobody in the compiled contract — that is cleanup of your own by-product, not an implementation write.
<!-- T1BLOCK:END run-team-shell -->

<!-- T1BLOCK:BEGIN opencode-external-temp-shell -->
External-path gate: do not write scratch logs or build output under `/tmp`, `/private/tmp`, or `/var/tmp` from a model command. Those paths trigger host external-directory permission prompts and can stall the run. Write temporary diagnostics inside the project, for example `.traffic-one/tmp/<runId>/`, or print the output to stdout.
<!-- T1BLOCK:END opencode-external-temp-shell -->

<!-- T1BLOCK:BEGIN qa-trace-unzip -->
QA trace gate: do not extract Playwright `*.trace.zip` archives. Those files are failure-only runner diagnostics; unzipping them is not how you read the verdict. Read the summary fields on `.traffic-one/reports/qa/<runId>/report-v2.json` (`schemaVersion`, `runId`, `status`, `checks`, `gates`, `lighthouse.status` / `lighthouse.reason`, `blockerSummary`). Do not Read `lighthouse.raw.json`, screenshot PNGs, `graph.json`, or `GRAPH_REPORT.md`. Re-run the canonical QA runner if the evidence is insufficient.
<!-- T1BLOCK:END qa-trace-unzip -->

<!-- T1BLOCK:BEGIN local-mjs-path-deny -->
Local-module gate: do not write or execute `*.local.mjs` anywhere in the project. That suffix is a host-local probe file, not a compiled output, and running it bypasses the owned toolchain. Use a compiled test or the canonical QA runner instead.
<!-- T1BLOCK:END local-mjs-path-deny -->

<!-- T1BLOCK:BEGIN host-recursive-rm-prompt -->
Recursive-rm gate: this host prompts the user for `rm -rf` of build output (`dist`, `.next`, `supabase/.temp`). Do not run that from a model command — it stalls the run on an Allow dialog. Delete the tree from the host UI, or ask the user to remove it, then continue. `rm -rf node_modules` and `node_modules/.cache/…` stay allowed.
<!-- T1BLOCK:END host-recursive-rm-prompt -->

<!-- T1BLOCK:BEGIN codegraph-ignore-mutate -->
Code-graph ignore gate: do not create or delete `.gitnexusignore` or `.graphifyignore`. Those files are the user's scan-ignore surface (and the runtime's temporary scan scope). Leave an existing user file in place; do not invent one; do not remove one. Runtime `applyCodeGraphScanIgnore` owns the temporary scoped file.
<!-- T1BLOCK:END codegraph-ignore-mutate -->

<!-- T1BLOCK:BEGIN run-team-not-subagent -->
Run-team enforcement gate: this project was onboarded with `team.mode="subagents"`, so feature-source and assigned build-artifact writes must come from a spawned Traffic One role session with a per-agent run claim, not {{ROLE}}. {{RECOVERY}} Do NOT fall back to delegating from inside a worker or rewriting team preferences.
<!-- T1BLOCK:END run-team-not-subagent -->

<!-- T1BLOCK:BEGIN run-team-scope-conflict -->
Run-team enforcement gate: `{{TARGET}}` is in `{{OWNER}}`'s assigned scope for this run, not `{{ROLE}}`'s. Each subagent writes only within its runtime-compiled assignment in `.traffic-one/runs/<runId>/assignments.json`. Let the owning role write the target, or split the patch along the existing compiled work units.
<!-- T1BLOCK:END run-team-scope-conflict -->

<!-- T1BLOCK:BEGIN opencode-reserved-files -->
traffic-one — OpenCode reservation: `{{TARGET}}` is reserved by the RUNNING delegated unit `{{UNIT_ID}}` ({{UNIT_ROLE}}) in run `{{RUN_ID}}` — a paid write here would collide with the diff that unit is about to apply. Reserved for it: {{FILES}}. Work on your NON-reserved files now and come back to this path last; if it stays reserved when everything else is done, record the path and unit id under Open questions in your digest — the ORCHESTRATOR (not you) waits for or cancels the delegation. Bounded: the reservation clears the moment unit `{{UNIT_ID}}` ends (or its executor dies).
<!-- T1BLOCK:END opencode-reserved-files -->

<!-- T1BLOCK:BEGIN run-team-runtime-allowlist-gap -->
Run-team enforcement gate: STRUCT_ASSIGNMENT_ALLOWLIST_GAP — `{{TARGET}}` is outside `{{ROLE}}`'s immutable runtime-owned WorkUnitContract. No dynamic claim is allowed for a compiled run. Do NOT keep retrying this write, and do not move it to a path you do own. Report it in your digest instead: name `{{TARGET}}`, say it is in no role's allowlist, and set your verdict to `BLOCKED` (in a fix cycle, list it under `FIXES_FAILING` with this reason — that is the whole available action there, and it is a complete answer). Replanning ArchitectureInputV1 to compile a home for the path happens between runs, by the architect, never from inside this session.
<!-- T1BLOCK:END run-team-runtime-allowlist-gap -->

<!-- T1BLOCK:BEGIN run-team-fallback-taken -->
Run-team enforcement gate: `{{TARGET}}` is outside every runtime-compiled role scope and is already being written by `{{HOLDER}}` in this run. Coordinate so one existing work unit owns the path, or stop for semantic replanning and runtime regeneration of assignments before writing it.
<!-- T1BLOCK:END run-team-fallback-taken -->

<!-- T1BLOCK:BEGIN run-team-wrong-role -->
Run-team enforcement gate: the active Traffic One role `{{ROLE}}` does not own `{{TARGETS}}`. Use the role that owns the path, or split the patch by role ownership.
<!-- T1BLOCK:END run-team-wrong-role -->

<!-- T1BLOCK:BEGIN run-team-unexpected -->
Run-team enforcement gate: unexpected denial for {{ROLE}} writing `{{FILEPATH}}`. This is a gate bug — please report.
<!-- T1BLOCK:END run-team-unexpected -->

<!-- T1BLOCK:BEGIN run-team-quick-fix-contract -->
Run-team enforcement gate: the quick-fix worker has no valid parent-published WorkUnitContract covering every requested output. Not covered by one: `{{TARGETS}}`. No maintenance or fallback write is allowed without the exact original contract and allowlist hash, and you cannot publish or widen that contract yourself — only the parent can, so retrying this write draws the same refusal. Write only the outputs your own published contract already names; if it names none of these, stop and write your digest with verdict `BLOCKED` listing exactly these paths, so the orchestrator can re-run parent preflight with a bounded runtime-owned contract that covers them.
<!-- T1BLOCK:END run-team-quick-fix-contract -->

<!-- T1BLOCK:BEGIN run-team-runtime-contract-invalid -->
Run-team enforcement gate: this run has CompiledArchitectureV1 but its current-run runtime assignments or VerificationContractV2 are missing, stale, or tampered. The write fails closed; repair/recompile this run and never borrow an assignments manifest from a sibling run.
<!-- T1BLOCK:END run-team-runtime-contract-invalid -->

<!-- T1BLOCK:BEGIN run-id-mismatch -->
Run-id gate: this run's id (`currentRunId` in .traffic-one/.one.json) is `{{EXPECTED}}`, but this write targets run-id `{{WRONG}}`. The run-id is a plain epoch-millisecond number Traffic One mints for you — do NOT generate one with `date` (an ISO/UTC string like `2026-06-17T12-09-40Z` splits run state: assignments and digests land under a stray `.traffic-one/runs/{{WRONG}}/` that the run-team and OpenCode gates — keyed on `{{EXPECTED}}` — cannot see, blocking implementer spawns). Read `currentRunId` from .traffic-one/.one.json and write under `.traffic-one/runs/{{EXPECTED}}/` and `.traffic-one/digests/{{EXPECTED}}/` instead.
<!-- T1BLOCK:END run-id-mismatch -->

<!-- T1BLOCK:BEGIN pages-service-files -->
Route-page placement gate: `src/pages/` holds route components, and this write puts a `.service`/`.store`/`.hook`/`.query`/`.slice`/`.api` module inside it. Data access and state parked next to one route is the shape that later forces a second route to import across the pages tree, which is the coupling this layout exists to prevent. Re-issuing the same path draws the same refusal — the rule reads the path, so renaming the export or shrinking the file changes nothing. Write the module at `src/services/`, `src/features/<name>/`, or a `packages/*` workspace instead and import it from the page; if none of those is in your compiled allowlist, name this path in your digest with verdict `BLOCKED` so the architect can compile a home for it.
<!-- T1BLOCK:END pages-service-files -->

<!-- T1BLOCK:BEGIN expo-route-service-files -->
Expo Router placement gate: every file under `app/` is part of the route tree and must stay thin, and this write puts a `.service`/`.store`/`.hook`/`.query`/`.slice`/`.api` module there. Expo Router derives navigation from that directory, so a service module placed in it joins the route surface instead of staying a module the routes import. Re-issuing the same path draws the same refusal — the rule reads the `app/` path shape and not the project platform, so it fires on an `app/` directory in a web workspace too. Move the module to `src/features/<name>/`, `src/services/`, or a `packages/*` workspace and import it from the thin route file; if none of those is in your compiled allowlist, name this path in your digest with verdict `BLOCKED`.
<!-- T1BLOCK:END expo-route-service-files -->

<!-- T1BLOCK:BEGIN component-placement -->
Components must live in {{TARGET}} — not directly in src/.
<!-- T1BLOCK:END component-placement -->

<!-- T1BLOCK:BEGIN cross-feature-import -->
Cross-feature import detected ({{CURRENT}} -> {{CROSS}}). Share via packages/ui, packages/ui-native, packages/utils, or a feature-agnostic store slice.
<!-- T1BLOCK:END cross-feature-import -->

<!-- T1BLOCK:BEGIN deep-relative-package -->
Workspace import gate: this file reaches into another workspace package through a `../../../packages/…` relative path instead of importing that package by name. A deep relative path bypasses the package entry point, breaks the moment either side moves, and hides the dependency from the workspace resolver the build and the package graph read. Re-issuing the same import draws the same refusal — the rule reads the specifier, so adding or removing a `../` level does not satisfy it. Replace the specifier with the workspace package name (`@app/ui`, `@app/ui-native`, `@app/utils`) in this same file — the fix is an edit to the import line, never a relocation.
<!-- T1BLOCK:END deep-relative-package -->

<!-- T1BLOCK:BEGIN default-export -->
Use named exports only for reusable components — this file declares a default export, and the compiled feature entry `features/<name>/index.tsx` is a module entry rather than a route file, so it is covered too. A default export carries no name across the import boundary, so each consumer may spell it differently and a later rename never propagates to any of them. Re-issuing the file unchanged draws the same refusal — the rule reads the default-export declaration itself, so moving it down the file or wrapping it changes nothing. Route files — Expo Router files under `app/` and web page components under `src/pages/` — are the stated exception; everywhere else the fix is a one-token rename inside this same file plus the matching change at each import site, never a relocation.
<!-- T1BLOCK:END default-export -->

<!-- T1BLOCK:BEGIN native-inline-style -->
No inline object styles on React Native — this `.tsx` passes an inline style object, and NativeWind `className` is where a static style belongs on this stack. A style object literal is allocated again on every render and sits outside the class system the rest of the UI is themed through, so the same constant is restated per component instead of resolving to one utility. Re-issuing the file unchanged draws the same refusal — unlike the web rule, this one denies derived values too, so making a value computed does not satisfy it. Express the constant styles as a `className` string on the same element and keep `StyleSheet.create` for values that genuinely animate or are measured at runtime; both edits stay inside this same file.
<!-- T1BLOCK:END native-inline-style -->

<!-- T1BLOCK:BEGIN native-dom-tags -->
React Native has no DOM — this `.tsx` uses one of the `div`, `span`, `button`, `a`, or `input` tags, which the React Native renderer has no component for. The bundle still builds and typechecks, so this fails on the device at runtime rather than in any verification command this run will execute, which is why it is refused at write time. Re-issuing the file unchanged draws the same refusal — the rule matches the tag names in the source, so re-exporting them from a shim module does not satisfy it. Replace each one with its native primitive in this same file: `View` for `div`, `Text` for `span`, `Pressable` for `button` and `a`, and `TextInput` for `input`.
<!-- T1BLOCK:END native-dom-tags -->

<!-- T1BLOCK:BEGIN web-inline-style -->
No static inline styles — this `.tsx` passes an inline style object whose every value is a plain string or numeric literal, which is exactly what a Tailwind utility class already expresses. A constant inline style leaves the design tokens behind: it cannot be themed through the HSL CSS variables, it carries no breakpoint or dark-mode variant, and it outranks any class a consumer later tries to override it with. Re-issuing the file unchanged draws the same refusal — the rule inspects the values inside the object rather than the element or the file, so moving the same literal object elsewhere does not satisfy it. Convert those entries to `className` utilities, reaching for a shadcn primitive where one exists, in this same file; an inline style stays allowed for a value computed at runtime, so a genuinely derived width or transform may remain.
<!-- T1BLOCK:END web-inline-style -->

<!-- T1BLOCK:BEGIN vanilla-extract-import -->
vanilla-extract is no longer in the active stack — this file imports from the `@vanilla-extract` scope. The active stack styles with Tailwind and shadcn, so nothing installs that package or runs its build plugin, and the import has nothing to resolve to once the write lands. Re-issuing the file unchanged draws the same refusal — the rule reads the import specifier, so aliasing the package or importing it lazily does not satisfy it. Express the same styling with Tailwind utility classes and the shadcn primitives in `packages/ui/src/components/ui/`, editing the imports and the markup in this same file.
<!-- T1BLOCK:END vanilla-extract-import -->

<!-- T1BLOCK:BEGIN css-ts-import -->
`.css.ts` (vanilla-extract) imports are no longer permitted — this file imports a generated vanilla-extract stylesheet module. Those modules mean something only under the vanilla-extract build plugin this stack does not run, so without it the import resolves to plain TypeScript whose class names were never emitted into a stylesheet and the component renders unstyled instead of failing loudly. Re-issuing the file unchanged draws the same refusal — the rule reads the import specifier, so renaming the stylesheet module while keeping the import does not satisfy it. Replace the imported style references with Tailwind utility classes in this same file and theme them through the HSL CSS variables in `globals.css`.
<!-- T1BLOCK:END css-ts-import -->

<!-- T1BLOCK:BEGIN no-any -->
Avoid `any` — this non-test `.ts`/`.tsx` annotates a value with the `any` type, which turns off type checking for every downstream use of that value. An `any` spreads silently through assignments and return types, so the errors it hides surface later in a sibling role build instead of in your own, where they cost a fix cycle just to attribute. Re-issuing the file unchanged draws the same refusal — the rule reads the annotation, so widening it to an array of `any` or casting through it does not satisfy it. Replace the annotation with `unknown` plus a narrowing check, a precise interface, or a discriminated union in this same file; files in test scope are exempt, so a mock or fixture may keep its coarse typing.
<!-- T1BLOCK:END no-any -->

<!-- T1BLOCK:BEGIN websocket-location -->
WebSocket construction belongs to the transport layer — this file constructs a WebSocket outside `packages/ws-client/` and `src/services/ws/`. A socket opened next to the UI is created and abandoned with the component that opened it, so reconnect, backoff, and fan-out to other subscribers have nowhere to live and every remount opens another connection. Re-issuing the file unchanged draws the same refusal — the rule reads the constructor call together with the path, so wrapping the call in a local helper does not satisfy it. Move the connection into `packages/ws-client/` or `src/services/ws/` and subscribe to it from here through a hook; if neither path is in your compiled allowlist, name this file and the transport module you need in your digest with verdict `BLOCKED`.
<!-- T1BLOCK:END websocket-location -->

<!-- T1BLOCK:BEGIN asset-extension-mismatch -->
Asset gate: this write puts SVG/XML text into a bitmap image path such as `.png`, `.jpg`, `.webp`, or `.avif`. The bytes are markup rather than an encoded bitmap, so every consumer that decodes by extension — an image tag, an image pipeline, a favicon reader — reads a corrupt file, and no build or typecheck step in this run will report it. Re-issuing the same content draws the same refusal — the rule compares the extension against the leading bytes of the content, so reformatting or minifying the markup does not satisfy it. Save this content at a `.svg` path and update the references to it, or supply a real encoded bitmap for the bitmap path; this is a file-integrity check, so it holds on an existing codebase too.
<!-- T1BLOCK:END asset-extension-mismatch -->
