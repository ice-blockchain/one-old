---
name: traffic-one-doctor
description: PROACTIVELY diagnose traffic-one setup issues — Node version, nvm install state, gitnexus binary location + crash risk, `.nvmrc` mismatches, `.git/` status, stale `.gitnexus/` / `graphify-out/` artefacts, and `.traffic-one.json` integrity. TRIGGER when the user says "diagnose traffic-one", "traffic one doctor", "the graph isn't working", "gitnexus isn't running", "why doesn't the graph generate", "check my setup", "/doctor", "what's wrong with my graph", "check my traffic-one install", "audit my setup". Read-only — never installs anything, never modifies the project. Produces a structured report with severity-tagged findings + exact remediation commands.
---

# traffic-one Doctor

Proactive diagnostic for the most common traffic-one setup issues. Read-only:
emits a report; never installs, never modifies, never deletes.

## When to trigger

- "diagnose traffic-one", "traffic one doctor", "/doctor", "check my setup".
- "the graph isn't working", "gitnexus isn't running", "why doesn't `.gitnexus/`
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
4. **Project** — `.traffic-one.json` state, `.nvmrc`, `.git/` presence,
   `.gitnexus/` and `graphify-out/GRAPH_REPORT.md` artefact ages.

It outputs a JSON report with one of three summaries:

- `HEALTHY` — no findings; the user's setup is good.
- `INFO_ONLY` — informational findings; nothing actionable but worth knowing.
- `ACTION_NEEDED` — at least one finding requires a fix.

Each finding has `severity`, `code` (machine-readable), `message`, and
sometimes a `recommendedCommand`.

## How to invoke

Run from the project root:

```bash
node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/doctor.cjs"
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

| Code | Meaning | Auto-fix? |
| --- | --- | --- |
| `NODE_LT22_BUT_V22_AVAILABLE` | Active Node is <22 but nvm v22 is installed. Runner uses absolute v22 path, no action needed. | n/a (info) |
| `NVM_INSTALLED_NO_V22` | nvm present but no Node 22. `recommendedCommand` is the single-line install. | Yes, via Bash tool |
| `NO_NVM_NO_V22` | No nvm at all. User installs nvm manually, or switches to `graphify`. | No (user installs nvm) |
| `GITNEXUS_IN_OLD_NVM_NODE` | gitnexus on PATH lives in old nvm Node folder → will crash. Reinstall against Node 22. | Yes, via Bash tool |
| `NVMRC_PINNED_TO_OLD_NODE` | Project `.nvmrc` < 22 while provider is gitnexus → overwrite `.nvmrc` with `22`. | Yes, via Write tool |
| `NO_GIT_DIR` | No `.git/` at project root. Runner handles via `--skip-git`; informational. | n/a (info) |
| `GITNEXUS_STALE` | `.gitnexus/` older than 7 days. Next build refreshes it. | Optional |
| `LAST_RUN_FAILED` | Most recent runner stamp shows an error. Surface the message and pair with other findings. | Depends |
| `MISSING_CODE_GRAPH_PROVIDER` | `.traffic-one.json` missing the field. Re-run onboarding. | Via `stack-setup` |

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
- Never modify `.traffic-one.json` directly from this skill; route field
  changes through `stack-setup`.
- Never delete `.gitnexus/`, `.traffic-one/backups/`, or any project file.
- Never share the user's filesystem layout to a remote endpoint.
