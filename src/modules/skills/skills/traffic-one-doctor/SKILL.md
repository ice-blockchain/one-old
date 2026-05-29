---
name: traffic-one-doctor
description: PROACTIVELY diagnose traffic-one setup issues — Node version, nvm install state, gitnexus binary location + crash risk, `.nvmrc` mismatches, `.git/` status, stale `.gitnexus/` / `graphify-out/` artefacts, `.traffic-one/.one.json` integrity, mcp-auth configuration, Codex hook trust, and specific Codex session ids where hooks may not have run. TRIGGER when the user says "diagnose traffic-one", "traffic one doctor", "the graph isn't working", "gitnexus isn't running", "why doesn't the graph generate", "check my setup", "/doctor", "what's wrong with my graph", "check my traffic-one install", "audit my setup", or gives a Codex session id to debug. Read-only — never installs anything, never modifies the project. Produces a structured report with severity-tagged findings + exact remediation commands.
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
4. **Project** — `.traffic-one/.one.json` state, `.nvmrc`, `.git/` presence,
   `.gitnexus/` and `graphify-out/GRAPH_REPORT.md` artefact ages.
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
node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/doctor.cjs"
```

For a specific Codex incident:

```bash
node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/doctor.cjs" --session <session-id>
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
| `MISSING_CODE_GRAPH_PROVIDER` | `.traffic-one/.one.json` missing the field. Re-run onboarding. | Via onboarding (`rules/common/onboarding.md`) |
| `CODEX_TRAFFIC_ONE_PLUGIN_DISABLED` | Codex config does not enable the Traffic One plugin, so hooks will not run. | No (user enables plugin) |
| `CODEX_TRAFFIC_ONE_HOOKS_NOT_TRUSTED` | Codex hook trust records are missing, disabled, or missing trusted hashes. | No (user re-trusts hooks) |
| `CODEX_WORKSPACE_UNTRUSTED` | Current workspace is outside trusted Codex project roots, so hooks may be skipped. | No (user trusts workspace/parent) |
| `CODEX_SESSION_NOT_FOUND` | `--session` id was not found in `~/.codex/sessions`. | No |
| `CODEX_HOOKS_NOT_INVOKED_FOR_SESSION` | The transcript has no hook payloads or prompt requests. Hooks likely did not run in that session. | No (restart/trust workspace) |
| `TRAFFIC_ONE_INSTRUCTIONS_NOT_INJECTED` | The transcript's session-start instructions did not include Traffic One root instructions. | No (plugin/host activation) |
| `TRAFFIC_ONE_AUTH_EXPIRED_AT_SESSION_START` | Local auth state was expired before the debugged session started. A working hook should have prompted. | Via auth flow |
| `SESSION_MUTATED_BEFORE_TRAFFIC_ONE_AUTH_GATE` | A mutating tool was used before any Traffic One auth gate appeared. Treat artifacts from that session as non-Traffic-One output. | Review manually |

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
- Never delete `.gitnexus/`, `.traffic-one/backups/`, or any project file.
- Never share the user's filesystem layout to a remote endpoint.
