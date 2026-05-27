---
name: auth
description: >
  Traffic One authentication gate — the flow that runs at SessionStart and
  before tool use to ensure the user is authenticated (or has explicitly chosen
  to continue without Traffic One). This skill is the single editable source of
  the auth gate's directive wording: the hook (scripts/hook-runtime/handlers/auth.cjs)
  keeps the deterministic decisions + enforcement and reads the per-branch text
  from the T1AUTH blocks below. Edit the blocks to customise auth wording without
  touching JavaScript.
metadata:
  type: hook-directive-source
  consumed_by: scripts/hook-runtime/handlers/auth.cjs
  read_via: scripts/hook-runtime/handlers/auth-skill.cjs (authSkillBlock)
---

# Traffic One Auth Gate

This skill documents and *parameterises* the Traffic One authentication flow.
The deterministic decision-making and enforcement live in JavaScript
(`auth.cjs` + the `traffic-one-auth` client) and MUST stay there — a markdown
skill is advisory and cannot block a tool call. What lives here is the **wording
of every directive the gate emits**, captured in the `T1AUTH` blocks at the
bottom. `auth.cjs` reads each block (via `authSkillBlock`) and emits it verbatim,
so editing a block changes what the agent is told — with zero code changes and
identical control flow.

## When the gate runs

- **SessionStart** (`runSessionStart` → `authGateForHook({ forceRemote: true })`):
  if the plugin authoring root is detected the gate is skipped entirely.
  Otherwise it checks authentication and, when not authenticated, either stays
  silent (if the user already chose "Continue without Traffic One" for this
  project and the choice is still fresh) or emits the **session-start-gate**
  directive + the auth-choice modal.
- **PreToolUse** (`authPreToolGate`): before each tool call. If authenticated →
  allow. If the tool is a `traffic-one-auth.cjs` (login|refresh|status|logout)
  or doctor shell command → allow even while unauthenticated. If the user chose
  continue-without and it is still fresh → allow. If the session is merely
  EXPIRED (recoverable with the same key) → **deny** with the **session-expired**
  directive. Otherwise → **deny** with the **pre-tool-deny** directive + the
  auth-choice modal. The deny is a real `permissionDecision: "deny"` that blocks
  the tool.
- **UserPromptSubmit**: when the user answers the auth-choice modal
  ("Authenticate" → **api-key-prompt**; "Continue without" → **continue-without**),
  and when the user pastes an API key (the hook runs login + status internally
  and emits **login-success** or **login-failed**).

## Decision tree (deterministic, in `authGateForHook`)

1. Not locally authenticated → run `status` (which may silently `refresh` when
   `TRAFFIC_ONE_AUTH_KEY` is present). Authenticated now → pass
   (`reauthenticated` when a refresh happened). Else → not authenticated, with a
   `reason`/`priorReason` (e.g. `expired`).
2. Locally authenticated, remote check not yet due (default once / 24h) and not
   forced → pass without a remote check.
3. Remote check due/forced → run `status --remote`. Remote says not
   authenticated → fail (session revoked). Remote check could not complete →
   fail, unless `TRAFFIC_ONE_AUTH_ALLOW_REMOTE_CHECK_FAILURE=1` (test-only escape
   hatch). Otherwise → pass.

Auth state lives at `TRAFFIC_ONE_AUTH_STATE_PATH` (or `~/.traffic-one/auth.json`);
the auth-choice state (the per-project "continue without" / global
"authenticate" record, TTL 4h for continue-without) lives next to it or at a
`TMPDIR` fallback. A session is treated as a recoverable **expiry** (ask only for
the key) only when the stored state is structurally valid and endpoint-matched
but past its TTL; a missing state, endpoint mismatch, or malformed token is a
cold first-run instead.

## How to customise

Edit the text inside any `T1AUTH:BEGIN/END` block below. Keep the
`{{PLACEHOLDER}}` tokens — `auth.cjs` fills them in (`{{CODE}}` = an optional
storage error code; `{{REASON}}` = the internal login failure reason). Do not
rename blocks (the function reads them by name) and keep the security guidance
(never run the key through a shell, never edit `auth.json` directly) intact.

---

## Directive blocks

### SessionStart auth-required body
Emitted as the SessionStart `additionalContext`, after the auth-client's
required-auth message and before any storage diagnostic.

<!-- T1AUTH:BEGIN session-start-gate -->
Traffic One is inactive for this prompt because authentication is missing, expired, or rejected.

Your next assistant action must present a host modal selector with exactly two choices when a modal/popup tool is available:

Question: Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin?
Choices:
- Authenticate Traffic One (Recommended)
- Continue without Traffic One

If the user chooses Authenticate Traffic One, ask for the Traffic One API key (use a secure host input/modal) and then STOP and wait. When the user pastes the key, Traffic One authenticates it automatically inside the hook (it runs login + status internally). Do NOT run `traffic-one-auth.cjs` or any auth command yourself via Bash/shell — Claude Code's security classifier blocks passing a key to a script, and the hook already performs the login. Do not Write or Edit `auth.json` directly, do not echo the key, and do not ask the user to run shell commands.
If the user chooses Continue without Traffic One, continue the user request with Traffic One disabled and remember that choice for this project so this prompt is not repeated here while it remains active.

Do not answer pending Traffic One onboarding choices, inspect, scaffold, or build through Traffic One until the user makes this auth choice.
<!-- T1AUTH:END session-start-gate -->

### Storage-write failure diagnostic
Appended (after a leading blank line) only when the auth-choice state could not
be persisted. `{{CODE}}` is an optional ` (ERRCODE)` suffix.

<!-- T1AUTH:BEGIN persistence-diagnostic -->
Diagnostic: Traffic One could not persist the auth choice state{{CODE}}.
Keep Traffic One inactive and blocked until the user authenticates or chooses to continue without Traffic One. The prompt may repeat until storage is writable.
Run Traffic One doctor to check hook/auth storage setup if this persists.
<!-- T1AUTH:END persistence-diagnostic -->

### PreToolUse deny reason
The `permissionDecisionReason` when a tool call is blocked for missing auth.

<!-- T1AUTH:BEGIN pre-tool-deny -->
Traffic One authentication choice required before tool use.

Authentication is missing, expired, or rejected. The assistant must not continue with tools until the user chooses one path.

Present this as a host modal selector when a modal/popup tool is available:
Question: Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin?
Choices: Authenticate Traffic One (Recommended); Continue without Traffic One.

If Authenticate Traffic One is chosen, ask for the API key (secure input) and STOP. When the user pastes the key, Traffic One authenticates it automatically inside the hook — do NOT invoke `traffic-one-auth.cjs` or any auth command via Bash/shell yourself (Claude Code's security classifier blocks passing a key to a script; the hook runs login + status internally). Do not Write/Edit `auth.json` directly, and do not ask the user to run bash or shell commands.
If Continue without Traffic One is chosen, remember the choice for this project and continue the request using normal non-Traffic-One behavior only.

Do not inspect, scaffold, install, edit, or build before the user answers this auth choice.
<!-- T1AUTH:END pre-tool-deny -->

### Session-expired refresh
Emitted (SessionStart prompt + PreToolUse deny) when a previously-authenticated
session has only expired — ask for the key, never offer continue-without.

<!-- T1AUTH:BEGIN session-expired -->
Your Traffic One session has expired. Do not continue implementation yet.
This is a session refresh, not first-time setup — the user already authenticated, so only a fresh API key is needed. Do not offer "Continue without Traffic One" here.
Ask the user for their Traffic One API key using a secure host input/modal if available.
After the user provides the key, re-authenticate internally with TRAFFIC_ONE_AUTH_KEY and verify status internally.
Automatically means: when the user pastes the key, Traffic One authenticates it inside the hook (login + status run internally). Do NOT invoke `traffic-one-auth.cjs` or any auth command via Bash/shell yourself — Claude Code's security classifier blocks passing a key to a script. Just ask for the key and STOP; the hook completes the refresh. Do not Write or Edit `auth.json` directly.
Do not ask the user to run bash or shell commands. Do not echo the key back to the user.
Tip: export TRAFFIC_ONE_AUTH_KEY in the environment so the session refreshes automatically without prompting.
<!-- T1AUTH:END session-expired -->

### API-key prompt
Emitted after the user picks "Authenticate Traffic One"; a storage diagnostic
(trimmed) may follow.

<!-- T1AUTH:BEGIN api-key-prompt -->
The user chose to authenticate Traffic One. Do not continue implementation yet.
Ask the user for the Traffic One API key using a secure host input/modal if available.
After the user enters the key, run authentication internally with TRAFFIC_ONE_AUTH_KEY and verify status internally.
Automatically means: when the user pastes the key, Traffic One authenticates it inside the hook (login + status run internally) — you do NOT run any command. Do NOT invoke `traffic-one-auth.cjs` or any auth command via Bash/shell yourself: Claude Code's security classifier blocks passing a key to a script, and the hook already mints the session. Just ask for the key and STOP. Do not Write or Edit `auth.json` directly.
Do not ask the user to run bash or shell commands. Do not echo the key back to the user.
<!-- T1AUTH:END api-key-prompt -->

### Continue-without acknowledgement
Emitted after the user picks "Continue without Traffic One"; followed by a
remembered-yes/remembered-no line and a trimmed storage diagnostic.

<!-- T1AUTH:BEGIN continue-without -->
The user chose to continue without using the Traffic One plugin.
Proceed with the user request using normal non-Traffic-One behavior only.
Do not run Traffic One skills, onboarding, setup, reporting, materialization, agents, or hooks for this request.
<!-- T1AUTH:END continue-without -->

<!-- T1AUTH:BEGIN remembered-yes -->
This choice has been remembered for this project so the auth prompt is not repeated here while it remains active.
<!-- T1AUTH:END remembered-yes -->

<!-- T1AUTH:BEGIN remembered-no -->
This choice could not be persisted, so the auth prompt may repeat until Traffic One auth-choice storage is writable.
<!-- T1AUTH:END remembered-no -->

### Internal login result
Emitted after the hook runs the internal login+status flow on a pasted key.
`{{REASON}}` is the failure reason.

<!-- T1AUTH:BEGIN login-failed -->
Traffic One authentication failed while running the internal login/status flow.
Reason: {{REASON}}
Ask the user to re-enter the API key. Do not echo the key and do not ask the user to run shell commands.
<!-- T1AUTH:END login-failed -->

<!-- T1AUTH:BEGIN login-success -->
Traffic One authentication completed internally and status reports authenticated.
Continue the user request with Traffic One enabled.
<!-- T1AUTH:END login-success -->
