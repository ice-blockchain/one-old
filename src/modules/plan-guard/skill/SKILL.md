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
Plan gate: .traffic-one/plan.md is missing on this new project. You ARE the `senior-architect` for this run — write `.traffic-one/plan.md` (and the `.traffic-one/` project-memory baseline) BEFORE any feature-source file; do not spawn another architect. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README, empty `packages/*/src/index.ts` barrels, and the shared Tailwind globals baseline.
<!-- T1BLOCK:END plan-architect-self-gate -->

<!-- T1BLOCK:BEGIN architect-scaffold-gate -->
Architect completion gate: do not write `PLAN_READY` until the required Traffic One workspace scaffold exists. Missing: {{MISSING}}. Write the missing baseline files, then update `.traffic-one/digests/<runId>/architect.md` and only then emit `PLAN_READY`.
<!-- T1BLOCK:END architect-scaffold-gate -->

<!-- T1BLOCK:BEGIN architect-memory-baseline-gate -->
Architect completion gate: do not write `PLAN_READY` until the required `.traffic-one` project-memory baseline exists with real content. Missing or incomplete: {{MISSING}}. Write the missing memory files yourself (do not delegate `.traffic-one/*` to OpenCode), then update `.traffic-one/digests/<runId>/architect.md` and only then emit `PLAN_READY`.
<!-- T1BLOCK:END architect-memory-baseline-gate -->

<!-- T1BLOCK:BEGIN architect-pre-ready-feature -->
Architect scope gate: `senior-architect` may write only workspace scaffold, the shared Tailwind globals baseline, and empty `packages/*/src/index.ts` barrels before `PLAN_READY`. Finish the project-memory baseline, `.traffic-one/runs/<runId>/assignments.json`, and `.traffic-one/digests/<runId>/architect.md` with `PLAN_READY` before writing app or package implementation files such as `{{TARGET}}`.
<!-- T1BLOCK:END architect-pre-ready-feature -->

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
Architect completion gate: OpenCode queue metadata is unsafe: {{ERRORS}}. Add stable unique `id` fields, exact `files` allowlists, and `depends` edges for overlapping areas before emitting `PLAN_READY`.
<!-- T1BLOCK:END architect-opencode-queue-policy-gate -->

<!-- T1BLOCK:BEGIN plan-opencode-queue-policy-gate -->
Plan gate: OpenCode queue metadata is unsafe: {{ERRORS}}. Add stable unique `id` fields, exact `files` allowlists, and `depends` edges for overlapping areas.
<!-- T1BLOCK:END plan-opencode-queue-policy-gate -->

<!-- T1BLOCK:BEGIN scaffold-stack-gate -->
Stack gate: this project's stack is React/Vite (Traffic One does not use Next.js or create-react-app). Scaffold the app under `apps/web` with Vite per `.traffic-one/plan.md` and `rules/modes/new-project.md` — do not run create-next-app / create-react-app. See rules/core.md for the approved stack.
<!-- T1BLOCK:END scaffold-stack-gate -->

<!-- T1BLOCK:BEGIN scaffold-plan-gate -->
Plan gate: run the `senior-architect` subagent FIRST to produce `.traffic-one/plan.md` before scaffolding a new project. On Windsurf/Devin spawn it with `run_subagent` (profile `senior-architect`); it writes the `apps/web` Turborepo monorepo scaffold per the plan. Do not run `create-*` app scaffolders — build on the plan the architect produces.
<!-- T1BLOCK:END scaffold-plan-gate -->

<!-- T1BLOCK:BEGIN scaffold-main-agent-plan-gate -->
Plan gate: `.traffic-one/plan.md` is missing and this project is in Low/main-agent mode. Do NOT call `run_subagent` or another subagent tool. You are the architect in this thread: write the plan and required `.traffic-one/` project memory before root config or workspace scaffolding, then continue with the same ordered phases. Do not run `create-*` app scaffolders before the plan exists.
<!-- T1BLOCK:END scaffold-main-agent-plan-gate -->

<!-- T1BLOCK:BEGIN assignments-shape-gate -->
Assignments gate: `.traffic-one/runs/<runId>/assignments.json` must use the canonical shape with a top-level `assignments` ARRAY of `{ role, scope: { include, exclude? } }` entries — not a `roles` object or `ownedPaths` fields. Rewrite it as `{ "version": 1, "runId": "<currentRunId>", "assignments": [{ "role": "senior-frontend", "scope": { "include": ["apps/web/**", "packages/ui/**", "packages/i18n/**", "packages/tailwind-config/**"], "exclude": [] } }, { "role": "senior-backend", "scope": { "include": ["supabase/**", "packages/api-client/**"], "exclude": [] } }] }` and adjust paths to the real Module map.
<!-- T1BLOCK:END assignments-shape-gate -->

<!-- T1BLOCK:BEGIN assignments-roles-gate -->
Assignments gate: {{ERRORS}}.
<!-- T1BLOCK:END assignments-roles-gate -->

<!-- T1BLOCK:BEGIN assignments-owner-gate -->
Assignments gate: `.traffic-one/runs/<runId>/assignments.json` is architect/orchestrator-owned and must not be changed by `{{ROLE}}` after `PLAN_READY`. Surface the needed scope change in the role digest instead.
<!-- T1BLOCK:END assignments-owner-gate -->

<!-- T1BLOCK:BEGIN run-team-shell -->
Run-team enforcement gate: implementation writes via shell command (`>`, `>>`, `tee`, `cat <<`, `python -c`/`node -e` eval writes, `sed -i`, `rm`, `mv`, `cp`, `find -delete`) are denied because the hook cannot verify role ownership from a shell line — use the role-scoped Write/Edit tools instead. Run-state bookkeeping (heredocs targeting `.traffic-one/digests/`, `fix-cycles/`, or `runs/`) is exempt.
<!-- T1BLOCK:END run-team-shell -->

<!-- T1BLOCK:BEGIN opencode-external-temp-shell -->
OpenCode/Kilo external-path gate: do not write scratch logs or build output under `/tmp`, `/private/tmp`, or `/var/tmp` from a model command. Those paths trigger host external-directory permission prompts and can stall the run. Write temporary diagnostics inside the project, for example `.traffic-one/tmp/<runId>/`, or print the output to stdout.
<!-- T1BLOCK:END opencode-external-temp-shell -->

<!-- T1BLOCK:BEGIN run-team-not-subagent -->
Run-team enforcement gate: this project was onboarded with `team.mode="subagents"`, so feature-source and assigned build-artifact writes must come from a spawned Traffic One role session with a per-agent run claim, not {{ROLE}}. {{RECOVERY}} Do NOT fall back to delegating from inside a worker or rewriting team preferences.
<!-- T1BLOCK:END run-team-not-subagent -->

<!-- T1BLOCK:BEGIN run-team-not-owned -->
Run-team enforcement gate: the file `{{FILEPATH}}` is not under any Traffic One role's owned path patterns (senior-frontend: flat root UI/SEO/i18n paths, `apps/*/src|app/`, and `packages/(ui|i18n|utils)/src/`; senior-backend: flat root API/server/service paths, `packages/(api-client|ws-client|utils)/src/`, `services/*/src/`, `apps/*/src/(services|store)/`). If this is a legitimate project layout, the role-pattern definitions in `roleCanWriteFeatureSource` need to be extended.
<!-- T1BLOCK:END run-team-not-owned -->

<!-- T1BLOCK:BEGIN run-team-scope-conflict -->
Run-team enforcement gate: `{{TARGET}}` is in `{{OWNER}}`'s assigned scope for this run, not `{{ROLE}}`'s. Each subagent writes only within its own assignment in `.traffic-one/runs/<runId>/assignments.json`. Let the owning role write this file, or split the patch by assignment.
<!-- T1BLOCK:END run-team-scope-conflict -->

<!-- T1BLOCK:BEGIN run-team-fallback-taken -->
Run-team enforcement gate: `{{TARGET}}` is outside every role's assigned scope and is already being written by `{{HOLDER}}` in this run. Coordinate so a single role owns this path, or add it to an assignment in `.traffic-one/runs/<runId>/assignments.json`.
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
Use named exports only for reusable components. Expo Router route files under app/ are the default-export exception.
<!-- T1BLOCK:END default-export -->

<!-- T1BLOCK:BEGIN native-inline-style -->
No inline object styles — use NativeWind `className` for static styles. `StyleSheet.create` is reserved for dynamic/animated values.
<!-- T1BLOCK:END native-inline-style -->

<!-- T1BLOCK:BEGIN native-dom-tags -->
React Native UI must use native primitives (`View`, `Text`, `Pressable`, `TextInput`, etc.), not DOM tags.
<!-- T1BLOCK:END native-dom-tags -->

<!-- T1BLOCK:BEGIN web-inline-style -->
No inline styles — use Tailwind utility `className` and shadcn primitives. Inline `style={{}}` is reserved for dynamic/derived values.
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
