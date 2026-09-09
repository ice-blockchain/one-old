---
name: traffic-one-onboarding-gate
description: Wording source for the Traffic One setup gate. The onboarding questions now live in the local wizard server (shared/onboarding-server), so this only holds the gate's agent-facing prose — the wizard-URL deny, the short "setup pending" note, the team-mode write guards, the post-materialization re-run note, and the post-build maintenance-triage directives. Read at runtime via skillBlock(); the routing + deny LOGIC lives in TS.
---

# Traffic One Onboarding Gate

Directive PROSE for the onboarding gate. The questions themselves moved into the
installed local setup wizard, which the gate launches and points the user at —
so this file only carries the gate's agent-facing messages, not the questions.
`{{PLACEHOLDER}}` tokens are filled by the gate, and each block has a verbatim
fallback in code, so a missing block never disables the gate.

<!-- T1BLOCK:BEGIN server-bootstrap-required -->
Traffic One setup could not start inside this host's restricted hook sandbox ({{ERROR_CODE}}). Private preferences MUST remain in `~/.traffic-one/projects`; do not create `preferences.json`, `machine.json`, or onboarding runtime files inside the project.

Do not search for a wizard tool, claim the preview is already open, or end the turn. Your NEXT action is to run this exact bootstrap command with the required approval:

{{BOOTSTRAP_CMD}}

{{HOST_PERMISSION_STEP}}

The bootstrap prints `TRAFFIC_ONE_SETUP_READY` and a live `Setup link:`, then exits. Post that URL to the user as a standalone clickable link in a chat message — do not open it yourself with a browser tool. Immediately afterward run this normal waiter and keep the turn active:

{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, immediately continue the original request. If it prints `TRAFFIC_ONE_SETUP_PENDING`, run the exact same waiter again. If it prints `TRAFFIC_ONE_TECH_CLASSIFY_REQUIRED`, follow its printed classification instructions (inspect the repo, run the printed `--set-tech` command), then re-run. Hold feature writes, installs, and subagent work until setup completes.
<!-- T1BLOCK:END server-bootstrap-required -->

<!-- T1BLOCK:BEGIN server-bootstrap-required-compact -->
Traffic One setup needs approved access to its user-local state at `~/.traffic-one/projects` ({{ERROR_CODE}}).

Run with approval: {{BOOTSTRAP_CMD}}

It prints the live setup link and exits. Show that link, then keep setup active with:
{{WAIT_CMD}}

Hold feature writes until the waiter reports completion.
<!-- T1BLOCK:END server-bootstrap-required-compact -->

<!-- T1BLOCK:BEGIN server-deny-reason -->
Traffic One setup is required before building in this project. Setup now happens on the
Traffic One dashboard in the user's web browser — they sign in or create an account,
then finish a few setup steps. Your job is to SURFACE THE LINK to the user and then
wait. Do NOT try to answer the setup questions yourself, and do NOT create or edit
.claude/launch.json.

Post this clickable setup link to the user as your FIRST visible action, before any
wait command — put it in a CHAT MESSAGE on its own line, not buried in a terminal
block. Tool output and collapsed command blocks do NOT count as showing it: several
hosts hide them, so if the link is not in a message you wrote, the user has not seen
it. Show it as plain clickable text only; do NOT open it with a browser/navigate tool
or an `open`/`xdg-open`/`start` command — the user clicks it themselves:

    Open Traffic One setup: {{URL}}

{{LOCAL_FALLBACK}}

All setup logic and saves stay on this machine; the dashboard is just the UI.

CONTINUE AUTOMATICALLY — do NOT end your turn after showing the link. Immediately run
this command in the FOREGROUND of this turn (never as a background task) and keep your
turn open; it waits until the user finishes setup (run it with a long timeout,
~9 minutes / 540000 ms):

{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, IMMEDIATELY continue the user's original
request and build it end to end — do not stop to ask "what next?". If it prints
`TRAFFIC_ONE_SETUP_PENDING` (it timed out before setup finished), run the exact same
command again; after a couple of pending rounds with no progress, tell the user to
finish setup and wait for their go-ahead. (If you genuinely cannot run a shell command,
fall back to: when the user says setup is done, continue the request.)

Read-only orientation (pwd, ls, reading files, searching) and the wait command above
are allowed now. Hold feature writes, installs, and subagent work until
setup completes. Do NOT restart the host and do NOT answer these setup questions
yourself in chat — setup happens in the browser.

Don't use Traffic One: if the user says they don't want Traffic One for this
project, run this command instead — it saves their choice outside the project (no
files are added to it) and Traffic One stays silent here until they ask for it again:

{{DECLINE_CMD}}
<!-- T1BLOCK:END server-deny-reason -->

<!-- T1BLOCK:BEGIN cursor-wait-link-first -->
Check your own last VISIBLE chat message. Tool output and collapsed command blocks do not count — if the link is not in a message you wrote, the user has not seen it.

Post this to the user in your NEXT CHAT MESSAGE, on its own line, as plain clickable text — not inside a code block. Do NOT open it yourself with a browser tool or an `open`/`xdg-open`/`start` command; the user clicks it:

Open Traffic One setup: {{URL}}

{{LOCAL_FALLBACK}}

Only after that message is written, re-run the wait command in the FOREGROUND of the same turn and keep the turn open:

{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, continue the original request.
<!-- T1BLOCK:END cursor-wait-link-first -->

<!-- T1BLOCK:BEGIN claude-wait-link-first -->
Check your own last VISIBLE chat message. Tool output, hook banners, and collapsed command blocks do not count — if the link is not in a message you wrote, the user has not seen it.

Post this to the user in your NEXT CHAT MESSAGE, on its own line, as plain clickable text — not inside a code block. Do NOT open it yourself with a browser tool or an `open`/`xdg-open`/`start` command; the user clicks it:

Open Traffic One setup: {{URL}}

{{LOCAL_FALLBACK}}

Only after that message is written, re-run the wait command in the FOREGROUND of the same turn (run_in_background: false, timeout ~9 minutes / 540000 ms) and keep the turn open:

{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, continue the original request.
<!-- T1BLOCK:END claude-wait-link-first -->

<!-- T1BLOCK:BEGIN claude-wait-background-denied -->
This onboarding command was requested with run_in_background: true. A backgrounded run writes its output — including the setup link it prints — into a background task file the user never opens, and the turn ends with the user waiting on a link they were never shown.

{{URL_LINE}}

Post the setup link to the user in a CHAT MESSAGE — plain clickable text on its own line, not inside a code block — then re-run this SAME command in the FOREGROUND of this turn (run_in_background: false, timeout ~9 minutes / 540000 ms) and keep the turn open. Follow its printed instructions when it finishes.

{{WAIT_CMD}}
<!-- T1BLOCK:END claude-wait-background-denied -->

<!-- T1BLOCK:BEGIN stop-setup-required -->
Setup reminder: Traffic One setup is still needed, and the setup link has not been confirmed delivered — if the link is not in a message you wrote, the user has no way to continue setup.

Post this setup link to the user NOW, in a chat message, on its own line, as plain clickable text — not inside a code block. Do NOT open it yourself; the user clicks it:

Open Traffic One setup: {{URL}}

{{LOCAL_FALLBACK}}

Then run this wait command in the FOREGROUND (run_in_background: false, timeout ~9 minutes / 540000 ms) and keep the turn open. When it prints TRAFFIC_ONE_SETUP_COMPLETE, continue the original request:

{{WAIT_CMD}}
<!-- T1BLOCK:END stop-setup-required -->

<!-- T1BLOCK:BEGIN stop-setup-link-posted -->
Setup reminder: Traffic One setup is still pending. The setup link is already posted in the conversation — do NOT post it again; a repeated link reads as noise.

Run this wait command NOW in the FOREGROUND (run_in_background: false, timeout ~9 minutes / 540000 ms) and keep the turn open. It returns immediately if setup is already complete; when it prints TRAFFIC_ONE_SETUP_COMPLETE, continue the original request:

{{WAIT_CMD}}
<!-- T1BLOCK:END stop-setup-link-posted -->

<!-- T1BLOCK:BEGIN stop-setup-links-shown -->
Setup reminder: Traffic One setup is still in progress — the user has the setup wizard open in their browser right now (the setup server saw it load). Do NOT repost the link: a repeated link reads as "start over".

Run this wait command NOW in the FOREGROUND (run_in_background: false, timeout ~9 minutes / 540000 ms) and keep the turn open. It returns immediately if setup is already complete; when it prints TRAFFIC_ONE_SETUP_COMPLETE, continue the original request:

{{WAIT_CMD}}
<!-- T1BLOCK:END stop-setup-links-shown -->

<!-- T1BLOCK:BEGIN codex-wait-link-first -->
The setup link has not been posted to the user in this conversation yet, and this deny reason is the only channel that reaches you — so the user still has no link to click.

Post this to the user in your NEXT MESSAGE, on its own line, as plain clickable text — not inside a code block. Do NOT open it yourself; the user clicks it and completes setup in their browser:

Open Traffic One setup: {{URL}}

{{LOCAL_FALLBACK}}

Only after that message is written, re-run the wait command in the foreground of the same turn and keep the turn open:

{{WAIT_CMD}}

When it prints TRAFFIC_ONE_SETUP_COMPLETE, continue the original request.
<!-- T1BLOCK:END codex-wait-link-first -->

<!-- T1BLOCK:BEGIN server-deny-reason-repeat -->
Setup reminder: Traffic One setup is still pending. Finish setup before feature work.
Post this setup link to the user in a chat message — the user opens it, not you: {{URL}}
{{LOCAL_FALLBACK}}
Keep your turn open by running the wait command again (long timeout, ~9 minutes):

{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, IMMEDIATELY continue the user's original
request. Full instructions were given on the first denial this session.
Don't use Traffic One: if the user says they don't want it for this project, run:
{{DECLINE_CMD}}
<!-- T1BLOCK:END server-deny-reason-repeat -->

<!-- T1BLOCK:BEGIN browser-open-denied -->
Traffic One does not open the setup link for the user — they open it themselves.

Post the setup link in a CHAT MESSAGE instead, on its own line, as plain clickable text (not inside a code block), then run the wait command and keep your turn open.

An agent that opens the link tends to then believe it has "already shared" it and never posts it, which leaves the user with no link at all. Look at your own last visible chat message: if the link is not there, the user has not seen it.
<!-- T1BLOCK:END browser-open-denied -->

<!-- T1BLOCK:BEGIN server-deny-reason-links-shown -->
Traffic One setup is required before building — and the user HAS the setup wizard
open in their browser right now (the setup server saw it load). Do NOT print the link
again: they are mid-setup, and a repeated link reads as "start over". Only repeat it
if the user says they cannot find it.

CONTINUE AUTOMATICALLY — run this wait command NOW, in the FOREGROUND of this turn
(never as a background task, and do not open any URL with a browser tool), with a long
timeout (~9 minutes / 540000 ms). It BLOCKS until the user finishes setup and returns
IMMEDIATELY if setup is already complete:

{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, IMMEDIATELY continue the user's original
request. If it prints `TRAFFIC_ONE_SETUP_PENDING` (it timed out before setup
finished), run the exact same command again. Read-only orientation stays allowed;
feature writes, installs, and subagent work stay blocked until setup completes.

Don't use Traffic One: if the user says they don't want it for this project, run:
{{DECLINE_CMD}}
<!-- T1BLOCK:END server-deny-reason-links-shown -->

<!-- T1BLOCK:BEGIN windsurf-server-deny-reason -->
Traffic One setup is required before building.

Before running any tool, show the user this standalone clickable setup link — do not open it yourself:
[Open Traffic One setup]({{URL}})

{{LOCAL_FALLBACK}}

Keep the current turn active by running this wait command (timeout ~9 minutes):
{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, immediately continue the original request.
<!-- T1BLOCK:END windsurf-server-deny-reason -->

<!-- T1BLOCK:BEGIN windsurf-server-deny-reason-repeat -->
Traffic One setup is still pending.

Before running any tool, show the user this standalone clickable setup link — do not open it yourself:
[Open Traffic One setup]({{URL}})

{{LOCAL_FALLBACK}}

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

<!-- T1BLOCK:BEGIN materialization-not-converged -->
traffic-one — this tool use was denied because Traffic One could not finish bringing this project's materialized rules and skills up to date, and a file-changing tool must not run against a half-converged project: `.traffic-one/rules` and `.traffic-one/skills` are the project's only copy of content a broken plugin root cannot resupply.
{{DIAGNOSIS}}
Re-issuing this tool call draws this same refusal. The cause above is a fact about the installation or about `.traffic-one/.one.json`, not about the tool you tried, so nothing about running it again changes it. Repair that cause if it is yours to repair; if it is not, report it to the user in the terms above and carry on with work that changes no files, which is not affected.
<!-- T1BLOCK:END materialization-not-converged -->

<!-- T1BLOCK:BEGIN kilo-opencode-spawn-first -->
[traffic-one] {{HOST}} build start — `team.mode="subagents"` is ACTIVE and `.traffic-one/plan.md` is still missing. You are the PARENT/orchestrator.

DO NOT write feature source, scaffold app files, or run package installs yourself in this thread.
Your FIRST action: spawn `senior-architect` via the host `{{TASK_TOOL}}` tool:
- `subagent_type: "{{SUBAGENT_TYPE}}"` — {{SPAWN_RULE}}
- prompt line 1 MUST be: `[t1-role: senior-<role>]` (substitute the spawned role; architect here)
- {{ROLE_CONTRACT_INSTRUCTION}}
- include `Run ID: {{RUN_ID}}` and the user's original request
- omit `model` on {{HOST}} unless the host documents a subagent model parameter

Runtime capability contract: {{PROFILE_SUMMARY}}.
Do not replace these detected surfaces, roots, framework conventions, skill buckets, or QA adapters with an unrelated default.

{{IMPLEMENTER_DIRECTIVE}}
{{QA_DIRECTIVE}}
Read `.traffic-one/rules/common/senior-engineer-team.md` before the first eligible implementer spawn.
<!-- T1BLOCK:END kilo-opencode-spawn-first -->

<!-- T1BLOCK:BEGIN kilo-opencode-architect-incomplete -->
[traffic-one] {{HOST}} build — `.traffic-one/plan.md` exists but the architect phase is INCOMPLETE. You are the PARENT/orchestrator.

DO NOT spawn any implementation role from the runtime capability contract yet. DO NOT patch `assignments.json` or `digests/{{RUN_ID}}/architect.md` yourself unless the user explicitly opts out of subagents.

Missing architect deliverables: {{MISSING}}

Respawn `senior-architect` via `{{TASK_TOOL}}` with:
- `subagent_type: "{{SUBAGENT_TYPE}}"` — {{SPAWN_RULE}}
- prompt line 1: `[t1-role: senior-<role>]` (substitute the spawned role; architect here)
- {{ROLE_CONTRACT_INSTRUCTION}}
- `Run ID: {{RUN_ID}}`
- instruct the architect to finish project memory and semantic
  `.traffic-one/runs/{{RUN_ID}}/architecture-input-v1.json`, then write
  `.traffic-one/digests/{{RUN_ID}}/architect.md` with `PLAN_READY`; runtime
  compiles architecture/verification, assignments, and work-unit bootstraps

Runtime capability contract: {{PROFILE_SUMMARY}}.
{{IMPLEMENTER_DIRECTIVE}}
{{QA_DIRECTIVE}}

Implementer spawns are blocked until the digest carries `PLAN_READY` on disk.
<!-- T1BLOCK:END kilo-opencode-architect-incomplete -->

<!-- T1BLOCK:BEGIN paid-host-spawn-first -->
[traffic-one] {{HOST}} build start — `team.mode="subagents"` is ACTIVE and `.traffic-one/plan.md` is still missing. You are the PARENT/orchestrator.

DO NOT write feature source, scaffold app files, or run package installs yourself in this thread.
Your FIRST action: spawn `senior-architect` via the host `{{TASK_TOOL}}` tool:
{{SPAWN_INSTRUCTIONS}}
- include `Run ID: {{RUN_ID}}` and the user's original request{{FOREGROUND_RULE}}

Runtime capability contract: {{PROFILE_SUMMARY}}.
Do not replace these detected surfaces, roots, framework conventions, skill buckets, or QA adapters with an unrelated default.

{{IMPLEMENTER_DIRECTIVE}}
{{QA_DIRECTIVE}}
Read `.traffic-one/rules/common/senior-engineer-team.md` before the first eligible implementer spawn.
<!-- T1BLOCK:END paid-host-spawn-first -->

<!-- T1BLOCK:BEGIN paid-host-architect-incomplete -->
[traffic-one] {{HOST}} build — `.traffic-one/plan.md` exists but the architect phase is INCOMPLETE. You are the PARENT/orchestrator.

DO NOT write feature source. DO NOT spawn any implementation role from the runtime capability contract yet. DO NOT patch `assignments.json` or `digests/{{RUN_ID}}/architect.md` yourself unless the user explicitly opts out of subagents.

Missing architect deliverables: {{MISSING}}

Respawn `senior-architect` via `{{TASK_TOOL}}` with:
{{SPAWN_INSTRUCTIONS}}
- `Run ID: {{RUN_ID}}`{{FOREGROUND_RULE}}
- instruct the architect to finish project memory and semantic
  `.traffic-one/runs/{{RUN_ID}}/architecture-input-v1.json`, then write
  `.traffic-one/digests/{{RUN_ID}}/architect.md` with `PLAN_READY`; runtime
  compiles architecture/verification, assignments, and work-unit bootstraps

Runtime capability contract: {{PROFILE_SUMMARY}}.
{{IMPLEMENTER_DIRECTIVE}}
{{QA_DIRECTIVE}}

Implementer spawns are blocked until the digest carries `PLAN_READY` on disk.
<!-- T1BLOCK:END paid-host-architect-incomplete -->

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
- trivial — a CSS/styling tweak, copy/text, one i18n string, a rename, a single-file config change: spawn a `quick-fix` subagent with model "{{CHEAPEST_MODEL}}" on hosts whose spawn tool supports `model`; omit `model` on OpenCode/Kilo/Copilot/Windsurf unless the exact host tool documents support. On Codex use one fresh `spawn_agent` call with `task_name: "quick_fix"`, `fork_turns: "none"`, and `model: "{{CHEAPEST_MODEL}}"`; never retry with a generic task name, inherited/full history, or a different available model. Do NOT make the edit yourself.{{QUICK_FIX_OPENCODE_CLAUSE}} Give it the exact file(s), the precise change, and one verification step; the worker makes the change and verifies it (screenshot if visual). Include ONE line in the spawn prompt of the form `[t1-bounded-scope: {"outputs":["src/exact/File.tsx"]}]` naming every exact repo-relative file the fix may create or modify (no globs or directories) — the runtime publishes the bounded WorkUnitContract from that line, and a spawn without it is denied.
- small — one component, one page/route, one small endpoint, or a scoped bug fix: spawn the owning implementation role(s) directly at their normal tier. Use `senior-frontend` for UI/routes and `senior-backend` for server/data; when the bounded request genuinely touches both, spawn those two roles in parallel. On Kilo, each direct role uses built-in `general` with its first-line role marker and matching `.kilo/agents/senior-<role>.md` contract, with no `model`.{{SMALL_OPENCODE_CLAUSE}} Every small-tier `senior-frontend` / `senior-backend` spawn MUST include ONE `[t1-bounded-scope: {"outputs":["exact/file.ts"]}]` line naming every exact repo-relative path the unit may create or modify (no globs). Without it the spawn is denied (`spawn-bounded-scope-missing`). Do NOT spawn `senior-architect` or create a feature plan unless the work turns cross-cutting — skip architect only because that marker (or an already-published envelope) replaces PLAN_READY for this small unit.
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

<!-- T1BLOCK:BEGIN tech-classify-required -->
traffic-one — this existing codebase could not be identified deterministically: none of the known stack markers matched, so YOU must classify it before setup can continue.

1. Inspect the repo yourself — package manifests, lockfiles, entrypoints, framework configs. A few READS are enough; do not modify anything.
2. Submit the tech by running this command with the surfaces you identified appended:
{{SET_TECH_TEMPLATE}}
   Append: `--frontend=<id>` and `--backend=<id>` (both REQUIRED — use `none` when that surface does not exist), plus optional `--mobile=<id>`, `--realtime=light` (when a websocket/realtime layer exists), and `--evidence='<short proof>'` (e.g. --evidence='express + mongoose in package.json').
   frontend ids: none, react-vite, nextjs, nuxt, vue, svelte, angular, astro, solid, remix, other
   backend ids: none, supabase, external-api, node, nestjs, python, django, fastapi, go, rust, java, kotlin, php, laravel, dotnet, firebase, mongo, other
   mobile ids: ionic-capacitor, react-native-expo, swift-native, kotlin-android, flutter, none
   Use `other`/`none` when nothing fits — NEVER invent an id; the command is denied unless every id is from these lists.

Partial signals already detected:
{{HINTS}}

On success it prints TRAFFIC_ONE_TECH_RECORDED and then the setup wizard's `Setup link:` — post that link to the user in chat and run the printed waiter command, exactly as in the normal setup flow. Run the command EXACTLY as printed plus your surface flags — no pipes, redirection, or `&&`; the gate allow-lists the precise argv.
<!-- T1BLOCK:END tech-classify-required -->

<!-- T1BLOCK:BEGIN doctor-unblock-agent-mint -->
traffic-one — blocked: an agent must not mint its own operator override. `doctor --unblock` writes a token under ~/.traffic-one/overrides that lifts a gate for this run. That is a bypass, not a recovery. If a human intends to override, they run doctor themselves in their own terminal — not through this tool call, and not wrapped in expect, script, python pty, bash -c, or any other helper. Read-only doctor (`--bundle`, `--run`, `--session`) remains available.
<!-- T1BLOCK:END doctor-unblock-agent-mint -->
