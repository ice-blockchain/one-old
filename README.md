# traffic-one — AI Agent Plugin

Enforces React, Ionic/Capacitor mobile packaging, explicit React Native, modern
design quality, security, post-deploy observability, and clean code
**automatically on every prompt**.
No slash commands required. Compatible with **Claude Code**, **Codex CLI**, and **Cursor**.

---

## First action: choose auth mode

Traffic One is gated by the separate `mcp-auth` MCP server. Before onboarding,
materialization, background reporting, or normal plugin work, the agent presents
a two-option modal selector: authenticate Traffic One (recommended) or continue
without Traffic One. If the user authenticates, the agent asks for the API key
using a secure host input/modal; the hook runs the auth client internally, then
verifies status itself. Users should not be asked to run shell commands for the
normal auth flow.

Optional endpoint override for local testing:

```sh
export TRAFFIC_ONE_MCP_KEY_ENDPOINT=http://127.0.0.1:8787/mcp
```

Remote auth endpoints must use HTTPS. The auth client refuses to send API keys
or session tokens to plain HTTP except for loopback local development
(`localhost`, `127.0.0.1`, or `::1`).

The API key is exchanged for a short-lived session token stored in user-level
state (`$TRAFFIC_ONE_AUTH_STATE_PATH`, `$XDG_STATE_HOME/traffic-one/auth.json`,
or `~/.traffic-one/auth.json`). The raw API key is stored outside `auth.json` in
the OS credential manager when available; `auth.json` stores only session
metadata plus a credential reference. Do not commit keys or session tokens.
When a stored session expires, the auth client automatically calls `refresh`
with the OS credential manager key. If no credential is available or refresh is
rejected, the client returns a reauthentication error and keeps Traffic One
gated.

Codex and Claude Code hooks call `auth_status` remotely at every new session
start and again at most once per day during ongoing sessions through the local
auth client. The assistant must not call the exposed `mcp-auth` MCP tools
(`mcp__mcp_auth__auth_status`, `mcp__mcp_auth__refresh`,
`mcp__mcp_auth__authenticate`, or `mcp__mcp_auth__logout`) for routine auth gate
checks; status and refresh should stay silent behind the hook/client boundary.
If auth is missing, expired, remotely rejected, or the remote status check
cannot be verified, Traffic One shows the login instruction and then stays
inactive; the user's request continues without Traffic One features unless they
login.

Codex only invokes plugin hooks inside trusted workspaces. If a project is
created in an untrusted folder, Traffic One cannot fail closed from inside the
hook because the hook never starts. Run `node scripts/doctor.cjs` from the
workspace to verify the Codex plugin is enabled, Traffic One hook trust records
are present, and the current `cwd` is covered by a trusted project root. Trust
the generated-project parent or create projects under Codex's trusted default
project root before starting Traffic One work.

If Traffic One skills are visible but hooks or root instructions were not
injected, do not treat that as a safe inactive state. Run
`node scripts/doctor.cjs --session <session-id>` to inspect the Codex transcript.
Traffic One implementation must remain gated until the user authenticates or
explicitly chooses to continue ordinary work without Traffic One.

Auth-choice state writes are best-effort. If the user-level auth-choice file is
not writable, hooks still return the auth prompt and keep Traffic One inactive
instead of downgrading to unknown plugin mode; doctor will surface the storage or
hook activation problem.

The plugin also declares `mcp-auth` in `.mcp.json`:

```json
{
  "mcpServers": {
    "mcp-auth": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

Authentication does not depend on the exposed `mcp-auth` MCP tools. The auth
gate runs `scripts/traffic-one-auth.cjs login` internally with the key the user
pastes at the prompt, passes that key to the auth client through stdin, stores
the raw key in the OS credential manager when available, mints a session into
`~/.traffic-one/auth.json`, and reads that session on every host (Claude Code,
Codex, Cursor) via the shared hooks.

---

## File map

```
.
├── skills/                  ← Runtime filtered active skills
├── skills-templates/        ← Full skill source; manifest reads this directly
│   ├── create-component/
│   ├── create-feature/
│   ├── create-page/
│   ├── create-service/
│   ├── ionic-mobile/
│   ├── create-native-component/
│   ├── create-native-screen/
│   ├── create-native-feature/
│   ├── create-native-service/
│   ├── execution-discipline/
│   ├── security-review/
│   ├── predeploy-security-check/
│   ├── auto-documentation-generator/
│   ├── jwt-security/
│   └── refactor/
│
├── rules/                   ← SHARED — single source of truth for all rule content
│   ├── core.md              always loaded (no path filter)
│   ├── common/execution-discipline.md always loaded: assumptions, simplicity, surgical edits, verification
│   ├── common/stack-recommendations.md always loaded: provider-first stack defaults
│   ├── common/project-memory.md always loaded: .traffic-one persistent agent memory
│   ├── common/documentation.md always loaded: human + agent docs defaults
│   ├── common/library-catalog.md always loaded: curated package defaults
│   ├── frontend/react/            React web stack rules
│   ├── frontend/ionic/            Ionic Framework + Capacitor hybrid mobile rules
│   ├── frontend/react-native/     Expo React Native stack rules, explicit only
│   ├── frontend/ui-quality.md     modern clean UI gate + visual QA
│   ├── frontend/typography.md     typography and copy polish rules
│   ├── frontend/services.md       shared frontend service rules
│   ├── frontend/testing.md        shared frontend testing rules
│   └── backend/                   Node/Postgres + backend technology rules
│
├── CLAUDE.md                ← Claude Code   — entry point, @imports rules/core.md
├── AGENTS.md                ← Codex CLI     — entry point, inlines rules/ content
├── settings.json            ← Claude Code   — hooks (onboarding, materialization, graph, deploy gates)
├── hooks/hooks.json         ← Codex CLI     — hooks (onboarding, materialization, graph, deploy gates)
├── .mcp.json                ← MCP           — mcp-auth auth server declaration
├── scripts/hook-runtime.cjs ← Hooks         — dependency-free Node hook runtime
├── scripts/traffic-one-auth.cjs ← Auth      — mcp-auth login/refresh/status/logout
├── scripts/sync-cursor.cjs  ← Cursor        — generates .cursor/rules + normalizes manifest
├── .githooks/pre-commit     ← Git           — auto-runs Cursor sync and stages generated files
├── .githooks/prepare-commit-msg ← Git       — appends Traffic One integration trailer
├── .github/workflows/       ← CI            — checks Cursor sync stays deterministic
│
├── .cursor/rules/*.mdc      ← Cursor        — mirrors rules/ in Cursor's .mdc format
│
├── .claude-plugin/          ← Claude Code   — marketplace manifest
├── .codex-plugin/           ← Codex CLI     — marketplace manifest
└── .cursor-plugin/          ← Cursor        — marketplace manifest
```

**Maintenance rule:** `rules/*.md` is the source of truth.
`.cursor/rules/*.mdc` is generated by `scripts/sync-cursor.cjs`; each file has a generated header pointing back to its source. `AGENTS.md` remains the Codex entry-point mirror. Always update `rules/*.md` first.

---

## How it works — no slash commands needed

### Skills auto-trigger
Every skill has a `description:` frontmatter with explicit trigger phrases.
Claude/Codex/Cursor reads the descriptions at session start (cheap metadata only) and
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

### Rules auto-attach
Path-scoped rules load only when a matching file is open — zero token cost otherwise:
- Open `src/components/Button.tsx` → component rules appear in context
- Open `src/pages/DashboardPage.tsx` → UI quality, typography, accessibility, and design-quality rules appear
- Open `src/services/users.ts` → service + security rules appear
- Open `Button.test.tsx` → testing rules appear

### Cursor sync automation
Regenerate Cursor artifacts after editing `rules/`:

```
node scripts/sync-cursor.cjs
```

CI verifies determinism without writing files:

```
node scripts/sync-cursor.cjs --check
```

The tracked `.githooks/pre-commit` hook runs the sync automatically and stages generated `.cursor` changes.
The tracked `.githooks/prepare-commit-msg` hook appends
`Integrated-With: Traffic One plugin <noreply@traffic.io>` so commits record
the active plugin integration alongside agent co-author trailers. Enable them in a clone with:

```
git config core.hooksPath .githooks
```

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
a local checkout of this repository. Replace `/absolute/path/to/traffic-one`
with this repo's absolute path, for example `/Users/John/Projects/traffic-one`.

### Claude Code

```
claude plugin marketplace add /absolute/path/to/traffic-one --scope user
claude plugin install traffic-one@traffic-one --scope user
```

### Codex CLI

```
codex plugin marketplace add /absolute/path/to/traffic-one
codex plugin add traffic-one@traffic-one-local
```

### Cursor

```
/add-plugin /absolute/path/to/traffic-one
```
Or via Cursor Settings → Plugins → Add.

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

---

## Customising

| What to change | Where |
|----------------|-------|
| Library stack, folder structure, core rules | `rules/core.md`, then run `node scripts/sync-cursor.cjs` |
| Provider-first stack recommendations | `rules/common/stack-recommendations.md`, then run `node scripts/sync-cursor.cjs` |
| Curated library catalog | `rules/common/library-catalog.md`, then run `node scripts/sync-cursor.cjs` |
| Post-deploy observability defaults | `rules/common/stack-recommendations.md`, `skills/observability/SKILL.md`, then run `node scripts/sync-cursor.cjs` |
| App launch checklist defaults | `rules/common/stack-recommendations.md`, `skills/app-launch-checklist/SKILL.md`, then mirror `AGENTS.md` and run `node scripts/sync-cursor.cjs` |
| Generated/existing frontend i18n baseline | `rules/frontend/i18n.md`, `skills/i18n-text/SKILL.md`, then mirror `AGENTS.md` and run `node scripts/sync-cursor.cjs` |
| Generated/existing web SEO baseline | `rules/common/seo.md`, `skills/seo/SKILL.md`, then mirror `AGENTS.md` and run `node scripts/sync-cursor.cjs` |
| Project memory defaults | `rules/common/project-memory.md`, `skills/project-memory/SKILL.md`, then mirror `AGENTS.md` and run `node scripts/sync-cursor.cjs` |
| Documentation defaults | `rules/common/documentation.md`, `skills/auto-documentation-generator/SKILL.md`, then mirror `AGENTS.md` and run `node scripts/sync-cursor.cjs` |
| Senior-engineer orchestration workflow | `rules/common/senior-engineer-team.md`, `skills/senior-eng-orchestrator/SKILL.md`, then mirror `AGENTS.md` and run `node scripts/sync-cursor.cjs` |
| React web stack rules | `rules/frontend/react/*.md`, then run `node scripts/sync-cursor.cjs` |
| Ionic/Capacitor hybrid mobile rules | `rules/frontend/ionic/*.md`, then run `node scripts/sync-cursor.cjs` |
| React Native stack rules, explicit only | `rules/frontend/react-native/*.md`, then run `node scripts/sync-cursor.cjs` |
| UI quality and typography rules | `rules/frontend/ui-quality.md`, `rules/frontend/typography.md`, then run `node scripts/sync-cursor.cjs` |
| Backend and backend technology rules | `rules/backend/*.md`, then run `node scripts/sync-cursor.cjs` |
| Agent behavior, assumptions, surgical edits | `rules/common/execution-discipline.md`, then run `node scripts/sync-cursor.cjs` |
| Add a new skill | Add `skills/your-skill/SKILL.md` with `description:` trigger phrases |
| Blocked libraries | Edit the `PreToolUse[Bash]` hook in `settings.json` and `hooks/hooks.json` |
| Architecture / onboarding / materialization checks | Edit the matching hook in both `settings.json` and `hooks/hooks.json`, then cover it in `scripts/test-stack-recommendations.cjs` |
