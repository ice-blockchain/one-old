---
name: traffic-one-plan-guard
description: Wording source for the Traffic One plan-write gate deny reasons. Read at runtime via skillBlock(); the deny conditions live in TS.
---

# Traffic One Plan Guard

Deny-reason wording for the PreToolUse file-write/file-edit plan gate.
Enforcement (the actual conditions + `permissionDecision:"deny"`) lives in
`src/modules/plan-guard/`. `{{PLACEHOLDER}}` tokens are filled by the gate.
Each block has a verbatim fallback in code, so a missing block never disables a gate.

<!-- T1BLOCK:BEGIN monorepo-package-json -->
New-project monorepo gate: stack=default / React-Vite new projects must start with the Traffic One Turborepo root package.json: `private: true`, `packageManager: pnpm@...`, and a workspace declaration (`pnpm-workspace.yaml` or package.json `workspaces`) for `apps/*` and `packages/*`. Read `rules/modes/new-project.md` and scaffold the monorepo before feature code.
<!-- T1BLOCK:END monorepo-package-json -->

<!-- T1BLOCK:BEGIN monorepo-root-vite -->
New-project monorepo gate: root Vite app files are not allowed for this stack. Use `apps/web/` for the React app and create the required `packages/*` workspaces first; see `rules/modes/new-project.md`.
<!-- T1BLOCK:END monorepo-root-vite -->

<!-- T1BLOCK:BEGIN state-gate -->
State gate: root .traffic-one/.one.json is missing or incomplete. Write the Traffic One state file with mode, stack, backend, realtime, confirmed, onboardingComplete, and confirmedAt before writing feature source. The .traffic-one/ folder is project memory, not the stack-selection state file.
<!-- T1BLOCK:END state-gate -->

<!-- T1BLOCK:BEGIN materialization-gate -->
Materialization gate: stack context for {{FINGERPRINT}} has not been materialized on disk yet. Run `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}}/scripts/hook-runtime.cjs" materialize-project` from the project root and verify `.traffic-one/rules/**`, `.traffic-one/skills/**`, `.traffic-one/manifest.json`, root `AGENTS.md`, and root `CLAUDE.md` exist before writing feature source.
<!-- T1BLOCK:END materialization-gate -->

<!-- T1BLOCK:BEGIN plan-gate -->
Plan gate: .traffic-one/plan.md is missing on a new project. Run the `senior-architect` subagent (or the `senior-eng-orchestrator` skill) to produce the plan before writing feature source files. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.
<!-- T1BLOCK:END plan-gate -->

<!-- T1BLOCK:BEGIN architect-scaffold-gate -->
Architect completion gate: do not write `PLAN_READY` until the required Traffic One workspace scaffold exists. Missing: {{MISSING}}. Write the missing baseline files, then update `.traffic-one/digests/<runId>/architect.md` and only then emit `PLAN_READY`.
<!-- T1BLOCK:END architect-scaffold-gate -->

<!-- T1BLOCK:BEGIN run-team-shell -->
Run-team enforcement gate: feature-source writes via shell command (`>`, `>>`, `tee`, `cat <<`, `python`, `node`, `perl`, `sed -i`) are denied because the hook cannot verify role ownership from a shell line — use the role-scoped Write/Edit tools instead.
<!-- T1BLOCK:END run-team-shell -->

<!-- T1BLOCK:BEGIN run-team-not-subagent -->
Run-team enforcement gate: this project was onboarded with `team.mode="subagents"`, so feature-source and assigned build-artifact writes must come from a spawned Traffic One role session with a per-agent run claim, not {{ROLE}}. If you are the PARENT/orchestrator: do not edit owned implementation artifacts yourself — spawn (or message) the owning role. If you ARE a spawned role session whose claim did not resolve: state your role explicitly (reply or note "Traffic One senior-<role> role, run <runId>") and retry this same edit — the gate re-reads your transcript and stakes the claim on the next attempt. Do NOT fall back to delegating from inside a worker or rewriting team preferences.
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
