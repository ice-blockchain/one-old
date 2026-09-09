# traffic-one — AI Agent Plugin

Enforces React, Ionic/Capacitor mobile packaging, explicit React Native, modern
design quality, security, post-deploy observability, and clean code
**automatically on every prompt**.
No slash commands required. Compatible with **Claude Code**, **Codex CLI**, **Cursor**,
**GitHub Copilot CLI**, **VS Code Copilot**, **OpenCode**, **Kilo**, and
**Windsurf / Devin Desktop Cascade**.

Traffic One is MIT licensed. These documents ship with the plugin and are next
to this one in the installed bundle:

| Document | What it answers |
|----------|-----------------|
| `LICENSE` | The MIT licence text |
| `THIRD-PARTY-NOTICES.md` | What Traffic One ships, builds with, and installs on your machine — including the one tool whose licence is **not** open source |
| `PRIVACY.md` | What leaves your machine, what is written to disk, and what lands in your git repository |
| `PLATFORMS.md` | Which hosts, Node versions and operating systems are actually supported, and how each is proven |
| `KNOWN-ISSUES.md` | Limitations of this release you can hit in normal use, with workarounds |
| `SUPPORT.md` | The runbook: symptom → diagnostic → fix |

`CHANGELOG.md` is generated from git history (`npm run changelog`) and grouped
by how a change reaches you — agent-visible content, deny prose, or runtime. It
lives in the source repository rather than the bundle: it is a record of the
past, and every other document here describes the build you have.

---

## First action: choose whether to use Traffic One

Before onboarding starts, Traffic One asks in the host chat whether the user
wants to use the plugin for that project. The answer is stored as the durable
per-project `pluginUse` preference outside the repository. A decline leaves the
project untouched and makes every Traffic One hook stand down until the user
explicitly asks to enable it again.

After an opt-in, the local setup wizard opens. If this machine is not yet
authenticated, the wizard's first and only unresolved step is the Traffic One
API key. The wizard validates the key through an authenticated MCP `tools/call`
request on the `updates` tool; rejected or unreachable validation writes no auth
state. Users are not asked to pass keys to shell commands or host chat prompts.

Production validation always uses the authenticated MCP endpoint compiled as
`DEFAULT_ENDPOINT`. Tests inject loopback endpoints directly into the validator;
there is no One MCP endpoint environment override. The validator refuses to
send API keys to plain HTTP except for explicit loopback test endpoints
(`localhost`, `127.0.0.1`, or `::1`).

After validation, the sole auth record is stored in the top-level `auth` section
of the consolidated user settings file (`$TRAFFIC_ONE_STATE_PATH`,
`$XDG_STATE_HOME/traffic-one/one.json`, or `~/.traffic-one/one.json`):

```json
{
  "schemaVersion": 3,
  "auth": {
    "version": 1,
    "authenticated": true,
    "apiKey": "…",
    "updatedAt": "2026-07-15T12:00:00Z"
  },
  "codeGraphProvider": null
}
```

The file is mode `0600`; never commit or copy it into a project. The stored key
is used only by the authenticated `/mcp` onboarding validation/connection flow.
Public model sync and structural reporting use anonymous `/public-mcp` requests
with no bearer, cookie, or API key; their failures (including 401/403) never
invalidate `one.json.auth`.

Codex only invokes plugin hooks inside trusted workspaces. If a project is
created in an untrusted folder, Traffic One cannot fail closed from inside the
hook because the hook never starts. Traffic One onboarding is itself started by
those hooks, so onboarding cannot recover inactive or withheld hooks. Traffic
One never auto-approves Codex hook trust.

### Getting and supplying your Traffic One API key

Traffic One enforces authentication by default; a tester who installs the plugin
correctly still cannot use it until a valid API key is stored locally.

**Where the wizard appears.** The first coding prompt in an opted-in project
makes the onboarding hook open the setup wizard and post its link in chat: a
hosted page at `https://traffic.io/onboarding/agent#p=<port>&t=<token>`, with a
local fallback (`http://127.0.0.1:<port>/local?t=<token>`) if the hosted page is
unreachable or 404s. Both `<port>` values are the same number — the loopback
onboarding server's port. It and the token ride in the URL *fragment*, so they
are never sent to traffic.io's servers or logs.

**How to get a key.**

1. Go to `https://traffic.io` and log in, creating an account first if you
   don't already have one.
2. Once signed in, copy the API key from your account.
3. Paste it into the wizard's text field (see "How to supply it" below).
4. Confirm it took effect with Doctor (see "Verifying it took effect" below).

**How to supply it.** The wizard's first (and, if this machine is not yet
authenticated, only) step is a plain text field: paste the key and continue.
The wizard validates it with an authenticated MCP `tools/call` request on the
`updates` tool — the same one request that also returns this account's
announcement feed — before storing anything; a rejected or unreachable key is
never written. There is no
other supported intake path: Traffic One never asks for the key on the command
line or in a host chat prompt, and the stored auth state must not be edited by
hand.

Once validated, the key lives under `auth.apiKey` in the consolidated user
settings file (`$TRAFFIC_ONE_STATE_PATH`, `$XDG_STATE_HOME/traffic-one/one.json`,
or `~/.traffic-one/one.json`), mode `0600` — see the JSON example above.

**`TRAFFIC_ONE_AUTH` is not a way to supply a key.** It is a per-process
override of enforcement itself: `1`/`true`/`on`/`yes` pins enforcement on,
`0`/`false`/`off`/`no` bypasses it entirely. It exists for tests and operational
opt-outs, not as a substitute for a real key in a tester's environment.

**Verifying it took effect.** Run Doctor from the installed plugin — for a local
checkout install that is:

```
node /absolute/path/to/traffic-one/dist/scripts/doctor.cjs
```

Its `probes.auth` field reports `present`, `valid`, and `updatedAt` for the
stored key without ever printing the key itself. A `valid: true` auth probe
(alongside an overall `HEALTHY`/`INFO_ONLY` summary) means the key is stored and
was accepted.

Traffic One also writes version-stable shims to `~/.traffic-one/bin/` so
approved commands survive plugin upgrades, and once one exists
`node ~/.traffic-one/bin/doctor.cjs` is the shorter equivalent. Use the plugin
path above while verifying a key: the shims are written by an *authenticated*
session, so a machine that has never authenticated does not have them yet.

**What a missing key looks like.** The pre-tool-use hook blocks mutating tool
calls until authentication succeeds. Session start and prompt submit do not
block: they attach the setup link as agent context plus a short host banner, so
an ordinary non-coding question still works. The one exception is Windsurf /
Cascade, where an unauthenticated prompt is refused at the prompt itself —
Cascade's own lifecycle otherwise never reaches the point where Traffic One
could open setup. If a hook cannot run at all, the fallback still refuses, with:
"Traffic One authentication is required before this plugin can be used. Open the
Traffic One onboarding wizard and enter the Traffic One API key." The
`materialize-project` command is not a hook; run unauthenticated it does nothing
and waits for the key.

### When setup does not finish: the waiter, its timeouts, and recovery

The agent starts the wizard with one command and then blocks on a second one —
the waiter — so the build resumes in the same turn setup completes, with no
extra message from the user. From an installed plugin the waiter is:

```
node /absolute/path/to/traffic-one/dist/scripts/onboarding-wait.cjs /absolute/path/to/project
```

It polls this project's onboarding state and stops on the first of three
outcomes: `TRAFFIC_ONE_SETUP_COMPLETE` — setup finished and the agent continues
(exit 0, unless one of the directives printed after it blocks the run);
`TRAFFIC_ONE_TECH_CLASSIFY_REQUIRED` (exit 2) — setup is now waiting on the
agent to classify the repository, not on the user; or
`TRAFFIC_ONE_SETUP_PENDING` (exit 2) — the timeout elapsed with setup still
unfinished.

Two flags tune that poll:

| Flag | Default | Effect |
|------|---------|--------|
| `--timeout-ms <n>` | `480000` (8 minutes) | How long the waiter blocks before printing `TRAFFIC_ONE_SETUP_PENDING` and exiting 2. |
| `--interval-ms <n>` | `2000` (2 seconds) | How long it sleeps between reads of the onboarding state. |

Inside a Traffic One session the waiter is admitted by matching the *whole*
argument list, not a filename, so a spelling outside that grammar is denied
rather than run with the flag ignored:

- the value is a **separate word** — `--timeout-ms 540000`, never
  `--timeout-ms=540000`;
- it is a plain positive integer — no `0`, no sign, no decimal point;
- each flag may appear at most once;
- the project path is absolute and comes **before** the flags;
- both flags belong to the blocking form only. The exit-fast modes
  (`--bootstrap-only`, `--decline`, `--reconsider`, `--set-tech`) return
  immediately and reject them.

**Raising `--timeout-ms` means raising the host's own command timeout too.** The
waiter runs in the foreground of the agent's turn, so the shorter of the two
deadlines is the one that ends it: Traffic One's instructions ask the agent for
a ~9 minute (540000 ms) host timeout against the 8-minute default, and a
`--timeout-ms` above the host's limit never takes effect because the host ends
the command before the waiter can report anything.

**`TRAFFIC_ONE_SETUP_PENDING` is not a failure.** It says only that nobody
finished the wizard inside the window. Nothing is rolled back, and the wizard
server is still running, so the first recovery is to run the same waiter again:

```
node /absolute/path/to/traffic-one/dist/scripts/onboarding-wait.cjs /absolute/path/to/project
```

That re-prints the setup-link banner, with two deliberate exceptions: if the
wizard server has already seen the wizard opened in a browser, or if this runner
printed the same banner within the last 90 seconds, it prints a one-line waiting
notice instead of repeating the whole block.

To wait longer than the default, pass the flag and give the host a timeout
above it — 30 minutes here:

```
node /absolute/path/to/traffic-one/dist/scripts/onboarding-wait.cjs /absolute/path/to/project --timeout-ms 1800000
```

If the setup link itself is dead — the host restarted, the machine slept, the
wizard process was killed — re-mint the server and print a live URL without
blocking:

```
node /absolute/path/to/traffic-one/dist/scripts/onboarding-wait.cjs --bootstrap-only /absolute/path/to/project
```

If none of those gets further, ask Doctor what is actually missing before
retrying:

```
node /absolute/path/to/traffic-one/dist/scripts/doctor.cjs
```

Spell each of these in full, exactly as printed — same absolute plugin path,
same argument order, same spaces. `tests/readme-wait-command.test.ts` puts every
waiter command printed above through the same grammar the gate uses, so this
section cannot document a command the product then refuses.

### Recovering a wedged run

A run that settles `failed` is terminal in the strictest sense the run ledger
has: there is no transition out of it, not even the user-authorized resume that
reopens a `blocked` run. No role can bind a claim in it, so a project whose
`currentRunId` still names one can do nothing at all — and the fastest way into
that state is the command that ends a run,
`run-status.cjs --run-id <id> --status failed`.

One command gets a project out of it:

```
node ~/.traffic-one/bin/traffic-one-reset.cjs --run-id <id>
```

It retires the failed run and mints a fresh planned one in a single transaction
under the project state lock: `currentRunId` moves to the successor, the retired
run's agent claims and per-file locks are released, and the next spawn starts
normally. Pass the run id that is currently wedged — the one `.one.json` names
and Doctor prints.

That spelling is gate-exempt, so it runs inside the stuck session. If it is
refused, the shim at that path came from a different installed plugin version —
`~/.traffic-one/bin` is user-scoped and shared across versions, and the gate
admits the shim only while it byte-matches the version that is running. Start a
new session and re-run it (session start rewrites the shim), or run it in your
own terminal, where no hook fires at all.

**Nothing is deleted and nothing is rewritten.** The failed run keeps its ledger
byte for byte, along with its directory, digests and QA evidence; only the
pointer moves. That is deliberate rather than incidental: no writer in the
product reopens a terminal settlement, so the recovery is a retirement rather
than a re-opening. That is a rule the code keeps, not a property of the file —
`settlementHash` is an unkeyed digest, so anything able to write the tree can
produce a record this parser accepts in any status it likes. This command
neither raises that floor nor relies on it.

**It is not a way to clear a limit.** Gate state that exists to stop a loop is
carried onto the successor — the repeat-deny ladder behind the "stop retrying
and report `BLOCKED`" instruction, the per-role exploration tallies, the models
a rate limit condemned, the live-agent registry that keeps a verifier from being
the agent it verifies, and a build pause waiting on a user reply — so reaching a
terminal state and resetting out of it buys nothing. State that only describes
the finished run resets with it (its frozen model policy, its bootstrap
envelopes, its compiled contract), because keeping it would deny the recovered
project its first spawn. Each reset is appended to
`.traffic-one/runs/.resets.json`, and that record is read rather than merely
written: from the third reset onward the carry widens, so recovery stays
available but stops being free.

The command refuses anything that is not this exact situation — a run that is
not the project's current one, a run that is `planned`, `active` or `blocked`
(a blocked run resumes with `run-status.cjs --run-id <id> --status active
--reason user-authorized-extra-cycle`, which needs the user's explicit
authorization), or a run whose ledger cannot be read. If the pointer write is
refused the whole reset is abandoned with the project untouched, so a failed
attempt never leaves it worse wedged than it was.

Inside a Traffic One session this is admitted by matching the *whole* argument
list — `node`, the plugin's own runner or the `~/.traffic-one/bin/` shim, then
`--run-id <id>` and nothing else. Add a flag, a second command, a redirect or a
substitution and it is gated like any other command. `--json` and `--help` work
only in a plain shell, where no hook fires.

### Codex Desktop hook-trust activation

On the first Traffic One installation, activate its hook fixture before starting
Traffic One work:

1. In Codex Desktop, open **Plugins → Traffic One → Hooks → Review**.
2. Inspect every displayed command. The installed plugin must show exactly the
   23 Traffic One hook keys and commands shipped in its `hooks/hooks.json`
   fixture. Only when both the count and the keys/commands match, choose
   **Trust all**.
3. If Desktop offers **Reload**, use it; otherwise fully restart Desktop. Open a
   new task in a trusted project so the newly trusted session hooks can run.
4. Run `node /absolute/path/to/traffic-one/dist/scripts/doctor.cjs` from that
   project (the `~/.traffic-one/bin/` shims do not exist until an authenticated
   session has run). Do not proceed until Doctor reports `HEALTHY` with
   **23 trusted / 23 runnable** Traffic One hooks and confirms that the
   workspace is covered by a trusted project root.

If the review shows any other count, hook key, or command, do **not** choose
**Trust all**. Reinstall or update Traffic One, reopen the review, and compare
it with the installed fixture again. A partial selection, cancelling the
review, or choosing **Continue without trusting** leaves Doctor at
`ACTION_NEEDED`; there is no supported degraded Traffic One mode.

If Desktop cannot complete the review, use the CLI fallback without running
Desktop and the CLI concurrently:

1. Fully quit Codex Desktop.
2. From a trusted project, start `codex`, run `/hooks`, inspect the 23 fixture
   entries, and approve only Traffic One. Do not approve unrelated plugin hooks.
3. Exit the CLI, restart Desktop, open a new task in that trusted project, and
   rerun Doctor until it reports **23 trusted / 23 runnable**.

Run `node /absolute/path/to/traffic-one/dist/scripts/doctor.cjs` — or
`node ~/.traffic-one/bin/doctor.cjs` once an authenticated session has written
the shims — to verify the Codex plugin is enabled, Traffic One hook trust
records are present, and the current `cwd` is covered by a trusted project root.
Trust the generated-project parent or create projects under Codex's trusted
default project root before starting Traffic One work.

Spell the path in full, in one of those two forms. Traffic One's own gates let
Doctor through by matching the absolute path of the runner that is executing, or
a `~/.traffic-one/bin/` shim; a relative spelling — `scripts/doctor.cjs` or
`dist/scripts/doctor.cjs`, run from a plugin root or from a source checkout — is
not recognised as Doctor and is gated like any other command, so the recovery
command would be blocked by the gate it is meant to diagnose. Relative forms are
fine in a plain shell outside a Traffic One session.

If Traffic One skills are visible but hooks did not run, or an opted-in project
was not materialized with its root instructions, do not treat that as a safe
inactive state. Run
`node /absolute/path/to/traffic-one/dist/scripts/doctor.cjs --session <session-id>`
to inspect the Codex transcript. Incident mode anchors project preferences,
hook trust, and project-state probes to the cwd recorded in that session rather
than to the plugin install the command names.
Check the Node version the hooks actually got, too: a `HOOK_RUNTIME_NODE_BELOW_FLOOR`
finding means the host is running Traffic One on a Node below the supported floor,
which is what a GUI-launched host does on a machine whose Node 22 comes from
`nvm` — see the Node requirement under "Installation" below for why and for the
two fixes.
Traffic One implementation remains gated until the project has `pluginUse`
enabled and the canonical API-key record is valid. If the user declines the
plugin, ordinary work continues without Traffic One features.

---

## File map

```
.
├── src/                     ← Source of truth for runtime, rules, skills, agents, and generator
├── src/gen/index.ts         ← Generator     — emits plugin content into dist/
├── dist/                    ← Ignored generated plugin root; install this folder locally
│   ├── skills/              ← Runtime filtered active skills
│   ├── skills-catalog/      ← Full skill source pool (materialized per stack)
│   ├── rules/               ← Shared rule templates generated from src/modules/**/rules
│   ├── agents/              ← Senior role docs generated from src/modules/**/agent.md
│   ├── CLAUDE.md            ← Claude Code entry point
│   ├── AGENTS.md            ← project-materialization source and cross-host rule mirror
│   ├── settings.json        ← Claude Code hooks
│   ├── hooks/hooks.json     ← Codex CLI hooks
│   ├── hooks/hooks-copilot.json ← GitHub Copilot hooks
│   ├── hooks/hooks-windsurf.json ← Windsurf Cascade hooks template
│   ├── plugin.json          ← GitHub Copilot plugin manifest
│   ├── .mcp.json            ← bundled OpenCode worker declaration
│   ├── .mcp-copilot.json    ← Copilot MCP declarations; public Traffic One tools disabled
│   ├── scripts/hook-runtime.cjs
│   ├── scripts/copilot-hook-runtime.cjs
│   ├── scripts/opencode-host.cjs
│   ├── scripts/kilo-host.cjs
│   ├── scripts/windsurf-host.cjs
│   ├── .cursor/rules/*.mdc  ← Cursor mirrors
│   ├── .devin/rules/*.md    ← Windsurf / Cascade workspace rule mirrors
│   ├── .claude-plugin/
│   ├── .codex-plugin/
│   └── .cursor-plugin/
├── .githooks/pre-commit     ← Git           — regenerates and verifies ignored dist/
├── .githooks/prepare-commit-msg ← Git       — appends Traffic One integration trailer
└── .github/workflows/       ← CI            — regenerates dist and verifies determinism
```

**Maintenance rule:** `src/modules/**` and root source docs are the source of truth.
Run `npm run plugin:build` after source changes; `dist/` is generated output and
is intentionally ignored by git.

OpenCode host support targets `opencode-ai` / OpenCode `1.17.11`. Its global
wrapper is installed only with explicit consent and then runs the same shared
Traffic One gates as Codex: pristine non-coding sessions stay quiet, first coding
prompts bootstrap setup, and mutating tools fail closed while setup/auth is
pending. OpenCode delegation remains a paid-host feature for Claude/Codex/Cursor;
the OpenCode host never exposes `opencode_delegate*` tools or self-delegates.

Kilo host support uses Kilo's server-plugin contract and auto-loaded
`~/.config/kilo/plugin/traffic-one.js` wrapper. It runs the same shared Traffic
One gates as OpenCode-compatible hooks, keeps distinct host diagnostics, and
does not self-delegate through OpenCode.

Windsurf / Devin Desktop Cascade support targets the current Cascade docs:
workspace rules are emitted to `.devin/rules/*.md`, workspace skills stay in the
canonical `.traffic-one/skills/<skill>/SKILL.md` tree, and user-level hooks/MCP
configuration are merged only by the consented `scripts/windsurf-host.cjs`
installer.

---

## How it works — no slash commands needed

### Skills auto-trigger
Every skill has a `description:` frontmatter with explicit trigger phrases. The
host reads those descriptions at session start (cheap metadata only) and
automatically invokes the full skill body when your prompt matches:

Traffic One also includes a broad set of development skills under `skills/`.
Those skills keep runtime instructions focused on behavior and include a Traffic One
precedence note so local rules and forced stack choices always win. Structured
source metadata lives in skill frontmatter; the readable source map lives in
`ref.md`.

| You type… | Auto-invoked skill |
|-----------|-------------------|
| "create a product component" | `create-component` |
| "add a user management feature" | `create-feature` |
| "I need a /dashboard route" | `create-page` |
| "add an API call for orders" | `create-service` |
| "make this React site a mobile app" | `ionic-mobile` |
| "create a React Native component" | `create-native-component` |
| "add an Expo route" | `create-native-screen` |
| "create a React Native feature" | `create-native-feature` |
| "add a React Native API call" | `create-native-service` |
| "use surgical changes" | `execution-discipline` |
| "is this auth code secure?" | `security-review` |
| "run the Traffic One Security Check" | `predeploy-security-check` |
| "score production readiness" | `verification-loop` |
| "add monitoring and AI fix suggestions" | `observability` |
| "run the app launch checklist" | `app-launch-checklist` |
| "create project memory" | `project-memory` |
| "generate project docs" | `auto-documentation-generator` |
| "generate deployment artifacts" | `deployment-patterns` |
| "implement JWT auth safely" | `jwt-security` |
| "add auth to a Next.js blog" | `nextjs-turbopack` |
| "refactor this component" | `refactor` |
| "make this UI look modern and clean" | `design-audit` / `frontend-design` |
| "verify the visual QA for this route" | `browser-qa` |
| "design a Postgres schema" | `postgres-patterns` |
| "review this Supabase schema" | `postgres-review` |
| "design an API endpoint" | API/backend skills |
| "review this Go service" | language skills |
| "audit this UI design system" | frontend/design skills |

### Rule loading by host
Cursor path-scoped rules load only when a matching file is open — zero token cost otherwise:
- Open `src/components/Button.tsx` → component rules appear in context
- Open `src/pages/DashboardPage.tsx` → UI quality, typography, accessibility, and design-quality rules appear
- Open `src/services/users.ts` → service + security rules appear
- Open `Button.test.tsx` → testing rules appear

Codex instead loads the project-materialized root `AGENTS.md` rule index and
reads the matching rule bodies on demand. Plugin-root `AGENTS.md` is retained as
materialization source and for cross-host compatibility; Codex does not inject
it directly from the plugin manifest.

### Generated plugin automation
Regenerate generated artifacts after editing content under `src/modules/`:

```
npm run plugin:build
```

CI verifies determinism after materializing `dist/`:

```
npm run gen -- --check
npm run build:verify
```

The tracked `.githooks/pre-commit` hook refreshes and verifies ignored `dist/`.
The tracked `.githooks/prepare-commit-msg` hook appends
`Integrated-With: Traffic One plugin <noreply@traffic.io>` so commits record
the active plugin integration alongside agent co-author trailers. The tracked
`.githooks/pre-push` hook refuses a push whose tip is not described by
`CHANGELOG.md` — `npm run changelog:check:push` asks the same question by hand,
and it is stricter than `npm run changelog:check` on purpose: the tolerance that
makes the CI check satisfiable also hides a missing regeneration for exactly one
commit, so the failure would land on whoever pushes next. Enable them in a clone with:

```
git config core.hooksPath .githooks
```

### Public One MCP model configuration

`ONE_MCP_SYNC` is enabled. Parent SessionStart in an explicitly opted-in
project calls the anonymous
`traffic-one-mcp` `get_config` tool through the validated hook runtime. The
model never receives or calls that tool. `ONE_MCP_REPORT` is also enabled:
an opted-in project sends one anonymous structural first-look report to the
same public endpoint, deduplicated by its `one-uid`. `SAVE_MCP_REPORT` is also
enabled, so the report is tracked in a local `.traffic-one/one-mcp-report.json`
status file: SessionStart queues it, the detached worker sends only what was
queued, and the settled `ok`/`failed` state plus attempt count drive the retry
windows. Machine-global MCP registration remains disabled by
`ONE_MCP_REGISTRATION`.
Host-specific operator rows use the
`traffic_one_<host>_plugin_ai_model_configuration` names centralized in
`src/config/one-mcp.ts` and publish a versionless payload contract. Every
payload has base
`high`, `balanced`, `low`, and `auto` rows plus optional complete per-plan row
sets; an absent plan inherits the base rows.

The versioned canonical payload cache lives in `~/.traffic-one/one-mcp.json`
under `hosts.<host>.config`; the payload fingerprint and active plan's applied
fingerprint are derived at read time instead of being persisted as duplicate
model state. The same host entry carries a generation-CAS token and bounded
`lastSync` diagnostic. `~/.traffic-one/one.json`
contains only machine authentication and the code-graph provider—it is not a
model-catalog mirror.

The cache envelope is schema v2. A pre-release schema-v1 `one-mcp.json` is
intentionally ignored rather than migrated; the first sync request starts at
server version `0` and replaces it atomically. Until an opted-in parent session
runs that request, the old file may remain on disk but never supplies runtime
models. A transient `transport-failed` result is silent during
SessionStart and retains the last valid v2 cache, or uses the bundled catalog
when none exists; `doctor` reports the bounded diagnostic without remote error
text. An `invalid-full-config` diagnostic means the published row did not pass
the validated payload contract and likewise falls back safely.

The project preference that acknowledges a Performance choice is
`hosts.<host>.performance.target = { plan, appliedFingerprint, configVersion }`.
Only `plan` and `appliedFingerprint` decide whether Performance must be picked
again; a metadata-only server-version change advances `configVersion` silently.
Cursor alone
also stores a short-lived `availableModels` capture for the exact model slugs its
Task tool exposes; that capability lease is separate from the MCP tier catalog.
Public transport is anonymous and independent from the API key used by
onboarding's authenticated `/mcp` mount. Sync and reporting both use the fixed
compiled `DEFAULT_PUBLIC_ENDPOINT`; there are no One MCP endpoint, feature,
cache, or release-snapshot environment variables. The four independent
build-time switches are `ONE_MCP_SYNC`, `ONE_MCP_REGISTRATION`,
`ONE_MCP_REPORT`, and `SAVE_MCP_REPORT`. Changing one requires publishing a new
plugin build; disabling registration does not delete a user-owned
machine-global entry.

### Hooks enforce at write time
Hooks run through dependency-free Node.js scripts before files are written or packages installed — violations are blocked
with an explanation before any code is changed.

### Pre-deployment security check
Traffic One blocks production deploy commands unless the shipper approval stamp
and the security-check stamp are both fresh and match the current worktree.

Run the scanner before release work:

```
node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/security-check-runner.cjs" --strict --stamp
```

CI uses `--strict --no-stamp` with pinned `gitleaks@v8.30.1` and
`trufflehog@v3.94.3`. Local runs require installed `gitleaks` and `trufflehog`
binaries. Reports are written to `.traffic-one/reports/security/`.

If those tools are missing locally, Traffic One asks before installing them and
explains why: `gitleaks` scans the worktree and full git history for leaked
keys/tokens, while `trufflehog` verifies and flags known or unknown secrets.
On macOS the recommended install path is:

```
brew install gitleaks trufflehog
```

If Homebrew is missing, Traffic One asks the user to install Homebrew first.

---

## Host tiers: certified vs. uncertified

Traffic One's gates run identically on all seven supported hosts, but its
ability to *prove* they run — and therefore to guarantee they will keep
running — is not identical everywhere. (Seven hosts, eight products: Copilot
CLI and VS Code Copilot are the same host to Traffic One.) Each host in
`HOST_CAPABILITIES` (`src/shared/host/capability-schema.ts`) carries a `tier`:

- **Certified:** `claude` (Claude Code), `codex` (Codex CLI), `cursor`
  (Cursor). Every release exercises these hosts' enforcement points against
  real host behaviour before shipping — either through an automated,
  scriptable install→run→verify→settle sequence, or, for Cursor specifically
  (which has no scriptable install of its own and auto-imports Claude Code's
  user-scope bundle instead), through a dated manual certification record
  reproduced against the same enforcement contract.
- **Uncertified:** `opencode` (OpenCode), `kilo` (Kilo), `copilot` (GitHub
  Copilot), `windsurf` (Windsurf / Devin Desktop Cascade). Traffic One's gates
  still run on these hosts, but nothing yet proves they keep running there on
  every release — their evidence is a manual, dated certification record, not
  an automated live run repeated on every version.

Installing Traffic One for an uncertified host refuses by default, naming the
host and explaining why. To proceed anyway — accepting that Traffic One
cannot guarantee enforcement on that host — re-run with
`TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST=1` set. GitHub Copilot installs through its
own native `copilot plugin install` marketplace command, which Traffic One
does not control, so the refusal cannot run before that install; an
already-installed uncertified host instead gets a banner when a session starts,
stating plainly what is and is not enforced there.

The banner blocks nothing and never claims you agreed to anything — a Copilot
user is never asked. It is throttled per session, twice over. Once the
use-plugin question above has been answered, a marker under the project's
`.traffic-one/` keeps it to at most once per session. Before it is answered
Traffic One may not write anything into the project, not even a marker, so the
throttle is held in memory instead, keyed by project, host and session id — at
most one banner per session, per host process. On Claude Code, Codex, Cursor and
Copilot that is once per session start, because those hosts run one process per
hook event. On OpenCode and Kilo, whose wrapper stays resident and can run the
session-start path repeatedly, it is still once per session and not once per
wrapper: the same wrapper serving a second session emits a second banner, which
is the intended behaviour — the banner is about the session you are starting.
A host string Traffic One does not recognise counts as uncertified, so a typo in
`TRAFFIC_ONE_HOST` cannot silence either surface.

## Installation

Until Traffic One is published to the public plugin marketplace, install it from
a generated local checkout. Run `npm run plugin:build`, then replace
`/absolute/path/to/traffic-one/dist` with this repo's generated `dist` path, for
example `/Users/John/Projects/traffic-one/dist`.

Traffic One requires Node.js 22 or newer on `PATH`; its generated runtime package
also declares this requirement so host and CI installations can reject an
incompatible Node version early.

**A terminal with Node 22 is not the same as a host with Node 22.** Hooks run in
a process the host application spawns, so they get the host's `PATH` — and a host
started from the desktop (Dock, Start menu, Spotlight, a `.desktop` entry) never
runs your shell's startup files. `nvm` lives entirely in those startup files: it
is a shell function that prepends a version directory to `PATH`, so a
GUI-launched host sees the old system `node` instead, no matter what `node -v`
prints in your terminal and no matter what `nvm alias default` is set to. The
symptom is not an error message about Node — it is hooks that fail in ways that
name something else, or produce nothing at all. Every generated launcher now
writes one line to stderr when it starts on an unsupported Node, naming the
version, the floor, and this cause; it then continues rather than refusing, so
this warns you without turning a degraded install into a blocked session. Two
fixes work: quit the host and relaunch it from a terminal that already has Node
22+ (`cursor .`, `claude`, `codex`), or install Node 22+ somewhere on the system
`PATH` that a GUI launch can see. `node ~/.traffic-one/bin/doctor.cjs` reports
this as `HOOK_RUNTIME_NODE_BELOW_FLOOR`, with the `node` it found on `PATH`.

### Claude Code

```
claude plugin marketplace add /absolute/path/to/traffic-one/dist --scope user
claude plugin install traffic-one@traffic-one --scope user
```

### Codex CLI

Codex marketplaces and plugins are separate directories. Stage the generated
plugin under the marketplace root before registering that root:

```
mkdir -p /absolute/path/to/traffic-one-codex-marketplace/.agents/plugins
mkdir -p /absolute/path/to/traffic-one-codex-marketplace/plugins/traffic-one
rsync -a --delete /absolute/path/to/traffic-one/dist/ /absolute/path/to/traffic-one-codex-marketplace/plugins/traffic-one/
cp /absolute/path/to/traffic-one/dist/.agents/plugins/marketplace.json /absolute/path/to/traffic-one-codex-marketplace/.agents/plugins/marketplace.json
codex plugin marketplace add /absolute/path/to/traffic-one-codex-marketplace
codex plugin add traffic-one@traffic-one-local
```

Traffic One appends one inert, disabled public-MCP block to Codex's
machine-global `config.toml` on the first main session. Codex currently removes
the plugin bundle on uninstall but does not run plugin cleanup hooks. Before or
after uninstalling the bundle, remove only Traffic One's exact marked block with:

```
node /absolute/path/to/traffic-one/dist/scripts/one-mcp-host.cjs uninstall --yes
```

If that block was edited, the command leaves it untouched and exits non-zero.

### Cursor

```
/add-plugin /absolute/path/to/traffic-one/dist
```

Or via Cursor Settings → Plugins → Add.

Keep exactly ONE install per machine. Cursor auto-imports Claude Code's
user-scope plugins, so if Claude Code already has traffic-one installed there is
nothing to add in Cursor — a second copy (`/add-plugin` or
`~/.cursor/plugins/local/`) shows up as a duplicate entry and every hook fires
twice. To drop a copy, remove that one install. Never disable Cursor's
third-party extensibility to hide the duplicate: that switch turns off ALL
plugin hooks machine-wide (rules and MCP keep loading, so the breakage is
silent — setup/deploy gates simply stop running).

### GitHub Copilot (CLI + VS Code)

Copilot is an uncertified host (see "Host tiers" above): `copilot plugin
install` is Copilot's own native command, so Traffic One cannot refuse it
before install runs; the SessionStart banner in the host chat is where the
uncertified-host notice actually surfaces.

Build the plugin (`npm run plugin:build`), then install the generated `dist/` folder:

```
copilot plugin install /absolute/path/to/traffic-one/dist
```

Re-run `copilot plugin install` after hook changes — Copilot caches plugin components.

**VS Code:** Chat gear → Customizations → Plugins → Install from folder → select the same `dist/` path.

### OpenCode

OpenCode is an uncertified host (see "Host tiers" above): `install` refuses by
default, naming OpenCode and pointing at `TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST=1`
as the opt-out. Add that variable to the environment before the command below
to proceed anyway.

The OpenCode host wrapper is a user-level mutation at
`~/.config/opencode/plugins/traffic-one.js`, so install it only with explicit
consent:

```
node /absolute/path/to/traffic-one/dist/scripts/opencode-host.cjs install --yes
node /absolute/path/to/traffic-one/dist/scripts/opencode-host.cjs doctor
```

The installer also updates the first existing supported OpenCode global config
(`opencode.jsonc`, `opencode.json`, or `config.json`). When no same-name values
exist, it adds a machine-global, disabled `mcp.traffic-one-mcp` remote entry and
exact `deny` permissions for both managed tools. This inert entry is visible to
OpenCode outside Traffic One projects, but exposes no callable managed tool;
the global wrapper additionally denies both tools before project lookup. User-
owned same-name entries and permissions are never overwritten.

No per-project enable step is required. To verify the wrapper for a particular
workspace:

```
node /absolute/path/to/traffic-one/dist/scripts/opencode-host.cjs doctor --cwd /absolute/path/to/project
```

To opt a specific OpenCode workspace out while keeping the global wrapper
installed:

```
node /absolute/path/to/traffic-one/dist/scripts/opencode-host.cjs disable --cwd /absolute/path/to/project --yes
```

To remove the wrapper:

```
node /absolute/path/to/traffic-one/dist/scripts/opencode-host.cjs uninstall --yes
```

Uninstall removes the Traffic One wrapper and its OpenCode `plugin` array entry.
It deliberately leaves the disabled MCP entry and deny permissions in place so
uninstall never deletes potentially user-owned global config. They may be
removed manually afterward if their exact values are still Traffic One's
disabled/deny defaults.

### Kilo

Kilo is an uncertified host (see "Host tiers" above): `install` refuses by
default, naming Kilo and pointing at `TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST=1` as
the opt-out. Add that variable to the environment before the command below to
proceed anyway.

The Kilo host wrapper is a user-level plugin at
`~/.config/kilo/plugin/traffic-one.js`, so install it only with explicit
consent:

```
node /absolute/path/to/traffic-one/dist/scripts/kilo-host.cjs install --yes
node /absolute/path/to/traffic-one/dist/scripts/kilo-host.cjs doctor
```

The installer also updates the first existing supported Kilo global config
(`kilo.jsonc` or `kilo.json`). If neither exists, it creates `kilo.jsonc`.
When no same-name values exist,
it adds a machine-global, disabled `mcp.traffic-one-mcp` remote entry and exact
`deny` permissions for both managed tools. This inert entry is visible outside
Traffic One projects, while the global wrapper denies both tools before project
lookup. User-owned same-name entries and permissions are never overwritten.

No per-project enable step is required. To verify the wrapper for a particular
workspace:

```
node /absolute/path/to/traffic-one/dist/scripts/kilo-host.cjs doctor --cwd /absolute/path/to/project
```

To opt a specific Kilo workspace out while keeping the global wrapper installed:

```
node /absolute/path/to/traffic-one/dist/scripts/kilo-host.cjs disable --cwd /absolute/path/to/project --yes
```

To remove the wrapper:

```
node /absolute/path/to/traffic-one/dist/scripts/kilo-host.cjs uninstall --yes
```

Kilo uninstall removes only the owned wrapper. The disabled MCP entry and deny
permissions remain intentionally, avoiding destructive edits to a shared user
config; remove them manually only after verifying their exact values.

### Windsurf / Devin Desktop Cascade

Windsurf is an uncertified host (see "Host tiers" above): `install` refuses by
default, naming Windsurf and pointing at `TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST=1`
as the opt-out. Add that variable to the environment before the command below
to proceed anyway.

The Windsurf integration mutates user-level Cascade config at
`~/.codeium/windsurf/hooks.json` and
`~/.codeium/windsurf/memories/global_rules.md`, so install it only with explicit
consent:

```
node /absolute/path/to/traffic-one/dist/scripts/windsurf-host.cjs install --yes
node /absolute/path/to/traffic-one/dist/scripts/windsurf-host.cjs doctor
```

For Windsurf Next or Insiders, pass `--channel next` or `--channel insiders`.
To remove only the Traffic One-owned entries:

```
node /absolute/path/to/traffic-one/dist/scripts/windsurf-host.cjs uninstall --yes
```

### Marketplace install after publication

**Not available yet, and the published name is not decided.** This section
deliberately prints no command you can run today: install from a local checkout
as described above.

Only one thing changes once a listing exists. The marketplace *source* — the
local `dist` path in the commands above — becomes the published name, written
here as `<published-marketplace>`, a placeholder rather than a value:

```
claude plugin marketplace add <published-marketplace>
codex plugin marketplace add <published-marketplace>
/add-plugin <published-marketplace>
```

Everything after that is unchanged, because `traffic-one@traffic-one` is
`plugin@marketplace` and the marketplace name is declared by the bundle's own
manifest rather than by where it is hosted:

```
claude plugin install traffic-one@traffic-one
codex plugin add traffic-one
```

For OpenCode, Kilo, and Windsurf, run the same
`scripts/opencode-host.cjs install --yes`, `scripts/kilo-host.cjs install --yes`,
or `scripts/windsurf-host.cjs install --yes` command from the installed plugin
root after publication.

## Uninstall

Telling the agent to uninstall Traffic One ("uninstall traffic one", "remove the
traffic-one plugin") is enough: the UserPromptSubmit hook recognises the request,
the agent asks once for confirmation, and then runs the whole cleanup. That chat
message is the only moment a full cleanup is reachable — no host runs a plugin
uninstall lifecycle hook, so once the bundle is removed nothing of Traffic One's
ever executes again.

The same cleanup can be run directly:

```
node /absolute/path/to/traffic-one/dist/scripts/traffic-one-uninstall.cjs --dry-run
node /absolute/path/to/traffic-one/dist/scripts/traffic-one-uninstall.cjs --yes
```

It removes, in this order:

1. the user-level host integrations — the Kilo and OpenCode wrappers, the
   Windsurf/Cascade hooks and global rule (all three channels), and both Codex
   machine-global MCP blocks (the disabled public traffic-one-mcp entry and
   the marked opencode-worker entry);
2. the plugin bundle, via `claude plugin uninstall` / `codex plugin remove`, for
   every marketplace that has it;
3. generated host Task/subagent files, using the project-root sidecars under
   `~/.traffic-one/projects/<hash>/root` (`.cursor/agents`, `.kilo/agents`,
   `.github/agents`, `.devin/agents`, leftover `.opencode/agents`, and OpenCode
   `~/.config/opencode/agents/traffic-one-*.md`);
4. `~/.traffic-one` — the saved API key, per-project preferences, runner shims,
   and the managed toolchains (over 1 GB; reinstalled on a future setup).

The order is load-bearing. The Kilo wrapper is fail-closed and its bundle path is
baked in at install time, so a wrapper left behind after the bundle is gone denies
every tool call in every Traffic One project — and the script that would repair it
has just been deleted. Pass `--keep-plugin` to clean everything but leave the
bundle installed. Nothing is written without `--yes`.

Cursor has no plugin-management CLI, so a Cursor install must be removed from its
plugin UI; the command reports it when it finds one. Restart the host afterwards:
it loaded this session's hook wiring at startup and does not reload it, so hooks
keep resolving to the removed bundle until it restarts.

Onboarded project content stays (`.traffic-one/` except generated role files
under `.traffic-one/agents/`, AGENTS.md, plan, memory, runs). Generated host
Task/subagent files (`.cursor/agents`, `.kilo/agents`, `.github/agents`,
`.devin/agents`, leftover `.opencode/agents`, OpenCode
`~/.config/opencode/agents/traffic-one-*.md`) are
removed when their generated marker matches.

---

## Customising

| What to change | Where |
|----------------|-------|
| Library stack, folder structure, core rules | `src/modules/**/rules/core.md`, then run `npm run plugin:build` |
| Provider-first stack recommendations | `src/modules/**/rules/common/stack-recommendations.md`, then run `npm run plugin:build` |
| Curated library catalog | `src/modules/**/rules/common/library-catalog.md`, then run `npm run plugin:build` |
| Post-deploy observability defaults | Source rule/skill under `src/modules/`, then run `npm run plugin:build` |
| App launch checklist defaults | Source rule/skill under `src/modules/`, then run `npm run plugin:build` |
| Generated/existing frontend i18n baseline | Source rule/skill under `src/modules/`, then run `npm run plugin:build` |
| Generated/existing web SEO baseline | Source rule/skill under `src/modules/`, then run `npm run plugin:build` |
| Project memory defaults | Source rule/skill under `src/modules/`, then run `npm run plugin:build` |
| Documentation defaults | Source rule/skill under `src/modules/`, then run `npm run plugin:build` |
| Senior-engineer orchestration workflow | Source rule/skill under `src/modules/`, then run `npm run plugin:build` |
| React web stack rules | `src/modules/**/rules/frontend/react/*.md`, then run `npm run plugin:build` |
| Ionic/Capacitor hybrid mobile rules | `src/modules/**/rules/frontend/ionic/*.md`, then run `npm run plugin:build` |
| React Native stack rules, explicit only | `src/modules/**/rules/frontend/react-native/*.md`, then run `npm run plugin:build` |
| UI quality and typography rules | Source frontend rule under `src/modules/`, then run `npm run plugin:build` |
| Backend and backend technology rules | `src/modules/**/rules/backend/*.md`, then run `npm run plugin:build` |
| Agent behavior, assumptions, surgical edits | Source common rule under `src/modules/`, then run `npm run plugin:build` |
| Add a new skill | Add `src/modules/skills/skills-catalog/your-skill/SKILL.md` with `description:` trigger phrases, then run `npm run plugin:build` |
| Blocked libraries | Edit `src/modules/plan-guard/forbidden.ts`, then cover it with `npm test` |
| Architecture / onboarding / materialization checks | Edit the matching source under `src/modules/`, then cover it with `npm test` |
