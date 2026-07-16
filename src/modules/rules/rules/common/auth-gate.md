---
description: "Always apply before Traffic One onboarding, materialization, reporting, agent orchestration, or implementation work."
# Always loaded
---

# Traffic One Authentication Gate

The durable per-project `pluginUse` choice is evaluated first, before onboarding
or authentication. If the user declines Traffic One, every Traffic One hook
stands down for that project until the user explicitly enables it again. This is
the only "continue without Traffic One" mechanism.

After an opt-in, authentication belongs exclusively to the local setup wizard.
When canonical auth is missing or invalid, the wizard opens directly on its API
key step and Traffic One mutation remains gated. Do not ask for the key in chat,
show a host auth modal, pass it through a shell command, or edit auth state
manually.

The wizard validates the submitted key with an authenticated MCP `tools/list`
request. A rejected or unreachable validation writes nothing. A successful
validation stores the sole auth record in the top-level `auth` section of the
user-level `one.json` (`$TRAFFIC_ONE_STATE_PATH`,
`$XDG_STATE_HOME/traffic-one/one.json`, or `~/.traffic-one/one.json`). The file
must remain mode `0600` and must never be copied into the project, docs, prompts,
commits, or generated artifacts.

The stored API key is also sent as the Bearer token for the background report.
If reporting returns 401 or 403, delete only `one.json.auth`, preserve all other
settings, and reopen the wizard on the API-key step.

Valid canonical auth is the first gate-clear condition in
`rules/common/setup-gate.md`. Some hosts have rule-level enforcement only.
