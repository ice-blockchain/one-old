# traffic-one — AI Agent Plugin

Enforces React, React Native, security, and clean code **automatically on every prompt**.
No slash commands required. Compatible with **Claude Code**, **Codex CLI**, and **Cursor**.

---

## File map

```
.
├── skills/                  ← SHARED across all agents — auto-trigger on semantic match
│   ├── create-component/
│   ├── create-feature/
│   ├── create-page/
│   ├── create-service/
│   ├── create-native-component/
│   ├── create-native-screen/
│   ├── create-native-feature/
│   ├── create-native-service/
│   ├── execution-discipline/
│   ├── security-review/
│   └── refactor/
│
├── rules/                   ← SHARED — single source of truth for all rule content
│   ├── core.md              always loaded (no path filter)
│   ├── common/execution-discipline.md always loaded: assumptions, simplicity, surgical edits, verification
│   ├── frontend/react/            React web stack rules
│   ├── frontend/react-native/     Expo React Native stack rules
│   ├── frontend/services.md       shared frontend service rules
│   ├── frontend/testing.md        shared frontend testing rules
│   └── backend/                   Node/Postgres + backend technology rules
│
├── CLAUDE.md                ← Claude Code   — entry point, @imports rules/core.md
├── AGENTS.md                ← Codex CLI     — entry point, inlines rules/ content
├── settings.json            ← Claude Code   — hooks (PreToolUse arch + library checks)
├── hooks/hooks.json         ← Codex CLI     — hooks (PreToolUse arch + library checks)
│
├── .cursor/rules/*.mdc      ← Cursor        — mirrors rules/ in Cursor's .mdc format
│
├── .claude-plugin/          ← Claude Code   — marketplace manifest
├── .codex-plugin/           ← Codex CLI     — marketplace manifest
└── .cursor-plugin/          ← Cursor        — marketplace manifest
```

**Maintenance rule:** `rules/*.md` is the source of truth.
`AGENTS.md` and `.cursor/rules/*.mdc` are mirrors — each file has a comment pointing back to its source. Always update `rules/*.md` first.

---

## How it works — no slash commands needed

### Skills auto-trigger
Every skill has a `description:` frontmatter with explicit trigger phrases.
Claude/Codex/Cursor reads the descriptions at session start (cheap metadata only) and
automatically invokes the full skill body when your prompt matches:

| You type… | Auto-invoked skill |
|-----------|-------------------|
| "create a product component" | `create-component` |
| "add a user management feature" | `create-feature` |
| "I need a /dashboard route" | `create-page` |
| "add an API call for orders" | `create-service` |
| "create a native component" | `create-native-component` |
| "add an Expo route" | `create-native-screen` |
| "create a mobile feature" | `create-native-feature` |
| "add a mobile API call" | `create-native-service` |
| "use Karpathy-style surgical changes" | `execution-discipline` |
| "is this auth code secure?" | `security-review` |
| "refactor this component" | `refactor` |

### Rules auto-attach
Path-scoped rules load only when a matching file is open — zero token cost otherwise:
- Open `src/components/Button.tsx` → component rules appear in context
- Open `src/services/users.ts` → service + security rules appear
- Open `Button.test.tsx` → testing rules appear

### Hooks enforce at write time
Hooks run before files are written or packages installed — violations are blocked
with an explanation before any code is changed.

---

## Installation

### Claude Code
```
/plugin marketplace add cosminturcin/claude-plug
/plugin install traffic-one@traffic-one
```

### Codex CLI
```
codex marketplace add cosminturcin/claude-plug
codex plugin install traffic-one
```

### Cursor
```
/add-plugin cosminturcin/claude-plug
```
Or via Cursor Settings → Plugins → Add.

---

## Customising

| What to change | Where |
|----------------|-------|
| Library stack, folder structure, core rules | `rules/core.md` (then mirror to `AGENTS.md` + `.cursor/rules/core.mdc`) |
| React web stack rules | `rules/frontend/react/*.md` (then mirror to `AGENTS.md` + `.cursor/rules/react-*.mdc`) |
| React Native stack rules | `rules/frontend/react-native/*.md` (then mirror to `AGENTS.md` + `.cursor/rules/react-native-*.mdc`) |
| Backend and backend technology rules | `rules/backend/*.md` (then mirror to `AGENTS.md` + `.cursor/rules/backend-*.mdc`) |
| Agent behavior, assumptions, surgical edits | `rules/common/execution-discipline.md` (then mirror to `AGENTS.md` + `.cursor/rules/common-execution-discipline.mdc`) |
| Add a new skill | Add `skills/your-skill/SKILL.md` with `description:` trigger phrases |
| Blocked libraries | Edit the `PreToolUse[Bash]` hook in `settings.json` and `hooks/hooks.json` |
| Architecture violation checks | Edit the `PreToolUse[Write\|Edit]` hook in `settings.json` |
