---
# Always loaded
---

# Traffic One Setup Gate

Traffic One hooks are the source of truth for setup gating. They resolve the
actual target project root, merge shared `.traffic-one/.one.json` with the
current user's local preferences, and surface the next required host prompt
before implementation.

The per-project `pluginUse` decision is evaluated before this gate. If it is
declined, Traffic One stands down completely. If it is enabled, every condition
below must be clear before Traffic One mutates the project:

- Canonical wizard API-key auth is valid.
- Shared project state exists at the resolved target root and has
  `onboardingComplete: true`.
- The current user's local preferences for that target root contain
  `openCode` and `performance`/`team`, and the machine-wide `codeGraphProvider`
  setting is present.
- Balanced/High performance has explicit Team Confirmation with
  `team.approved: true`.
- New projects have completed the new-project-only `projectContext` and Mobile
  App prompts; existing projects skip those two prompts and preserve the
  detected architecture.

If the gate reports missing auth or local preferences, surface the onboarding
wizard and let it ask only the next missing step. Existing-project order is
OpenCode, Performance, Team Confirmation for Balanced/High, then Code Graph.
New-project order is OpenCode, Performance, Team Confirmation for
Balanced/High, project context, Mobile App, then Code Graph.

Read-only orientation is allowed while preferences are missing. Feature writes,
dependency installs, scaffolding, materialized implementation skills, and
subagent work must wait until the hook/gate context is clear. Never auto-pick
defaults and never store local-only fields in shared `.traffic-one/.one.json`;
hooks split `openCode`, `performance`, `team`, `toolchain`, and graph runner
stamps into `~/.traffic-one/projects/<hash(targetRoot)>/preferences.json`, while
`codeGraphProvider` is a machine-wide setting in `~/.traffic-one/one.json`
(reused across projects).
