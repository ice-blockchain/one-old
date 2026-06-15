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
5. **Codex/MCP activation** — plugin enabled flag, trusted hook state, trusted
   workspace coverage, and whether `mcp-auth` is configured.
6. **Session incident debug** — with `--session <id>`, resolves the Codex JSONL
   transcript and reports hook payload count, prompt requests, Traffic One root
   instruction injection, auth expiry at session start, and mutating tool use
   before the auth gate.

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

In Codex, prefer `TRAFFIC_ONE_PLUGIN_ROOT` or `CODEX_PLUGIN_ROOT` when the
host exposes one. If no plugin-root env var is available, use the absolute
plugin root that contains this `SKILL.md`.

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
