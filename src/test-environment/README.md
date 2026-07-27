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

# Production release gate: drive host CLIs end-to-end, prove the current dist at
# runtime, and fail on FAIL, SKIP, or INCONCLUSIVE (real LLM spend).
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
| `--no-build` / `--no-install` | Skip refreshing `dist` / updating hosts (e2e only). `--no-install` cannot pass Codex's staged-marketplace proof; Claude/OpenCode/Kilo use session/per-case proof. |
| `--concurrency=N` | Parallel case workers. **Keep at 1** unless you understand the env-isolation note below. |
| `--timeout=900000` | Per host-e2e case timeout (ms). |
| `--auth=on\|off` | Auth gate. Harness default `off`; production defaults to enforced. |
| `--strict` | Treat SKIP/INCONCLUSIVE/UNSUPPORTED as failure for the exit code; a strict run cannot certify an unexercised host capability. |
| `--manual-cert-dir=/abs/path` | Load selected manual-host records named `<host>-manual-e2e.json`. The directory must be absolute. |
| `--runs-dir=<path>` | Override where run folders are created (default `~/traffic-one-test-runs`). Must be **outside** this repo. |
| `--reassert=<runDir>` | Re-evaluate a prior run's assertions against its **persisted** projects — no host calls, no token spend. For iterating on assertions or re-scoring a timed-out run. |
| `--dry-run` | Print the plan and exit. |

> Flags use the `key=value` form (e.g. `--reassert=/abs/path`, `--case=np-frontend-only`); a space-separated value won't parse, and `~` isn't expanded — pass absolute paths.

### Dedicated live enforcement probes

Ordinary build/edit cases are not preventive-enforcement evidence. The release
matrix therefore includes three small, isolated cases:

- `enf-primary-pretool-deny` asks Claude, Codex, and Cursor to make exactly one
  runtime-owned write. It passes only when the valid per-run
  `HostCapabilityV1` sidecar records a real deny at that host's primary
  before-tool point and the target file is absent.
- `enf-claude-child-bootstrap` requires live `native-bootstrap` and
  `SubagentStart` observations from one read-only quick-fix child.
- `enf-codex-first-tool-model` requires `SubagentStart` plus a
  `first-tool-model-check` entry emitted specifically by
  `verified-child-model-gate`. The requested spawn model alone is not evidence.

Run just these proofs in fresh projects:

```bash
npm run test:env:e2e -- \
  --host=claude,codex,cursor \
  --case=enf-primary-pretool-deny,enf-claude-child-bootstrap,enf-codex-first-tool-model \
  --strict
```

The current unattended command config explicitly declares headless subagents
unsupported for Claude/Codex/Cursor. A host that really exposes the child tool
can still pass by emitting the required live evidence; otherwise the child
probe reports `UNSUPPORTED`, which fails strict certification. Cursor also
cannot be prevention-certified from the primary deny alone: its contract still
requires live `beforeShellExecution`, `beforeReadFile`, and
`beforeMCPExecution` observations. Until a reproducible local MCP fixture and a
scriptable current-plugin install replace Cursor's editor-only `/add-plugin`
pointer, those missing points remain a reported certification gap, never a
synthetic pass.

Codex release runs never reuse the maintainer's plugin selection or hook trust.
The harness creates a marked `0700` `CODEX_HOME`, copies auth as `0600`,
installs only the content-addressed staged plugin, verifies the model-visible
selection, checks all staged hook keys/hashes/source paths against the ABI
fixture, persists trust only in that disposable home, and re-lists every hook
as trusted before `codex exec`. The run uses no hook-trust bypass. Exact-profile,
marketplace, plugin, and home cleanup is fail-closed.

### Manual host certification

OpenCode, Kilo, Copilot, and Windsurf are classified by
`HOST_CAPABILITIES` as `contract+manual-e2e`. The release harness does not
schedule or install those hosts as unattended E2E targets. When one is selected,
its release evidence comes from
`<manual-cert-dir>/<host>-manual-e2e.json`. In strict mode, missing, malformed,
stale-fingerprint, `FAIL`, and unwaived `NOT_RUN` records fail the release.
Claude, Codex, and Cursor remain the ordinary automated defaults and do not
require manual records.

Build the exact release bytes and print their stable, pre-runtime-proof
fingerprint before installing that `dist` in the host:

```bash
npm run plugin:build
npx tsx -e "import { distTreeFingerprint } from './src/test-environment/core/current-dist'; console.log('sha256:' + distTreeFingerprint('./dist'))"
```

Capture the real host version, exact installation steps and prompt, and save the
resulting evidence files beneath one absolute certification directory. Persist
the final record through the existing atomic writer (temp file + rename), for
example from a short maintainer script:

```ts
import { writeManualHostCertification } from './src/test-environment/manual-host-certification';

writeManualHostCertification('/absolute/release-certifications', {
  schemaVersion: 1,
  host: 'copilot',
  hostVersion: '1.2.3',
  installedPluginFingerprint: '<paste exact sha256:... output from command above>',
  installSteps: [
    'Install /absolute/path/to/dist in GitHub Copilot',
    'Restart the host and confirm the Traffic One plugin is enabled',
  ],
  prompt: 'Create a small route, then show the Traffic One enforcement result.',
  artifactPaths: [
    'copilot/transcript.json',
    'copilot/project.tar',
  ],
  result: 'PASS',
  executedAt: '2026-07-27T12:00:00.000Z',
  notes: '',
});
```

For `PASS`, every artifact path must name an existing regular file beneath the
certification directory; absolute paths, traversal, and symlinks are rejected.
To certify preventive enforcement, include the copied per-run sidecar using its
project-relative shape, for example
`copilot/project/.traffic-one/runs/<run-id>/host-capability-v1.json`. The report
reads and validates that sidecar; it never promotes the static registry's
`pre-tool` expectation into observed proof. Certification requires both complete
required-hook coverage and a real `deny` pipeline outcome at the primary
blocking point. A valid sidecar with invocation-only coverage reports
`completion-only` and `Prevention certified: NO`.
Child-model observation is a separate field: only Codex currently reports
`first-tool-authoritative`; the other hosts report `spawn-request-only` and
must not be described as having verified the model that actually executed.
Transcripts, PASS, or a waiver can still certify the documented manual E2E
outcome, but cannot certify pre-write prevention without this observed evidence.
Use `result: 'FAIL'` for a completed failure. Use `result: 'NOT_RUN'`,
`executedAt: null`, and `artifactPaths: []` when it was not executed. A
`NOT_RUN` can certify only with a complete maintainer waiver:

```json
"waiver": {
  "approvedBy": "maintainer@example.com",
  "reason": "Host unavailable in the release environment",
  "approvedAt": "2026-07-27T12:00:00.000Z"
}
```

Consume the records with the strict release harness:

```bash
npm run test:env:e2e -- --host=opencode,kilo,copilot,windsurf --manual-cert-dir=/absolute/release-certifications
```

A host-e2e build runs the **full senior-engineer team** when the case seeds
`performance: balanced/high` (architect → frontend → backend → reviewer → tester),
so it can take 15–30 min and may hit `--timeout`. A `TIMEOUT` is not a failure:
assertions still evaluate the partial project (materialization, files), and a
cut-off missing file is reported `INCONCLUSIVE`, never `FAIL`. Output uses
`stream-json`, so a killed run still leaves a partial transcript in `stdout.log`.
To re-score a timed-out run after it persisted, use `--reassert=<runDir>`. The
production `test:env:e2e` script is strict, so any resulting `INCONCLUSIVE`
assertion still makes the release gate fail.

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
  (`{PROMPT} {MODEL} {CWD} {OUTPUT_FORMAT} {DIST} {PROMPT_FILE}` plus
  `{MARKETPLACE_ROOT} {MARKETPLACE}` for staged install commands), so a flag fix
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
  subagents in a headless `-p`/`exec` session. A host explicitly declaring this
  limitation reports `digests-terminal` / `run-manifest-roles` as `UNSUPPORTED`
  only after a completed host run that never activated a run id; strict releases
  fail because the required capability was not exercised. Once a run id or artifact exists,
  missing digests/manifests remain `INCONCLUSIVE` and a manifest missing a seeded
  frontend/backend implementer assignment is `FAIL`. Unknown support, timeouts,
  partial manifests, contradictions, and every ordinary `INCONCLUSIVE` remain
  strict failures.
- **Host content freshness**: `--e2e` runs `npm run plugin:build`. Claude and
  Codex receive byte-level freshness proof rather than trusting install status.
  The harness temporarily injects a unique, hard-coded token writer into each
  selected compiled hook entrypoint and restores `dist` byte-for-byte afterward;
  every host case must receive that exact token from the expected entrypoint.
  A stale same-version cache cannot copy the current expected token from the
  environment, and host subprocesses never inherit checkout/plugin-root overrides.
  Claude excludes user plugin settings and loads the selected `dist` directly
  with `--plugin-dir`, bypassing its version cache. Codex copies `dist` into a
  unique, content-addressed marketplace under `<runs-dir>/.marketplaces`, gives
  the staged plugin a hash-derived cache version, installs it with hook-trust
  bypass enabled only inside the isolated harness workspace, then removes only
  that exact E2E plugin/marketplace after validating its marker and containment.
  Hosts classified `contract+manual-e2e` are represented by the stable
  fingerprint-bound records above, never by invented unattended commands.
  Cursor remains the sole automated-host manual live-pointer exemption because
  `/add-plugin` is editor-only, but its compiled Cursor entrypoint must emit the
  same unique token; a missing or stale pointer therefore fails even when a
  generic model could complete the requested edit without Traffic One.
