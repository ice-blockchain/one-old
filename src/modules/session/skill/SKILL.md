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
Traffic One is inactive for this prompt because authentication is missing, expired, or rejected.

Your next assistant action must present a host modal selector with exactly two choices when a modal/popup tool is available:

Question: Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin?
Choices:
- Authenticate Traffic One (Recommended)
- Continue without Traffic One

If the user chooses Authenticate Traffic One, ask for the Traffic One API key (use a secure host input/modal) and then STOP and wait. When the user pastes the key, Traffic One authenticates it automatically inside the hook (it runs login + status internally). Do NOT run `traffic-one-auth.cjs` or any auth command yourself via Bash/shell — Claude Code's security classifier blocks passing a key to a script, and the hook already performs the login. Do not Write or Edit `auth.json` directly, do not echo the key, and do not ask the user to run shell commands.
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

If Authenticate Traffic One is chosen, ask for the API key (secure input) and STOP. When the user pastes the key, Traffic One authenticates it automatically inside the hook — do NOT invoke `traffic-one-auth.cjs` or any auth command via Bash/shell yourself (Claude Code's security classifier blocks passing a key to a script; the hook runs login + status internally). Do not Write/Edit `auth.json` directly, and do not ask the user to run bash or shell commands.
{{MCP_TOOL_WARNING}}
If Continue without Traffic One is chosen, remember the choice for this project and continue the request using normal non-Traffic-One behavior only.

Do not inspect, scaffold, install, edit, or build before the user answers this auth choice.
<!-- T1BLOCK:END pre-tool-deny -->

<!-- T1BLOCK:BEGIN session-expired -->
Your Traffic One session has expired. Do not continue implementation yet.
This is a session refresh, not first-time setup — the user already authenticated, so only a fresh API key is needed. Do not offer "Continue without Traffic One" here.
Ask the user for their Traffic One API key using a secure host input/modal if available.
After the user provides the key, re-authenticate internally, store the API key in the OS credential manager when available, and verify status internally.
Automatically means: when the user pastes the key, Traffic One authenticates it inside the hook (login + status run internally). Do NOT invoke `traffic-one-auth.cjs` or any auth command via Bash/shell yourself — Claude Code's security classifier blocks passing a key to a script. Just ask for the key and STOP; the hook completes the refresh. Do not Write or Edit `auth.json` directly.
{{MCP_TOOL_WARNING}}
Do not ask the user to run bash or shell commands. Do not echo the key back to the user.
Tip: after a successful login, the OS credential manager is the silent-refresh path.
<!-- T1BLOCK:END session-expired -->

<!-- T1BLOCK:BEGIN api-key-prompt -->
The user chose to authenticate Traffic One. Do not continue implementation yet.
Ask the user for the Traffic One API key using a secure host input/modal if available.
After the user enters the key, run authentication internally, store the API key in the OS credential manager when available, and verify status internally.
Automatically means: when the user pastes the key, Traffic One authenticates it inside the hook (login + status run internally) — you do NOT run any command. Do NOT invoke `traffic-one-auth.cjs` or any auth command via Bash/shell yourself: Claude Code's security classifier blocks passing a key to a script, and the hook already mints the session. Just ask for the key and STOP. Do not Write or Edit `auth.json` directly.
{{MCP_TOOL_WARNING}}
Do not ask the user to run bash or shell commands. Do not echo the key back to the user.
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
Traffic One authentication completed internally and status reports authenticated.
Continue the user request with Traffic One enabled.
<!-- T1BLOCK:END login-success -->
