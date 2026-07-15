---
name: traffic-one-onboarding-gate
description: Wording source for the Traffic One setup gate. The onboarding questions now live in the local wizard server (shared/onboarding-server), so this only holds the gate's agent-facing prose — the wizard-URL deny, the short "setup pending" note, the team-mode write guards, the post-materialization re-run note, and the post-build maintenance-triage directives. Read at runtime via skillBlock(); the routing + deny LOGIC lives in TS.
---

# Traffic One Onboarding Gate

Directive PROSE for the onboarding gate. The questions themselves moved into the
local setup wizard (`src/shared/onboarding-server` + `src/runners/onboarding-server`),
which the gate launches and points the user at — so this file only carries the
gate's agent-facing messages, not the questions. `{{PLACEHOLDER}}` tokens are filled
by the gate, and each block has a verbatim fallback in code, so a missing block
never disables the gate.

<!-- T1BLOCK:BEGIN server-bootstrap-required -->
Traffic One setup could not start inside this host's restricted hook sandbox ({{ERROR_CODE}}). Private preferences MUST remain in `~/.traffic-one/projects`; do not create `preferences.json`, `machine.json`, or onboarding runtime files inside the project.

Do not search for a wizard tool, claim the preview is already open, or end the turn. Your NEXT action is to run this exact bootstrap command with the required approval:

{{BOOTSTRAP_CMD}}

{{HOST_PERMISSION_STEP}}

The bootstrap prints `TRAFFIC_ONE_SETUP_READY` and a live `Setup link:`, then exits. Show that URL to the user as a standalone clickable link (or open it in the host's in-app web view). Immediately afterward run this normal waiter and keep the turn active:

{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, close the setup view and immediately continue the original request. If it prints `TRAFFIC_ONE_SETUP_PENDING`, run the exact same waiter again. Building, installs, and subagent work remain blocked until completion.
<!-- T1BLOCK:END server-bootstrap-required -->

<!-- T1BLOCK:BEGIN server-bootstrap-required-compact -->
Traffic One setup needs approved access to its user-local state at `~/.traffic-one/projects` ({{ERROR_CODE}}).

Run with approval: {{BOOTSTRAP_CMD}}

It prints the live setup link and exits. Show that link, then keep setup active with:
{{WAIT_CMD}}

Building remains blocked until the waiter reports completion.
<!-- T1BLOCK:END server-bootstrap-required-compact -->

<!-- T1BLOCK:BEGIN server-deny-reason -->
Traffic One setup is required before building in this project. Setup now happens on the
Traffic One dashboard in the user's web browser — they sign in or create an account,
then finish a few setup steps. Your job is to SURFACE THE LINK to the user and then
wait. Do NOT try to answer the setup questions yourself, and do NOT create or edit
.claude/launch.json.

Present this clickable setup link to the user as your FIRST visible action, before any
wait command — put it on its own line, not buried in a terminal block:

    Open Traffic One setup: {{URL}}

The link opens in the user's browser. If the browser can reach the local setup helper
running on this machine, setup completes on the dashboard; if a browser blocks that
(e.g. Safari), the page automatically falls back to a local setup page — either way the
user finishes in the browser. All setup logic and saves stay on this machine; the
dashboard is just the UI.

CONTINUE AUTOMATICALLY — do NOT end your turn after showing the link. Immediately run
this command and keep your turn open; it BLOCKS until the user finishes setup (run it
with a long timeout, ~9 minutes / 540000 ms):

{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, IMMEDIATELY continue the user's original
request and build it end to end — do not stop to ask "what next?". If it prints
`TRAFFIC_ONE_SETUP_PENDING` (it timed out before setup finished), run the exact same
command again; after a couple of pending rounds with no progress, tell the user to
finish setup and wait for their go-ahead. (If you genuinely cannot run a shell command,
fall back to: when the user says setup is done, continue the request.)

Read-only orientation (pwd, ls, reading files, searching) and the wait command above
are allowed now, but feature writes, installs, and subagent work stay blocked until
setup completes. Do NOT restart the host and do NOT answer these setup questions
yourself in chat — setup happens in the browser.

Don't use Traffic One: if the user says they don't want Traffic One for this
project, run this command instead — it saves their choice outside the project (no
files are added to it) and Traffic One stays silent here until they ask for it again:

{{DECLINE_CMD}}
<!-- T1BLOCK:END server-deny-reason -->

<!-- T1BLOCK:BEGIN cursor-wait-link-first -->
Open Traffic One setup: {{URL}}

The setup link was not shown in chat before the wait command, so Traffic One stopped this first wait attempt to surface the clickable URL. Now re-run the wait command and keep the turn open:

{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, continue the original request.
<!-- T1BLOCK:END cursor-wait-link-first -->

<!-- T1BLOCK:BEGIN server-deny-reason-repeat -->
Traffic One setup is still pending — building stays blocked until setup finishes.
Open Traffic One setup in the browser: {{URL}}
Keep your turn open by running the wait command again (long timeout, ~9 minutes):

{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, IMMEDIATELY continue the user's original
request. Full instructions were given on the first denial this session.
Don't use Traffic One: if the user says they don't want it for this project, run:
{{DECLINE_CMD}}
<!-- T1BLOCK:END server-deny-reason-repeat -->

<!-- T1BLOCK:BEGIN windsurf-server-deny-reason -->
Traffic One setup is required before building.

Before running any tool, show the user this standalone clickable setup link:
[Open Traffic One setup]({{URL}})

Keep the current turn active by running this wait command (timeout ~9 minutes):
{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, immediately continue the original request.
<!-- T1BLOCK:END windsurf-server-deny-reason -->

<!-- T1BLOCK:BEGIN windsurf-server-deny-reason-repeat -->
Traffic One setup is still pending.

Before running any tool, show the user this standalone clickable setup link:
[Open Traffic One setup]({{URL}})

Keep the current turn active by running this wait command:
{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, continue the original request.
<!-- T1BLOCK:END windsurf-server-deny-reason-repeat -->

<!-- T1BLOCK:BEGIN setup-pending -->
Traffic One needs a quick setup before it can build in this project. When you start
a coding task, Traffic One gives you a link to the Traffic One dashboard — the user
opens it in their browser, signs in, and finishes a few setup steps there (all logic
and saves stay on this machine). Share that link with the user when it appears.

Until then only read-only orientation is in effect: do not scaffold, install, or
write feature code, do not invoke build/design skills, and do NOT try to ask these
setup questions yourself in chat — setup happens in the browser. Do not tell the user
to restart the host. The durable per-project `pluginUse` question is asked before
the wizard opens; if the user declines there, Traffic One remains silent for this
project until they explicitly ask to enable it again.
<!-- T1BLOCK:END setup-pending -->

<!-- T1BLOCK:BEGIN repaired-materialization -->
Traffic One state was repaired/materialized before this tool use.
The attempted mutating tool has been denied once so it cannot run against stale `.traffic-one/.one.json`, rules, skills, or root agent context.
rerun the same tool now; the canonical `.traffic-one/.one.json` and project-local materialization are current.
<!-- T1BLOCK:END repaired-materialization -->

<!-- T1BLOCK:BEGIN kilo-opencode-spawn-first -->
[traffic-one] {{HOST}} build start — `team.mode="subagents"` is ACTIVE and `.traffic-one/plan.md` is still missing. You are the PARENT/orchestrator.

DO NOT write feature source, scaffold app files, or run package installs yourself in this thread.
Your FIRST action: spawn `senior-architect` via the host `{{TASK_TOOL}}` tool:
- `subagent_type: "{{SUBAGENT_TYPE}}"` — {{SPAWN_RULE}}
- prompt line 1 MUST be: `[t1-role: senior-architect]`
- {{ROLE_CONTRACT_INSTRUCTION}}
- include `Run ID: {{RUN_ID}}` and the user's original request
- omit `model` on {{HOST}} unless the host documents a subagent model parameter

This stack uses a Turborepo monorepo (`apps/web/`, `packages/*`) — do NOT create root `src/`, root `tsconfig*.json`, or a flat Vite app at the project root.

After architect emits `PLAN_READY`, spawn `senior-frontend` and `senior-backend` in parallel using the same {{HOST}} spawn rule, each role marker, and its matching role-contract instruction. Read `.traffic-one/rules/common/senior-engineer-team.md` before the first spawn.
<!-- T1BLOCK:END kilo-opencode-spawn-first -->

<!-- T1BLOCK:BEGIN kilo-opencode-architect-incomplete -->
[traffic-one] {{HOST}} build — `.traffic-one/plan.md` exists but the architect phase is INCOMPLETE. You are the PARENT/orchestrator.

DO NOT spawn `senior-frontend` or `senior-backend` yet. DO NOT patch `assignments.json` or `digests/{{RUN_ID}}/architect.md` yourself unless the user explicitly opts out of subagents.

Missing architect deliverables: {{MISSING}}

Respawn `senior-architect` via `{{TASK_TOOL}}` with:
- `subagent_type: "{{SUBAGENT_TYPE}}"` — {{SPAWN_RULE}}
- prompt line 1: `[t1-role: senior-architect]`
- {{ROLE_CONTRACT_INSTRUCTION}}
- `Run ID: {{RUN_ID}}`
- instruct the architect to finish the missing files, write `.traffic-one/runs/{{RUN_ID}}/assignments.json`, then `.traffic-one/digests/{{RUN_ID}}/architect.md` with `PLAN_READY`

Implementer spawns are blocked until the digest carries `PLAN_READY` on disk.
<!-- T1BLOCK:END kilo-opencode-architect-incomplete -->

<!-- T1BLOCK:BEGIN team-mode-marker-guard -->
Traffic One team mode guard: `team.modeChangeApproval` is an internal, single-use marker that can only be written by the UserPromptSubmit hook after an explicit user request. Do not add or refresh it in `.traffic-one/.one.json` manually.
<!-- T1BLOCK:END team-mode-marker-guard -->

<!-- T1BLOCK:BEGIN team-mode-downgrade-guard -->
Traffic One team mode guard: local Traffic One preferences currently record `team.mode="subagents"`. This write would switch the project to `team.mode="main-agent"`, but the latest user prompt did not explicitly say they no longer want subagents and want Low/main-agent mode. Ask the user to say that explicitly before rewriting local `performance.level="low"` and `team.mode="main-agent"`. Do not use `team.source="unavailable"` or a state rewrite as a workaround.
<!-- T1BLOCK:END team-mode-downgrade-guard -->

<!-- T1BLOCK:BEGIN team-mode-switch-authorized -->
The latest user prompt explicitly requested switching away from subagents to Low/main-agent mode. The next local Traffic One preference write may change `performance.level` to "low" and `team.mode` to "main-agent"; this authorization is single-use and expires in 10 minutes.
<!-- T1BLOCK:END team-mode-switch-authorized -->

<!-- T1BLOCK:BEGIN maintenance-triage-subagents -->
[MAINTENANCE PHASE — post-build triage] The main build is complete; this is an iteration request. Pick the tier, then ROUTE it — in this (subagents) mode do NOT implement trivial or small work yourself in this thread; handing it to a cheaper worker is the whole point of post-build triage. You judge the TIER (the keyword hint is a prior, not a verdict); the routing for the chosen tier is required, not optional. State your routing in one sentence and proceed — do not ask the user which tier, worker, or model to use.
- trivial — a CSS/styling tweak, copy/text, one i18n string, a rename, a single-file config change: spawn a `quick-fix` subagent with model "{{CHEAPEST_MODEL}}" on hosts whose spawn tool supports `model`; omit `model` on OpenCode/Kilo/Copilot/Windsurf unless the exact host tool documents support. Do NOT make the edit yourself.{{QUICK_FIX_OPENCODE_CLAUSE}} Give it the exact file(s), the precise change, and one verification step; the worker makes the change and verifies it (screenshot if visual).
- small — one component, one page/route, one small endpoint, or a scoped bug fix: spawn the owning implementation role(s) directly at their normal tier. Use `senior-frontend` for UI/routes and `senior-backend` for server/data; when the bounded request genuinely touches both, spawn those two roles in parallel. On Kilo, each direct role uses built-in `general` with its first-line role marker and matching `.kilo/agents/senior-<role>.md` contract, with no `model`.{{SMALL_OPENCODE_CLAUSE}} Do NOT spawn `senior-architect` or create a feature plan unless the work turns cross-cutting.
- complex — a feature spanning layers, a data-model/schema change, auth, a migration, or an external integration: read and follow the `senior-eng-orchestrator` skill NOW, before any edit, as a SINGLE-FEATURE run — the architect plans just this feature, decides frontend/backend/both and the per-role model tiers, then implement → review → test.
Keyword hint: {{HINT}} (confidence {{CONFIDENCE}}){{SIGNALS}}. If the user explicitly asked for a quick/small change, honor that. Full rubric: read the `task-triage` skill.
<!-- T1BLOCK:END maintenance-triage-subagents -->

<!-- T1BLOCK:BEGIN maintenance-triage-main-agent -->
[MAINTENANCE PHASE — post-build triage] The main build is complete; this is an iteration request. This project runs in main-agent mode (no subagents). Pick the tier and scale your effort to it — you judge the TIER (the keyword hint is a prior, not a verdict). Route it yourself in one sentence and proceed; do not ask the user which tier or approach to use.
- trivial — a CSS/styling tweak, copy/text, one i18n string, a rename, a single-file config change: make the edit directly, no planning ceremony.{{OPENCODE_CLAUSE}} Verify visually if the change is visual.
- small — one component, one page/route, one small endpoint, or a scoped bug fix: implement it directly after a brief plan.
- complex — a feature spanning layers, a data-model/schema change, auth, a migration, or an external integration: read and follow the `senior-eng-orchestrator` skill NOW and run its phases INLINE via the roadmap checklist — plan the feature, decide the surface, implement, then self-review and test. Do not spawn subagents.
Keyword hint: {{HINT}} (confidence {{CONFIDENCE}}){{SIGNALS}}. If the user explicitly asked for a quick/small change, honor that. Full rubric: read the `task-triage` skill.
<!-- T1BLOCK:END maintenance-triage-main-agent -->
