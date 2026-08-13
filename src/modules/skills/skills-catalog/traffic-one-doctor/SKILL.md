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

Runs `scripts/doctor.cjs`. Every invocation described here is read-only — it
never writes to the project, never installs anything, never edits state. (The
one exception is `--unblock`, the operator override: it is not yours to run, it
is refused unless a human confirms it at a real terminal, and it is not one of
the invocations the gates admit. See "Operator override" at the end.)

The script probes:

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
7. **Wedged run** — with `--run <id>`, reports every registered agent and held
   claim against its liveness window, the run ledger's raw/effective/canonical
   status, and the most repeated deny ids from that run's decision log. Stale
   agents, expired claims and a non-terminal run with nothing alive to advance
   it become `fix-needed` findings, so `summary` reflects the wedge instead of
   reading `HEALTHY`. A human-readable version of the same report, ending in a
   concrete next step, is printed to **stderr** — stdout stays pure JSON.
8. **Bug-report bundle** — with `--bundle`, emits a redacted state-only bundle
   instead of the plain report: probes, findings, the run diagnostic, and the
   last 300 decision-log verdicts. Prompt text, onboarding answers,
   credential-named values and decision-log `inputs`/`stateWrites` are removed;
   absolute filesystem paths are NOT, so read its own `redaction.policy` before
   pasting it anywhere public.

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

For a wedged run (why is this run stuck?):

```bash
node ~/.traffic-one/bin/doctor.cjs --run <run-id>
```

The run id is `currentRunId` in `.traffic-one/.one.json`, or any directory name
under `.traffic-one/runs/`. Parse stdout's `findings` for the `RUN_AGENT_STALE`,
`RUN_CLAIM_EXPIRED`, `RUN_STALLED_NO_LIVE_AGENT` and `RUN_DIR_MISSING` codes;
the stderr report is for the human.

For a bug report:

```bash
node ~/.traffic-one/bin/doctor.cjs --bundle
node ~/.traffic-one/bin/doctor.cjs --run <run-id> --bundle
```

`--bundle` alone bundles whichever run the project state currently points at;
add `--run <id>` to pin a different one. Show the user what it contains (it
includes absolute paths) and let them decide where it goes; never upload it.

These are the exact invocations Traffic One's own gates admit while a project is
mid-setup or mid-wedge — one `node`, one of these two paths, and at most one
recognized flag (plus `--run <id> --bundle`). A wrapper (`npx …`, `sh -c "…"`),
a redirect, a second chained command, or any other flag is treated as an
ordinary shell command and may be blocked by whatever gate is currently
holding the project.

Incident mode uses the resolved transcript's cwd even when the command is run
from the plugin root or another project. Without `--session`, run from the
project root whose setup should be checked.

`~/.traffic-one/bin/doctor.cjs` is the version-stable shim and the preferred
spelling: its path survives plugin updates, so a host's stored approval for it
keeps working. `<plugin-root>/scripts/doctor.cjs` also works when the shim has
not been written yet.

## Codex hook-trust activation and remediation

For Codex, a healthy installation currently has **16 trusted / 16 runnable**
Traffic One hooks. Never hardcode 16: the expected count is a fixed constant
compiled into the runner, not derived from `hooks/hooks.json`, so it changes
only when the plugin changes. Read the authoritative number for the installed
build out of Doctor's own JSON at
`probes.codexHooks.hookTrust.expectedCount`, and compare it with
`probes.codexHooks.hookTrust.counts`. If Doctor emits
`CODEX_TRAFFIC_ONE_HOOKS_NOT_TRUSTED`, reports
any other totals, or the review was only partially accepted, keep the summary at
`ACTION_NEEDED`; there is no supported degraded Traffic One mode.

Give the user this primary recovery flow:

1. Install or reinstall the current Traffic One build.
2. In Codex Desktop, open **Plugins → Traffic One → Hooks → Review** and inspect
   every displayed command. Compare every hook key and command with the
   installed `hooks/hooks.json` fixture.
3. Only if the count, keys, and commands match, ask the user to choose
   **Trust all**. If anything differs, do not trust the set; reinstall or update
   the current Traffic One build and review it again.
4. Reload if Desktop offers it or fully restart Desktop, then open a new task in
   a trusted project and rerun Doctor. Completion requires `HEALTHY` and
   `counts.trusted` = `counts.runnable` = `expectedCount`.

If Desktop cannot complete that flow, give this CLI fallback:

1. Fully quit Codex Desktop so it cannot write hook state concurrently.
2. Start `codex` from a trusted project, run `/hooks`, inspect every fixture
   entry, and approve only Traffic One — never unrelated plugin hooks.
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
     The onboarding hook installs a managed copy when the provider is
     selected — no user command needed.

  2. [info] NODE_LT22_BUT_V22_AVAILABLE
     Active Node is 20 but nvm v22 (v22.22.2) is installed. The runner
     uses the absolute v22 path; no action required.

Next step: none — both findings resolve themselves on the next hook run.
```

Always wait for user confirmation before running any `recommendedCommand` —
the Bash tool's permission prompt is the consent gate. Never invent one: a
finding without a `recommendedCommand` is not an invitation to propose a global
`npm install -g` / `pipx install`. Traffic One installs every managed tool into
`~/.traffic-one/toolchains/` itself, and a hand-run global install lands outside
that root, where uninstall cannot reach it.

## Operator override (`--unblock`) — not yours to run

When a gate refuses a tool call and the refusal can legitimately be lifted, the
deny text itself prints one command:

```bash
node ~/.traffic-one/bin/doctor.cjs --unblock <gate-id> --run <run-id>
```

That line is addressed to the **user**, not to you. Relay it if they are stuck
and ask; never run it yourself, and never propose it as a way past a refusal you
could instead fix. Four things are true about it and worth telling them plainly:

- It is refused unless a human runs it at a real terminal and types back a code
  it prints, so a tool call carrying it fails — that is the design, not a bug.
  It is also the one doctor invocation the gates do not admit, for the same
  reason.
- It switches ONE gate off for ONE run, for 30 minutes by default. Add
  `--ttl 90m` (or `2h`, `45s`) to pick another window, up to a 24h ceiling.
- The run then becomes **permanently ineligible** for `verified`/`shipped`, even
  after the override expires. It is the emergency exit, not a step in the loop.
- The gate id and run id are the ones the refusal itself names; do not guess
  them.

If Doctor reports `OPERATOR_OVERRIDE_ACTIVE`, say so in your summary: the rest of
the report describes a project with one gate switched off. If it reports
`OVERRIDE_LEDGER_UNVERIFIED`, relay it verbatim — nothing is being let through by
those lines, but somebody should know why they are there.

## Must-not-do

- Never mint an operator override (`--unblock`), and never ask the user to mint
  one, to get past a gate that is refusing your own work. Fix the cause the
  deny names.
- Never auto-run `npm install` / `nvm install` / `git init` without explicit
  user approval in this turn.
- Never modify `.traffic-one/.one.json` directly from this skill; route field
  changes through onboarding (`rules/common/onboarding.md`).
- Never delete `.traffic-one/.gitnexus/`, `.traffic-one/backups/`, or any project
  file. (`.traffic-one/backups/` is capped by the retention policy's `backupKeep`
  on every bootstrap, so it does shrink on its own — that is the runtime's
  policy, not an invitation for this skill to prune it.)
- Never share the user's filesystem layout to a remote endpoint.
