# Traffic One — Test Environment

A config-driven, multi-host test harness for the Traffic One plugin. It lives
entirely under `src/test-environment`, is **never compiled into `dist`** (it is
excluded in `tsconfig.build.json`), and runs via `tsx` from `package.json`.

## Run it

```bash
# Fast, free, fully deterministic (pure-Node layer only) — the default.
npm run test:env

# See the planned matrix + resolved host commands without running anything.
npm run test:env:dry

# Also drive host CLIs end-to-end (real LLM spend; builds dist + updates hosts first).
npm run test:env:e2e
```

> Node ≥ 22 is required (the repo's build + `tsx` need it). If your default
> `node` is older, run under nvm first: `nvm use 22`.

### Useful flags (pass after `--`)

| Flag | Effect |
| --- | --- |
| `--e2e` / `--all` | Include `host-e2e` cases (real host CLI runs). Off by default. |
| `--host=claude,codex` | Restrict which hosts e2e cases target. |
| `--category=feature-onboarding` | Restrict to one or more categories. |
| `--case=onb-balanced-modeloverride` | Run specific case ids. |
| `--verdict-host=claude\|codex\|cursor\|none` | Spawn a final "plugin tester" agent to write `verdict.md`. Default `none`. |
| `--no-build` / `--no-install` | Skip refreshing `dist` / updating hosts (e2e only). |
| `--concurrency=N` | Parallel case workers. **Keep at 1** unless you understand the env-isolation note below. |
| `--timeout=900000` | Per host-e2e case timeout (ms). |
| `--auth=on\|off` | Auth gate. Default `off` (shipped default is `AUTH_ENABLED=false`). |
| `--strict` | Treat SKIP/INCONCLUSIVE as failure for the exit code. |
| `--runs-dir=<path>` | Override where run folders are created (default `~/traffic-one-test-runs`). Must be **outside** this repo. |
| `--reassert=<runDir>` | Re-evaluate a prior run's assertions against its **persisted** projects — no host calls, no token spend. For iterating on assertions or re-scoring a timed-out run. |
| `--dry-run` | Print the plan and exit. |

> Flags use the `key=value` form (e.g. `--reassert=/abs/path`, `--case=np-frontend-only`); a space-separated value won't parse, and `~` isn't expanded — pass absolute paths.

A host-e2e build runs the **full senior-engineer team** when the case seeds
`performance: balanced/high` (architect → frontend → backend → reviewer → tester),
so it can take 15–30 min and may hit `--timeout`. A `TIMEOUT` is not a failure:
assertions still evaluate the partial project (materialization, files), and a
cut-off missing file is reported `INCONCLUSIVE`, never `FAIL`. Output uses
`stream-json`, so a killed run still leaves a partial transcript in `stdout.log`.
To re-score a timed-out run after it persisted, use `--reassert=<runDir>`.

### Where everything lands

Each run creates one self-contained, timestamped folder **outside the repo**
(default `~/traffic-one-test-runs/<timestamp>/`, plus a `latest` symlink to the
newest). All runs are kept — clear old ones manually. It can't live inside the
repo: the plugin's state writers no-op at the authoring root, so an in-repo
project would never get a `.one.json`.

```
~/traffic-one-test-runs/<timestamp>/
├── results.md        # human report
├── results.json      # structured results
├── verdict.md        # only if --verdict-host set
└── projects/
    └── <case>__<target>/
        ├── project/          # the LIVE project — .traffic-one/.one.json, src/, agent output
        ├── state/            # one.json snapshot + isolated preferences.json
        ├── xdg-state/        # isolated machine settings (codeGraphProvider, one-uid)
        ├── onboarding-sim.json   # flow-sim cases only
        ├── stdout.log/stderr.log # host-e2e runs only
        └── meta.json
```

## Two layers

- **`pure-node`** — no host CLI, no LLM spend, 100% deterministic. Seeds an
  authentic onboarded project (or drives the real wizard state machine via
  scripted answers) by reusing the plugin's own `src/` writers, then asserts on
  the resulting state + model resolution. This is the backbone and the default.
- **`host-e2e`** — drives a real host CLI headlessly against a seeded temp
  project and asserts on the produced artifacts (materialization, digests, run
  manifest, feature files). Opt-in via `--e2e`.

## How it stays isolated (and correct)

- Every case runs in a fresh `project/` dir inside its run folder, which lives
  **outside** the repo. The plugin's state writers no-op at the authoring root
  (the check walks up to `$HOME`), so a project inside the repo would silently
  write nothing. `case-runner` hard-errors if the project dir resolves inside it.
- Per-case env (`core/env.ts`): `TRAFFIC_ONE_PROJECT_PREFS_PATH` isolates prefs,
  `XDG_STATE_HOME` isolates machine settings (incl. `codeGraphProvider`),
  `TRAFFIC_ONE_ONBOARDING_NO_SPAWN=1` prevents the wizard popping,
  `TRAFFIC_ONE_PLUGIN_ROOT` points runtime scripts at the freshly built `dist`.
- The harness reuses `src/` functions in-process; those read `process.env`, so a
  case's env is applied around the in-process calls and restored after
  (`withCaseEnv`). This is why **concurrency defaults to 1** — raising it would
  race `process.env`.

## Extending

- **Add a case** → append a `Case` to the relevant file in `config/cases/*.cases.ts`
  (or add a new category file + one import in `config/cases/index.ts`). Declare
  the onboarding `preSeed`, the `layer`, the `prompt` (e2e), and the `assertions`.
- **Add an assertion** → drop a `*.assert.ts` in `assertions/` that
  `export const assertion: Assertion`. It is auto-discovered. Reuse the real
  `src/` helpers (`util.ts` exposes `effState`) so expected values track the plugin.
- **Add / fix a host** → edit `config/hosts.ts`. Commands are token templates
  (`{PROMPT} {MODEL} {CWD} {OUTPUT_FORMAT} {DIST} {PROMPT_FILE}`), so a flag fix
  needs no code change. Only `claude` is `verified: true`; **Codex and Cursor
  command shapes are DEFAULTS-TO-VERIFY** — confirm them before trusting e2e
  results on those hosts.

## Known limits

- **Host-e2e auth — use a headless token.** `claude -p` runs non-interactively
  and **cannot refresh an OAuth token**, so it 401s even when interactive `claude`
  works (and always when spawned from inside a Claude Code session). Fix once,
  no API key, uses your subscription:
  ```bash
  claude setup-token                  # mints a long-lived token (sk-ant-oat-...)
  export CLAUDE_CODE_OAUTH_TOKEN=...   # then run the harness in this shell
  ```
  The harness inherits the env var, so the spawned `claude` authenticates (works
  even nested). It warns when the token is missing. Auth failures are surfaced in
  the report (e.g. `host error: 401 Failed to authenticate`) and host-e2e
  assertions return SKIP, never false failures.
- **Headless multi-agent determinism**: the senior-engineer team may not spawn
  subagents in a headless `-p`/`exec` session. So `digests-terminal` /
  `run-manifest-roles` return `INCONCLUSIVE` (not `FAIL`) when no orchestrated
  run is found — the deterministic guarantees live in the pure-Node layer.
- **Host content freshness**: `--e2e` runs `npm run plugin:build` and re-installs
  via the marketplace. Claude caches by version, so to force fresh *content* bump
  the plugin version; `TRAFFIC_ONE_PLUGIN_ROOT` always points runtime scripts at
  the latest `dist`. Cursor is a live dir pointer — run `/add-plugin <dist>` once
  inside the editor (the harness can't script that and prints a reminder).
