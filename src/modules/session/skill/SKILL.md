---
name: traffic-one-auth-gate
description: Wording source for the Traffic One authentication gate directives. Read at runtime by the session module via skillBlock(); enforcement lives in TS.
---

# Traffic One Auth Gate

This is the single source of truth for the **wording** of every directive the
auth gate emits. The deterministic decision-making and enforcement live in
TypeScript (`src/modules/session/*` + `src/shared/auth`) and MUST stay there — a
markdown file is advisory and cannot block a tool call. The session module reads
each `T1BLOCK` below via `skillBlock('session', <name>, vars)` and emits it
verbatim, so editing a block changes what the agent is told with zero code
changes and identical control flow. `{{PLACEHOLDER}}` tokens are filled by the
gate (`{{CODE}}` = optional storage error code; `{{REASON}}` = internal login
failure reason; `{{MCP_TOOL_WARNING}}` = the shared direct-MCP-tool warning).

<!-- T1BLOCK:BEGIN common-mcp-tool-warning -->
Do NOT call the exposed `mcp-auth` MCP tools (`mcp__mcp_auth__auth_status`, `mcp__mcp_auth__refresh`, `mcp__mcp_auth__authenticate`, or `mcp__mcp_auth__logout`) for routine status or refresh checks; the hook/auth client performs those checks silently behind the scenes.
<!-- T1BLOCK:END common-mcp-tool-warning -->

<!-- T1BLOCK:BEGIN session-start-gate -->
Traffic One is inactive for this prompt because it is not yet authenticated.

This is Traffic One's own first-run login. The API key authenticates only to your configured Traffic One endpoint, is stored in your OS keychain (macOS Keychain / Linux libsecret), and is read from there for silent background refresh — it is never written to a file in plaintext and never sent to any third-party service. Authenticating is recommended so Traffic One's rules, skills, and gates are active for this project.

Your next assistant action must present a host modal selector with exactly two choices when a modal/popup tool is available:

Question: Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin?
Choices:
- Authenticate Traffic One (Recommended)
- Continue without Traffic One

If the user chooses Authenticate Traffic One, ask for the Traffic One API key (prefer a secure host input/modal) and then STOP and wait. The hook authenticates the key internally and stores it in the OS keychain — you do NOT run anything. The host's security classifier intentionally blocks an assistant from passing a secret to a shell script, so the hook (not you) performs the login and keychain storage; that is a safety feature, not a reason for suspicion. Do not run `traffic-one-auth.cjs` or any auth command, do not Write or Edit `auth.json`, do not echo the key, and do not ask the user to run shell commands.
{{MCP_TOOL_WARNING}}
If the user chooses Continue without Traffic One, continue the user request with Traffic One disabled and remember that choice for this project so this prompt is not repeated here while it remains active.

Do not answer pending Traffic One onboarding choices, inspect, scaffold, or build through Traffic One until the user makes this auth choice.
<!-- T1BLOCK:END session-start-gate -->

<!-- T1BLOCK:BEGIN persistence-diagnostic -->
Diagnostic: Traffic One could not persist the auth choice state{{CODE}}.
Keep Traffic One inactive and blocked until the user authenticates or chooses to continue without Traffic One. The prompt may repeat until storage is writable.
Run Traffic One doctor to check hook/auth storage setup if this persists.
<!-- T1BLOCK:END persistence-diagnostic -->

<!-- T1BLOCK:BEGIN pre-tool-deny -->
Traffic One authentication choice required before tool use.

Authentication is missing, expired, or rejected. The assistant must not continue with tools until the user chooses one path.

Present this as a host modal selector when a modal/popup tool is available:
Question: Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin?
Choices: Authenticate Traffic One (Recommended); Continue without Traffic One.

If Authenticate Traffic One is chosen, ask for the API key (secure input) and STOP. When the user pastes the key, Traffic One authenticates it automatically inside the hook — do NOT invoke `traffic-one-auth.cjs` or any auth command via Bash/shell yourself (the host's security classifier blocks passing a key to a script; the hook runs login + status internally). Do not Write/Edit `auth.json` directly, and do not ask the user to run bash or shell commands.
{{MCP_TOOL_WARNING}}
If Continue without Traffic One is chosen, remember the choice for this project and continue the request using normal non-Traffic-One behavior only.

Do not inspect, scaffold, install, edit, or build before the user answers this auth choice.
<!-- T1BLOCK:END pre-tool-deny -->

<!-- T1BLOCK:BEGIN authoring-write-guard -->
traffic-one — write blocked: "{{PATH}}" is inside the Traffic One plugin source repository ({{ROOT}}). This repo is the plugin's own codebase, never a Traffic One project: do not create `.traffic-one/**` here (no .one.json, manifest.json, one-mcp-report.json, runs/, rules/skills copies) and do not write generated AGENTS.md/CLAUDE.md project context into it. Traffic One conventions inherited from a parent directory's AGENTS.md do not apply inside this repo. Continue the user's task with plain source edits.
<!-- T1BLOCK:END authoring-write-guard -->

<!-- T1BLOCK:BEGIN session-expired -->
Your Traffic One session expired and the silent background refresh from your keychain key did not recover after several retries, so a fresh key is needed. Do not continue implementation yet.
This is a re-authentication, not first-time setup — the user already opted in, so "Continue without Traffic One" is intentionally NOT offered here (it is not a contradiction; it is the next step of the flow the user already chose).
Ask the user for their Traffic One API key, preferring a secure host input/modal. The hook re-authenticates internally and refreshes the key in your OS keychain; normal sessions refresh silently from the keychain with no prompt — you are only being asked now because that silent refresh repeatedly failed (an expired/rotated key, or the endpoint was unreachable).
You do NOT run any command: the host's security classifier blocks passing a secret to a shell script, so the hook (not you) completes the refresh and keychain update. Just ask for the key and STOP. Do not run `traffic-one-auth.cjs`, do not Write or Edit `auth.json`, do not echo the key, and do not ask the user to run shell commands.
{{MCP_TOOL_WARNING}}
<!-- T1BLOCK:END session-expired -->

<!-- T1BLOCK:BEGIN api-key-prompt -->
The user already chose to authenticate Traffic One, so this step only collects the key — "Continue without Traffic One" is intentionally NOT re-offered here because they opted in (this is the next step of that choice, not a contradiction). Do not continue implementation yet.
Ask the user for the Traffic One API key, preferring a secure host input/modal. The hook then authenticates it internally and stores it in your OS keychain; from then on the session refreshes silently from the keychain with no further prompts.
You do NOT run any command: the host's security classifier blocks passing a secret to a shell script, so the hook (not you) mints the session and stores the key in the keychain. Just ask for the key and STOP. Do not run `traffic-one-auth.cjs`, do not Write or Edit `auth.json`, do not echo the key, and do not ask the user to run shell commands.
{{MCP_TOOL_WARNING}}
<!-- T1BLOCK:END api-key-prompt -->

<!-- T1BLOCK:BEGIN continue-without -->
The user chose to continue without using the Traffic One plugin.
Proceed with the user request using normal non-Traffic-One behavior only.
Do not run Traffic One skills, onboarding, setup, reporting, materialization, agents, or hooks for this request.
<!-- T1BLOCK:END continue-without -->

<!-- T1BLOCK:BEGIN remembered-yes -->
This choice has been remembered for this project so the auth prompt is not repeated here while it remains active.
<!-- T1BLOCK:END remembered-yes -->

<!-- T1BLOCK:BEGIN remembered-no -->
This choice could not be persisted, so the auth prompt may repeat until Traffic One auth-choice storage is writable.
<!-- T1BLOCK:END remembered-no -->

<!-- T1BLOCK:BEGIN login-failed -->
Traffic One authentication failed while running the internal login/status flow.
Reason: {{REASON}}
Ask the user to re-enter the API key. Do not echo the key and do not ask the user to run shell commands.
<!-- T1BLOCK:END login-failed -->

<!-- T1BLOCK:BEGIN login-success -->
Traffic One authentication completed internally; the API key is stored in your OS keychain and the session will refresh from it silently — no further auth prompts unless that silent refresh repeatedly fails.
Continue the user request with Traffic One enabled.
<!-- T1BLOCK:END login-success -->
