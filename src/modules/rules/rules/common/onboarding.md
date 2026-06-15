---
description: "Apply during first-time Traffic One project setup: onboarding questions, answer handling, and setup-gate order."
# Always loaded
---

# Traffic One Onboarding

Onboarding now runs in a **local setup wizard**, not in chat. When a project needs
setup, the Traffic One hooks launch a small local server and surface its URL (plus a
short "setup pending" note); the wizard collects every choice, installs the tools it
needs with a progress indicator, and writes `.traffic-one/.one.json` plus the
per-user local preferences itself. The SessionStart hook reads that file to inject the
matching rule bundle, and the PostToolUse hook (`scripts/hook-runtime.cjs
post-stack-setup`) materializes project-local rules/skills the moment the file is
written — no session restart required. The setup gate (`rules/common/setup-gate.md`)
defines when work is blocked; project routing (`rules/common/project-routing.md`)
defines mode/stack detection.

## What the agent does

- **Do not ask onboarding questions in chat, and do not write `.traffic-one/.one.json`
  yourself.** The wizard owns the questions (OpenCode delegation, performance / agent
  mode, team confirmation, project context, mobile, code graph) and the state writes.
  Pointing the user at the wizard URL is the only onboarding action.
- While setup is incomplete the onboarding gate denies mutating tools with the wizard
  URL (gate-clear conditions and the read-only-orientation allowance live in
  `rules/common/setup-gate.md`). Surface the URL, let the user finish in their browser
  (inline where the host supports it), then continue the original request — Traffic One
  picks up where you left off.
- Do not tell the user to restart the host. If the user prefers not to use Traffic One,
  they choose "Continue without Traffic One" from the auth prompt.

## Reconfigure / existing projects

- **Mid-project reconfigure** ("switch stack", "change stack", "reconfigure", "redo
  setup"): the wizard reopens showing only the pieces that still need a decision;
  preserve `mode`.
- **Existing project, first session**: the SessionStart hook detects the stack from
  `package.json` deps + workspace config and writes `.traffic-one/.one.json` without
  new-project Q&A. A returning project that is missing *this* user's local preferences
  reopens the wizard for just those steps.
