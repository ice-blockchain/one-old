---
# Always loaded
---

# Traffic One Authentication Gate

Traffic One must be authenticated with `mcp-auth` before any Traffic One
onboarding, materialization, reporting, project setup, agent orchestration, or
feature implementation work.

The first Traffic One action in a fresh install is a host modal selector with
two choices: Authenticate Traffic One (Recommended) or Continue without Traffic
One. If the user chooses Authenticate Traffic One, ask for the API key and run
the auth client internally with `TRAFFIC_ONE_AUTH_KEY`; then verify status
internally.
Do not ask the user to run shell commands. `logout` removes the local session
token. When a stored session expires, the auth client may call `refresh`
internally with `TRAFFIC_ONE_AUTH_KEY` if the key is available in the current
process environment. If refresh fails or the key is unavailable, keep Traffic
One gated and ask the user to authenticate again.

Do not place API keys, session tokens, or copied bearer tokens in project files,
`.traffic-one/`, `.traffic-one/.one.json`, prompts, docs, commits, or generated
artifacts. The auth client stores only a short-lived session token in user-level
state (`$TRAFFIC_ONE_AUTH_STATE_PATH`, `$XDG_STATE_HOME/traffic-one/auth.json`,
or `~/.traffic-one/auth.json`).

Codex and Claude Code call remote `auth_status` at every new session start and
again at most once per day during ongoing sessions. When auth is missing,
expired, or rejected remotely, show the modal selector and keep Traffic One
inactive. If the user chooses Continue without Traffic One, remember that choice
for the project/session and do not repeat the auth prompt while it remains
active. Do not continue a pending Traffic One onboarding answer, materialize
project files, run Traffic One skills, spawn Traffic One agents, report to MCP,
or perform Traffic One-guided implementation until auth is valid again. Continue
the user's request without Traffic One features when the request is actionable
outside Traffic One. Cursor has rule-level enforcement only.
