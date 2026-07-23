---
name: traffic-one-doctor
description: PROACTIVELY diagnose traffic-one setup. TRIGGER on "/traffic-one-doctor", "/doctor", "diagnose traffic-one", "check my setup", "the graph isn't working", "why isn't X working", or a Codex session id. Read-only health check emitting severity-tagged finding codes + fix commands; never installs or modifies.
---

# traffic-one Doctor

Proactive diagnostic for the most common traffic-one setup issues. Read-only:
emits a report; never installs, never modifies, never deletes.

## When to trigger

- "diagnose traffic-one", "traffic one doctor", "/doctor", "check my setup".
- "the graph isn't working", "gitnexus isn't running", "why doesn't `.traffic-one/.gitnexus/`
  get created", "what's wrong with my graph".
- After a `pnpm build` where the post-build banner reported a gitnexus error.
- After installing/reinstalling Node, nvm, gitnexus.

## Skip when

- The user is asking about feature code (UI/API/DB). This skill is purely about
  the traffic-one *toolchain*, not the code it analyses.
- The active provider is `graphify` and the artefact already exists fresh.

## What it does

Runs `scripts/doctor.cjs` (read-only). The script probes:

1. **Node** — running major version, the `node` binary on PATH, the GitNexus
   minimum (22).
2. **nvm** — installed? default alias? installed Node versions? is there a
   `~/.nvm/versions/node/v22.*` folder?
3. **gitnexus** — binary on PATH, absolute v22 path, **crash-risk flag**
   (binary lives inside an old nvm Node folder → will crash with
   `SyntaxError: Cannot use import statement`).
4. **Project** — `.traffic-one/.one.json` state, `.nvmrc`, `.git/` presence,
   `.traffic-one/.gitnexus/` and `.traffic-one/graphify-out/GRAPH_REPORT.md` artefact ages.
5. **Codex/auth activation** — plugin enabled flag, trusted hook state, trusted
   workspace coverage, and a redacted canonical-auth probe reporting the
   `one.json` path, validity, and update time without exposing the API key.
6. **Session incident debug** — with `--session <id>`, resolves the Codex JSONL
   transcript, anchors the project/trust probes to that session's recorded cwd,
   and reports attributable Traffic One hook-output evidence, structured prompt
   and permission decisions, plus total and mutating tool calls. A missing-output
   finding is informational because applicable hooks may intentionally no-op.

It outputs a JSON report with one of three summaries:

- `HEALTHY` — no findings; the user's setup is good.
- `INFO_ONLY` — informational findings; nothing actionable but worth knowing.
- `ACTION_NEEDED` — at least one finding requires a fix.

Each finding has `severity`, `code` (machine-readable), `message`, and
sometimes a `recommendedCommand`.

## How to invoke

Run from the project root:

```bash
node ~/.traffic-one/bin/doctor.cjs
```

For a specific Codex incident:

```bash
node ~/.traffic-one/bin/doctor.cjs --session <session-id>
```

Incident mode uses the resolved transcript's cwd even when the command is run
from the plugin root or another project. Without `--session`, run from the
project root whose setup should be checked.

In Codex, prefer `TRAFFIC_ONE_PLUGIN_ROOT` or `CODEX_PLUGIN_ROOT` when the
host exposes one. If no plugin-root env var is available, use the absolute
plugin root that contains this `SKILL.md`.

## Codex hook-trust activation and remediation

For Codex, a healthy installation has **15 trusted / 15 runnable** Traffic One
hooks. If Doctor emits `CODEX_TRAFFIC_ONE_HOOKS_NOT_TRUSTED`, reports
any other totals, or the review was only partially accepted, keep the summary at
`ACTION_NEEDED`; there is no supported degraded Traffic One mode.

Give the user this primary recovery flow:

1. Install or reinstall the current Traffic One build.
2. In Codex Desktop, open **Plugins → Traffic One → Hooks → Review** and inspect
   every displayed command. Compare all 15 hook keys and commands with the
   installed `hooks/hooks.json` fixture.
3. Only if the count, keys, and commands match, ask the user to choose
   **Trust all**. If anything differs, do not trust the set; reinstall or update
   the current Traffic One build and review it again.
4. Reload if Desktop offers it or fully restart Desktop, then open a new task in
   a trusted project and rerun Doctor. Completion requires `HEALTHY` and
   **15 trusted / 15 runnable**.

If Desktop cannot complete that flow, give this CLI fallback:

1. Fully quit Codex Desktop so it cannot write hook state concurrently.
2. Start `codex` from a trusted project, run `/hooks`, inspect the 15 fixture
   entries, and approve only Traffic One — never unrelated plugin hooks.
3. Exit the CLI, restart Desktop, open a new task in the trusted project, and
   rerun Doctor.

A partial selection, cancelling the review, or choosing **Continue without
trusting** is still `ACTION_NEEDED`. Traffic One has no hook-trust auto-approval,
and onboarding cannot activate or recover untrusted hooks because the hook that
starts onboarding is itself inactive. Do not suggest rerunning onboarding as a
hook-trust repair.

Parse the JSON. Walk findings in order. For each `severity: "fix-needed"`:

- If a `recommendedCommand` is present, surface it to the user and offer to run
  it via the Bash tool (the Bash permission prompt becomes consent).
- If only a message is present, relay the message verbatim.

For `severity: "info"`, surface a short summary — don't badger the user with
fixes that aren't needed.

## Known finding codes

The runner emits each finding's `code`, `severity`, `message`, and any
`recommendedCommand` at runtime — read them from the JSON output rather than
from a copy here (the canonical list lives in `scripts/doctor.cjs`). Auto-fixable
codes carry a `recommendedCommand`; relay info-only findings verbatim.

## Reply shape

Reply with a short status line + the actionable findings. Example:

```
traffic-one doctor — summary: ACTION_NEEDED

Findings:
  1. [fix-needed] GITNEXUS_IN_OLD_NVM_NODE
     `gitnexus` on PATH lives in old nvm Node folder; will crash on invoke.
     Fix: `npm install -g gitnexus` from a Node 22 shell.

  2. [info] NODE_LT22_BUT_V22_AVAILABLE
     Active Node is 20 but nvm v22 (v22.22.2) is installed. The runner
     uses the absolute v22 path; no action required.

Next step: shall I run `npm install -g gitnexus` via the Bash tool?
```

Always wait for user confirmation before running any `recommendedCommand` —
the Bash tool's permission prompt is the consent gate.

## Must-not-do

- Never auto-run `npm install` / `nvm install` / `git init` without explicit
  user approval in this turn.
- Never modify `.traffic-one/.one.json` directly from this skill; route field
  changes through onboarding (`rules/common/onboarding.md`).
- Never delete `.traffic-one/.gitnexus/`, `.traffic-one/backups/`, or any project file.
- Never share the user's filesystem layout to a remote endpoint.
