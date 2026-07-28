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
Architect completion gate: OpenCode is enabled but the plan is missing at least 3 runnable machine-readable delegation units. Include `<!-- opencode-delegate:start -->` … `<!-- opencode-delegate:end -->` with 3–6 bounded units (`- role: … | files: … | task: …`) in `.traffic-one/plan.md` before emitting `PLAN_READY`. The orchestrator runs `opencode_delegate_from_plan` from that block BEFORE spawning implementers.
<!-- T1BLOCK:END architect-opencode-queue-gate -->

<!-- T1BLOCK:BEGIN architect-opencode-self-delegation-gate -->
Architect completion gate: this run is already hosted by OpenCode/Kilo, so `.traffic-one/plan.md` must not include an OpenCode delegation queue or `opencode-delegate` marker. Remove the self-delegation block before emitting `PLAN_READY`; implementer work runs directly on the current host.
<!-- T1BLOCK:END architect-opencode-self-delegation-gate -->

<!-- T1BLOCK:BEGIN plan-opencode-queue-gate -->
Plan gate: OpenCode is enabled — `.traffic-one/plan.md` must include the machine-readable `<!-- opencode-delegate:start -->` … `<!-- opencode-delegate:end -->` block with at least 3 runnable bounded units (`- role: frontend|backend|tester|docs | files: … | task: …`). Prose-only or incomplete OpenCode lists are ignored by `opencode_delegate_from_plan`.
<!-- T1BLOCK:END plan-opencode-queue-gate -->

<!-- T1BLOCK:BEGIN plan-opencode-self-delegation-gate -->
Plan gate: this run is already hosted by OpenCode/Kilo, so `.traffic-one/plan.md` must not include an OpenCode delegation queue or `opencode-delegate` marker. Remove the self-delegation block; implementer work runs directly on the current host.
<!-- T1BLOCK:END plan-opencode-self-delegation-gate -->

<!-- T1BLOCK:BEGIN architect-opencode-queue-policy-gate -->
Architect completion gate: OpenCode queue metadata is unsafe: {{ERRORS}}. Fix the queue block in `.traffic-one/plan.md` (stable unique ids, parseable `files:`, explicit `depends:` edges for overlaps) and re-emit `PLAN_READY`. Do not guess compiled paths: file-vs-assignment scope is enforced at Step-0 delegation, where out-of-scope units are rejected pre-model and fall back to paid implementers.
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

<!-- T1BLOCK:BEGIN architecture-input-gate -->
Architecture input gate: ArchitectureInputV1 may contain only semantic routes, modules, and narrow exception requests. Runtime owns profiles, roots, roles, limits, output paths, and the baseline. Fix: {{ERRORS}}.
<!-- T1BLOCK:END architecture-input-gate -->

<!-- T1BLOCK:BEGIN architecture-input-shell-unverified -->
Architecture input gate: this shell command references `{{TARGET}}` but its write payload cannot be reconstructed for validation, and the current on-disk file is not valid ArchitectureInputV1 ({{ERRORS}}). Read-only checks pass once the on-disk file is valid; to (re)write it, use the role-scoped Write/Edit tools with the complete semantic JSON instead of shell eval.
<!-- T1BLOCK:END architecture-input-shell-unverified -->

<!-- T1BLOCK:BEGIN architecture-assignment-gate -->
Architecture assignment gate: the runtime-compiled outputs are not covered before spawn. {{ERRORS}}. Amend semantic ArchitectureInputV1 and re-run PLAN_READY compilation; never edit or widen runtime-owned assignments.
<!-- T1BLOCK:END architecture-assignment-gate -->

<!-- T1BLOCK:BEGIN architecture-contract-gate -->
Architecture contract gate: do not emit `PLAN_READY` until the run's `architecture-input-v1.json` is valid and runtime compilation succeeds. {{ERROR}}. The architect may change only semantic routes/modules/exceptions; runtime owns roots, roles, outputs, baseline, and hashes.
<!-- T1BLOCK:END architecture-contract-gate -->

<!-- T1BLOCK:BEGIN verification-contract-scan-gate -->
Verification contract gate: STRUCT_SCAN_INCOMPLETE ({{ERROR}}). Runtime could not derive the complete diff from the immutable baseline, so `PLAN_READY` is forbidden.
<!-- T1BLOCK:END verification-contract-scan-gate -->

<!-- T1BLOCK:BEGIN verification-contract-refresh-gate -->
Verification refresh gate: `IMPLEMENTED` is forbidden because runtime could not rederive and atomically republish VerificationContractV2 from the immutable baseline ({{ERROR}}). Repair the semantic plan or runtime prerequisite and retry the same digest; stale UI-impact requirements never reach QA.
<!-- T1BLOCK:END verification-contract-refresh-gate -->

<!-- T1BLOCK:BEGIN bootstrap-publication-gate -->
Bootstrap gate: the parent could not atomically refresh the role/rule/skill and work-unit envelopes against the compiled architecture and verification contracts. No implementer may spawn until the immutable envelopes are published.
<!-- T1BLOCK:END bootstrap-publication-gate -->

<!-- T1BLOCK:BEGIN frontend-structure-hot-gate -->
Structural gate: {{FINDINGS}}. Entrypoints may only bootstrap the app; route pages must be separate compiled modules. Formatting the same monolith across more lines does not satisfy this gate.
<!-- T1BLOCK:END frontend-structure-hot-gate -->

<!-- T1BLOCK:BEGIN frontend-structure-scan-incomplete -->
Frontend completion gate: STRUCT_SCAN_INCOMPLETE after {{SCANNED}} product source files. A truncated scan is never a pass; narrow generated/output roots or split the project contract before re-emitting `IMPLEMENTED`.
<!-- T1BLOCK:END frontend-structure-scan-incomplete -->

<!-- T1BLOCK:BEGIN frontend-collapse-gate -->
Frontend completion gate: do not write `IMPLEMENTED` with collapsed source. `{{FILE}}` packs an entire component/route onto one line. Collapsed or minified product source is a defect even when build and typecheck pass. Format it and split routes, pages, features, and shared components according to the compiled architecture before re-emitting `IMPLEMENTED`.
<!-- T1BLOCK:END frontend-collapse-gate -->

<!-- T1BLOCK:BEGIN frontend-emit-config-gate -->
Frontend completion gate: {{PROBLEMS}}. The stock Vite template emits compiled `.js`/`.d.ts` next to every source on the first build, and the stale output can shadow the module at import time. Fix exactly this: set `"noEmit": true` in the app tsconfig, remove `"composite": true`, and use `"build": "tsc --noEmit && vite build"`, `"typecheck": "tsc --noEmit"`. Then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END frontend-emit-config-gate -->

<!-- T1BLOCK:BEGIN frontend-format-parity-gate -->
Frontend completion gate: {{CONFIG}} exists but `prettier` is not declared in the root package.json dependencies/devDependencies. A script or config that names an absent tool makes later verification meaningless. Run exactly `pnpm add -D -w prettier` (or add `"prettier"` to the root devDependencies), then re-emit `IMPLEMENTED`.
<!-- T1BLOCK:END frontend-format-parity-gate -->

<!-- T1BLOCK:BEGIN frontend-structure-completion-gate -->
Frontend completion gate: the runtime structure report failed ({{FINDINGS}}). Fix every blocking finding and re-run the complete scan before writing `IMPLEMENTED`. Numeric LOC/function-count/component-count findings remain warnings during this rollout.
<!-- T1BLOCK:END frontend-structure-completion-gate -->

<!-- T1BLOCK:BEGIN reviewer-structure-gate -->
Reviewer gate: `APPROVED` is forbidden while the complete runtime structure report contains errors ({{FINDINGS}}). Review the compiled architecture and request fixes.
<!-- T1BLOCK:END reviewer-structure-gate -->

<!-- T1BLOCK:BEGIN tester-qa-v2-gate -->
Tester completion gate: VerificationContractV2 rejected this verdict ({{ERROR}}). Produce fresh risk-proportional evidence; a blocked environment is not `TESTS_GREEN`.
<!-- T1BLOCK:END tester-qa-v2-gate -->

<!-- T1BLOCK:BEGIN tester-stale-qa-gate -->
Tester completion gate: do not write `TESTS_GREEN` on a stale QA report. The report was generated at {{GENERATED_AT}} but `{{DIGEST}}` was re-emitted at {{DIGEST_AT}}. Re-run QA against the current implementation and write fresh evidence before re-emitting `TESTS_GREEN`.
<!-- T1BLOCK:END tester-stale-qa-gate -->

<!-- T1BLOCK:BEGIN tester-qa-build-identity-missing -->
Tester completion gate: do not write `TESTS_GREEN` when the report does not identify the build served over HTTP. Expected current builds: {{EXPECTED}}. Start the preview on a free strict port owned by this run, record the served fingerprint, and re-run the sweep.
<!-- T1BLOCK:END tester-qa-build-identity-missing -->

<!-- T1BLOCK:BEGIN tester-qa-build-identity-mismatch -->
Tester completion gate: the QA sweep validated a different application. Expected {{EXPECTED}}, observed {{OBSERVED}}. Stop the foreign server or bind a free strict port, then re-run before emitting `TESTS_GREEN`.
<!-- T1BLOCK:END tester-qa-build-identity-mismatch -->

<!-- T1BLOCK:BEGIN run-team-shell -->
Run-team enforcement gate: implementation writes via shell command (`>`, `>>`, `tee`, `cat <<`, `python -c`/`node -e` eval writes, `sed -i`, `rm`, `mv`, `cp`, `find -delete`) are denied because the hook cannot verify role ownership from a shell line — use the role-scoped Write/Edit tools instead. Run-state bookkeeping (heredocs targeting `.traffic-one/digests/`, `fix-cycles/`, or `runs/`) is exempt.
<!-- T1BLOCK:END run-team-shell -->

<!-- T1BLOCK:BEGIN opencode-external-temp-shell -->
OpenCode/Kilo external-path gate: do not write scratch logs or build output under `/tmp`, `/private/tmp`, or `/var/tmp` from a model command. Those paths trigger host external-directory permission prompts and can stall the run. Write temporary diagnostics inside the project, for example `.traffic-one/tmp/<runId>/`, or print the output to stdout.
<!-- T1BLOCK:END opencode-external-temp-shell -->

<!-- T1BLOCK:BEGIN run-team-not-subagent -->
Run-team enforcement gate: this project was onboarded with `team.mode="subagents"`, so feature-source and assigned build-artifact writes must come from a spawned Traffic One role session with a per-agent run claim, not {{ROLE}}. {{RECOVERY}} Do NOT fall back to delegating from inside a worker or rewriting team preferences.
<!-- T1BLOCK:END run-team-not-subagent -->

<!-- T1BLOCK:BEGIN run-team-scope-conflict -->
Run-team enforcement gate: `{{TARGET}}` is in `{{OWNER}}`'s assigned scope for this run, not `{{ROLE}}`'s. Each subagent writes only within its runtime-compiled assignment in `.traffic-one/runs/<runId>/assignments.json`. Let the owning role write the target, or split the patch along the existing compiled work units.
<!-- T1BLOCK:END run-team-scope-conflict -->

<!-- T1BLOCK:BEGIN run-team-fallback-taken -->
Run-team enforcement gate: `{{TARGET}}` is outside every runtime-compiled role scope and is already being written by `{{HOLDER}}` in this run. Coordinate so one existing work unit owns the path, or stop for semantic replanning and runtime regeneration of assignments before writing it.
<!-- T1BLOCK:END run-team-fallback-taken -->

<!-- T1BLOCK:BEGIN run-team-wrong-role -->
Run-team enforcement gate: the active Traffic One role `{{ROLE}}` does not own `{{TARGETS}}`. Use the role that owns the path, or split the patch by role ownership.
<!-- T1BLOCK:END run-team-wrong-role -->

<!-- T1BLOCK:BEGIN run-team-unexpected -->
Run-team enforcement gate: unexpected denial for {{ROLE}} writing `{{FILEPATH}}`. This is a gate bug — please report.
<!-- T1BLOCK:END run-team-unexpected -->

<!-- T1BLOCK:BEGIN run-team-suffix -->
If subagents are genuinely unavailable or the user changes their mind, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before rewriting local Traffic One preferences; `team.source="unavailable"` does not bypass `team.mode="subagents"`.
<!-- T1BLOCK:END run-team-suffix -->

<!-- T1BLOCK:BEGIN pages-service-files -->
Service/store/hook/slice files belong in src/services/, src/features/<name>/, or packages/* — not in src/pages/.
<!-- T1BLOCK:END pages-service-files -->

<!-- T1BLOCK:BEGIN expo-route-service-files -->
Expo Router route files must stay thin. Service/store/hook/slice files belong in src/features/, src/services/, or packages/*.
<!-- T1BLOCK:END expo-route-service-files -->

<!-- T1BLOCK:BEGIN component-placement -->
Components must live in {{TARGET}} — not directly in src/.
<!-- T1BLOCK:END component-placement -->

<!-- T1BLOCK:BEGIN cross-feature-import -->
Cross-feature import detected ({{CURRENT}} -> {{CROSS}}). Share via packages/ui, packages/ui-native, packages/utils, or a feature-agnostic store slice.
<!-- T1BLOCK:END cross-feature-import -->

<!-- T1BLOCK:BEGIN deep-relative-package -->
Use the workspace package name (`@app/ui`, `@app/ui-native`, `@app/utils`) instead of a deep relative path across packages.
<!-- T1BLOCK:END deep-relative-package -->

<!-- T1BLOCK:BEGIN default-export -->
Use named exports only for reusable components. Route files — Expo Router files under app/ and web page components under src/pages/ — are the default-export exception.
<!-- T1BLOCK:END default-export -->

<!-- T1BLOCK:BEGIN native-inline-style -->
No inline object styles — use NativeWind `className` for static styles. `StyleSheet.create` is reserved for dynamic/animated values.
<!-- T1BLOCK:END native-inline-style -->

<!-- T1BLOCK:BEGIN native-dom-tags -->
React Native UI must use native primitives (`View`, `Text`, `Pressable`, `TextInput`, etc.), not DOM tags.
<!-- T1BLOCK:END native-dom-tags -->

<!-- T1BLOCK:BEGIN web-inline-style -->
No static inline styles — use Tailwind utility `className` and shadcn primitives. Inline `style={{}}` is allowed only when a value is dynamic/derived (computed at runtime), never for constant values.
<!-- T1BLOCK:END web-inline-style -->

<!-- T1BLOCK:BEGIN vanilla-extract-import -->
vanilla-extract is no longer in the active stack. Use Tailwind utility classes and shadcn primitives in `packages/ui/src/components/ui/`.
<!-- T1BLOCK:END vanilla-extract-import -->

<!-- T1BLOCK:BEGIN css-ts-import -->
`.css.ts` (vanilla-extract) imports are no longer permitted. Use Tailwind utility classes; theme via the HSL CSS variables in `globals.css`.
<!-- T1BLOCK:END css-ts-import -->

<!-- T1BLOCK:BEGIN no-any -->
Avoid `any` — use `unknown` and narrow types, or define a discriminated union.
<!-- T1BLOCK:END no-any -->

<!-- T1BLOCK:BEGIN websocket-location -->
Open WebSocket connections only inside packages/ws-client/ or src/services/ws/. Components must subscribe via hooks.
<!-- T1BLOCK:END websocket-location -->

<!-- T1BLOCK:BEGIN asset-extension-mismatch -->
Asset gate: do not write SVG/XML text into a bitmap image path such as `.png`, `.jpg`, `.webp`, or `.avif`. Save SVG content with a `.svg` extension, or generate/provide a real bitmap asset for bitmap extensions.
<!-- T1BLOCK:END asset-extension-mismatch -->
