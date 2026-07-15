# traffic-one — AI Agent Plugin

Enforces React, Ionic/Capacitor mobile packaging, explicit React Native, modern
design quality, security, post-deploy observability, and clean code
**automatically on every prompt**.
No slash commands required. Compatible with **Claude Code**, **Codex CLI**, **Cursor**,
**GitHub Copilot CLI**, **VS Code Copilot**, **OpenCode**, **Kilo**, and
**Windsurf / Devin Desktop Cascade**.

---

## First action: choose whether to use Traffic One

Before onboarding starts, Traffic One asks in the host chat whether the user
wants to use the plugin for that project. The answer is stored as the durable
per-project `pluginUse` preference outside the repository. A decline leaves the
project untouched and makes every Traffic One hook stand down until the user
explicitly asks to enable it again.

After an opt-in, the local setup wizard opens. If this machine is not yet
authenticated, the wizard's first and only unresolved step is the Traffic One
API key. The wizard validates the key through an authenticated MCP `tools/list`
request; rejected or unreachable validation writes no auth state. Users are not
asked to pass keys to shell commands or host chat prompts.

Optional endpoint override for local testing:

```sh
export TRAFFIC_ONE_MCP_KEY_ENDPOINT=http://127.0.0.1:8787/mcp
```

Remote auth endpoints must use HTTPS. The validator refuses to send API keys to
plain HTTP except for loopback local development
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
  "codeGraphProvider": null,
  "hosts": {}
}
```

The file is mode `0600`; never commit or copy it into a project. The stored key
is also the Bearer token for the background report. A report response of 401 or
403 deletes only `one.json.auth`, preserving hosts and code-graph settings, and
the wizard reopens on the API-key step.

Codex only invokes plugin hooks inside trusted workspaces. If a project is
created in an untrusted folder, Traffic One cannot fail closed from inside the
hook because the hook never starts. Run `node scripts/doctor.cjs` from an
installed plugin root, or `node dist/scripts/doctor.cjs` from this source
checkout after `npm run plugin:build`, to verify the Codex plugin is enabled,
Traffic One hook trust records are present, and the current `cwd` is covered by
a trusted project root. Trust the generated-project parent or create projects
under Codex's trusted default project root before starting Traffic One work.

If Traffic One skills are visible but hooks or root instructions were not
injected, do not treat that as a safe inactive state. Run
`node dist/scripts/doctor.cjs --session <session-id>` from this source checkout
to inspect the Codex transcript.
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
│   ├── AGENTS.md            ← Codex CLI and OpenCode rule entry point
│   ├── settings.json        ← Claude Code hooks
│   ├── hooks/hooks.json     ← Codex CLI hooks
│   ├── hooks/hooks-copilot.json ← GitHub Copilot hooks
│   ├── hooks/hooks-windsurf.json ← Windsurf Cascade hooks template
│   ├── plugin.json          ← GitHub Copilot plugin manifest
│   ├── .mcp.json            ← bundled OpenCode worker declaration
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
Every skill has a `description:` frontmatter with explicit trigger phrases.
Claude/Codex/Cursor/OpenCode/Kilo/Windsurf reads the descriptions at session start (cheap
metadata only) and automatically invokes the full skill body when your prompt
matches:

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

### Rules auto-attach
Path-scoped rules load only when a matching file is open — zero token cost otherwise:
- Open `src/components/Button.tsx` → component rules appear in context
- Open `src/pages/DashboardPage.tsx` → UI quality, typography, accessibility, and design-quality rules appear
- Open `src/services/users.ts` → service + security rules appear
- Open `Button.test.tsx` → testing rules appear

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
the active plugin integration alongside agent co-author trailers. Enable them in a clone with:

```
git config core.hooksPath .githooks
```

### External model-status API

The public read-only `GET /model-status?host=<host>&plan=<plan>` endpoint is
maintained independently from this plugin. `npm run gen` does not produce an API
deployment artifact. A successful response is the exact host snapshot stored in
`~/.traffic-one/one.json`: `{ plan, updatedAt, tiers }`, with preferred-first
model arrays under `highest`, `balanced`, and `cheapest`.

Whenever a host's model arrays change, update that host's `updatedAt` in
`src/config/model-tiers.ts`; the external service must be updated separately.
The endpoint is independent of Traffic One authentication. Remote overrides use
`TRAFFIC_ONE_MODEL_STATUS_ENDPOINT`, require HTTPS, and permit plain HTTP only
for loopback contract testing.

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

## Installation

Until Traffic One is published to the public plugin marketplace, install it from
a generated local checkout. Run `npm run plugin:build`, then replace
`/absolute/path/to/traffic-one/dist` with this repo's generated `dist` path, for
example `/Users/John/Projects/traffic-one/dist`.

### Claude Code

```
claude plugin marketplace add /absolute/path/to/traffic-one/dist --scope user
claude plugin install traffic-one@traffic-one --scope user
```

### Codex CLI

```
codex plugin marketplace add /absolute/path/to/traffic-one/dist
codex plugin add traffic-one@traffic-one-local
```

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

Build the plugin (`npm run plugin:build`), then install the generated `dist/` folder:

```
copilot plugin install /absolute/path/to/traffic-one/dist
```

Re-run `copilot plugin install` after hook changes — Copilot caches plugin components.

**VS Code:** Chat gear → Customizations → Plugins → Install from folder → select the same `dist/` path.

### OpenCode

The OpenCode host wrapper is a user-level mutation at
`~/.config/opencode/plugins/traffic-one.js`, so install it only with explicit
consent:

```
node /absolute/path/to/traffic-one/dist/scripts/opencode-host.cjs install --yes
node /absolute/path/to/traffic-one/dist/scripts/opencode-host.cjs doctor
```

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
node /absolute/path/to/traffic-one/dist/scripts/opencode-host.cjs uninstall
```

### Kilo

The Kilo host wrapper is a user-level plugin at
`~/.config/kilo/plugin/traffic-one.js`, so install it only with explicit
consent:

```
node /absolute/path/to/traffic-one/dist/scripts/kilo-host.cjs install --yes
node /absolute/path/to/traffic-one/dist/scripts/kilo-host.cjs doctor
```

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
node /absolute/path/to/traffic-one/dist/scripts/kilo-host.cjs uninstall
```

### Windsurf / Devin Desktop Cascade

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

After the marketplace listing is live, use the published marketplace source
instead of the local path:

```
claude plugin marketplace add traffic-one/traffic-one
claude plugin install traffic-one@traffic-one

codex plugin marketplace add traffic-one/traffic-one
codex plugin add traffic-one

/add-plugin traffic-one/traffic-one
```

For OpenCode, Kilo, and Windsurf, run the same
`scripts/opencode-host.cjs install --yes`, `scripts/kilo-host.cjs install --yes`,
or `scripts/windsurf-host.cjs install --yes` command from the installed plugin
root after publication.

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
