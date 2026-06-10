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

<!-- T1BLOCK:BEGIN server-deny-reason -->
Traffic One setup is required before building in this project. OPEN THE SETUP WIZARD
IN YOUR EDITOR'S IN-APP PREVIEW PANE — do NOT open an external browser. Traffic One
has ALREADY written this project's .claude/launch.json, so do NOT create or edit that
file yourself:

- Claude Code: your FIRST action is to call preview_start with name
  "traffic-one-setup" — it is already registered in .claude/launch.json and points at
  the running wizard, so it opens in the in-app preview pane.
- Cursor: open the link below in the built-in Simple Browser.
- Codex / other host: open the link below in your in-app web view if you have one.

If you have no in-app preview at all, give the user this clickable link to open:
{{URL}}

CONTINUE AUTOMATICALLY — do NOT end your turn after opening the wizard. Immediately
after opening it, run this command and keep your turn open; it BLOCKS until the user
finishes setup (run it with a long timeout, ~9 minutes / 540000 ms):

{{WAIT_CMD}}

When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, first CLOSE the wizard view you opened
(the page also closes itself where the host allows it): Claude Code → `preview_stop`
for "traffic-one-setup"; Codex/Cursor → close the in-app browser tab you opened.
Then IMMEDIATELY continue the user's original
request and build it end to end — do not stop to ask "what next?". If it prints
`TRAFFIC_ONE_SETUP_PENDING` (it timed out before setup finished), run the exact same
command again; after a couple of pending rounds with no progress, tell the user to
finish the wizard and wait for their go-ahead. (If you genuinely cannot run a shell
command, fall back to: when the wizard says it is done, continue the request.)

The wizard runs locally, installs the tools it needs (showing progress), and writes
the configuration. Read-only orientation (pwd, ls, reading files, searching) and the
wait command above are allowed now, but feature writes, installs, and subagent work
stay blocked until setup completes. Do NOT restart the host, do NOT answer these
setup questions yourself in chat, and do NOT hand-write launch.json — the wizard owns
the questions and Traffic One owns the preview config.

If the user would rather not use Traffic One, they can choose "Continue without
Traffic One" from the Traffic One auth prompt.
<!-- T1BLOCK:END server-deny-reason -->

<!-- T1BLOCK:BEGIN setup-pending -->
Traffic One needs a quick setup before it can build in this project. When you start
a coding task, Traffic One opens a local setup wizard — shown in your editor's
in-app preview pane (Claude Code preview / Cursor Simple Browser), with a clickable
link as fallback — that collects a few choices and installs the tools it needs, then
writes the configuration.

Until then only read-only orientation is in effect: do not scaffold, install, or
write feature code, do not invoke build/design skills, and do NOT try to ask these
setup questions yourself in chat — the wizard owns them. Do not tell the user to
restart the host. If the user would rather not use Traffic One, they can choose
"Continue without Traffic One" from the auth prompt.
<!-- T1BLOCK:END setup-pending -->

<!-- T1BLOCK:BEGIN repaired-materialization -->
Traffic One state was repaired/materialized before this tool use.
The attempted mutating tool has been denied once so it cannot run against stale `.traffic-one/.one.json`, rules, skills, or root agent context.
rerun the same tool now; the canonical `.traffic-one/.one.json` and project-local materialization are current.
<!-- T1BLOCK:END repaired-materialization -->

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
[MAINTENANCE PHASE — post-build triage] The main build is complete; this is an iteration request. Classify its complexity BEFORE acting and scale the machinery to it. You decide authoritatively — the keyword hint below is a prior, not a verdict.
- trivial — a CSS/styling tweak, copy/text, one i18n string, a rename, a single-file config change: delegate to a `quick-fix` subagent. With OpenCode active it runs free on OpenCode first; otherwise pass the cheapest model for this host. No architect, no full team. Still verify visually if the change is visual.
- small — one component, one small endpoint, or a scoped bug fix: a single role subagent (senior-frontend OR senior-backend) at its normal tier; no architect unless it turns cross-cutting.
- complex — a feature spanning layers, a data-model/schema change, auth, a migration, or an external integration: re-engage the senior team for a SINGLE-FEATURE run via the senior-eng-orchestrator. The architect plans just this feature, decides frontend/backend/both and the per-role model tiers, then implement → review → test.
Heuristic hint: {{HINT}} (confidence {{CONFIDENCE}}){{SIGNALS}}. OpenCode: {{OPENCODE}}. If the user explicitly asked for a quick/small change, honor that over the hint. Full rubric: read the `task-triage` skill.
<!-- T1BLOCK:END maintenance-triage-subagents -->

<!-- T1BLOCK:BEGIN maintenance-triage-main-agent -->
[MAINTENANCE PHASE — post-build triage] The main build is complete; this is an iteration request. This project runs in main-agent mode (no subagents). Classify its complexity BEFORE acting and scale your effort to it. You decide authoritatively — the keyword hint below is a prior, not a verdict.
- trivial — a CSS/styling tweak, copy/text, one i18n string, a rename, a single-file config change: make the edit directly. With OpenCode active you MAY delegate it free via the OpenCode tool. No planning ceremony. Still verify visually if the change is visual.
- small — one component, one small endpoint, or a scoped bug fix: implement it directly after a brief plan.
- complex — a feature spanning layers, a data-model/schema change, auth, a migration, or an external integration: run the senior-eng-orchestrator phases INLINE via the roadmap checklist — plan the feature, decide the surface, implement, then self-review and test. Do not spawn subagents.
Heuristic hint: {{HINT}} (confidence {{CONFIDENCE}}){{SIGNALS}}. OpenCode: {{OPENCODE}}. If the user explicitly asked for a quick/small change, honor that over the hint. Full rubric: read the `task-triage` skill.
<!-- T1BLOCK:END maintenance-triage-main-agent -->
