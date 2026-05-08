---
name: auto-documentation-generator
description: Generate or refresh the documentation humans and agents actually read: README.md, AGENTS.md, CLAUDE.md, Cursor .mdc rules, architecture.md, ADRs, api.md, database.md, deployment.md, security.md, CHANGELOG.md, environment-setup.md, CONTRIBUTING.md, and llms.txt for SPA + Supabase, Ionic/Capacitor, React Native, and backend projects. Trigger on "generate docs", "auto-documentation", "document this project", "write project docs", "create AGENTS.md", "create llms.txt", "update architecture docs", or release-readiness documentation requests.
metadata:
  adapted_for: traffic-one
---

Traffic One precedence: follow this skill only where it does not conflict with
Traffic One AGENTS.md and rules/*.md. Forced stack choices, approved libraries,
i18n, styling, services, state, testing, accessibility, security, and backend
technology rules from Traffic One take precedence.

# Auto-Documentation Generator

Generate the smallest useful documentation set for the current repo. The goal
is not "more markdown"; it is a reliable map for humans and coding agents.

## When to Use

Use this skill when the user asks to:

- Generate, refresh, audit, or repair project documentation.
- Prepare launch, handoff, onboarding, or production-readiness docs.
- Create or update `README.md`, `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`,
  `architecture.md`, `docs/adr/`, `api.md`, `database.md`, `deployment.md`,
  `security.md`, `CHANGELOG.md`, `environment-setup.md`, `CONTRIBUTING.md`, or
  `llms.txt`.

## Core Rules

- Update existing docs first. Create a new file only when the information has no
  better existing home.
- Prefer pointers to duplicated prose. Link from README/AGENTS/CLAUDE to deeper
  docs instead of copying the same commands everywhere.
- Do not generate empty boilerplate. Omit sections that cannot be filled with
  verified project facts, or mark them `Unverified` with the exact missing input.
- Never include secret values. Document env var names, where they are configured,
  and who owns rotation.
- Keep agent-facing docs concise. `CLAUDE.md` should be a symlink to `AGENTS.md`
  when that works for the project, or a focused file under ~300 lines containing
  only what Claude would otherwise get wrong.
- Treat docs as code: use existing package manager, scripts, deployment config,
  migrations, OpenAPI files, and git history as the source of truth.

## Discovery Order

Read only what is needed:

1. `README.md`, `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, existing `docs/`.
2. `package.json`, workspace config, lockfile, `.nvmrc`, `.tool-versions`,
   `mise.toml`, `turbo.json`, `vite.config.*`, `capacitor.config.*`,
   `eas.json`, CI workflows, deploy manifests.
3. `.env.example`, Supabase config, `supabase/migrations/*.sql`,
   `supabase/functions/**`, OpenAPI specs, route handlers, Edge Functions.
4. `graphify-out/GRAPH_REPORT.md` if available, then targeted source files.
5. `git log --oneline --decorate --max-count=50` for changelog candidates.

## Documentation Set

Create or refresh these files when relevant:

| File | Purpose | Required content |
| --- | --- | --- |
| `README.md` | Human entry point | What it is, who it is for, one-command setup, live deploy link, where deeper docs live. |
| `AGENTS.md` | Agent entry point | Build/test commands, code-style rules, gotchas, repo map, security/deploy warnings. Root file first; nested files only for large subprojects. |
| `CLAUDE.md` | Claude-specific memory | Symlink to `AGENTS.md` or keep under ~300 lines; include only project-specific traps and pointers. Do not duplicate linter rules. |
| `.cursor/rules/*.mdc` | Cursor-specific guidance | Short scoped rules with `description`, `globs`, and `alwaysApply`; split large rules by domain. |
| `architecture.md` or `docs/architecture.md` | System map | Folder map, data flow diagram in text or Mermaid, key dependencies, and why major choices were made. Link ADRs. Package-level `packages/*/architecture.md` still follows `rules/common/package-architecture.md`. |
| `docs/adr/NNNN-*.md` | Decision log | Use `architecture-decision-records`; one short Nygard-style ADR per significant decision with Context, Decision, Status, and Consequences. |
| `api.md` | API reference | Generate from OpenAPI for Edge Functions or route handlers. Include auth, request/response schemas, errors, and examples. |
| `database.md` | Schema/RLS reference | Generate from migrations or `pg_dump --schema-only --no-owner --no-privileges`; include RLS policies next to each table using `pg_policies` or migration excerpts. No data dumps. |
| `deployment.md` | Release/runbook | Preview/staging/prod URLs, deploy commands, secrets list without values, rollback, "build failing", and "DB down" runbooks. |
| `security.md` | Security operating doc | Threat model summary, vulnerability reporting, dependency update cadence, RLS testing, secret rotation, security scanner command. |
| `CHANGELOG.md` | Release history | Keep a Changelog structure with `Unreleased`, generated from Conventional Commits and edited for humans. |
| `environment-setup.md` | Reproducible local setup | Exact Node/Bun/pnpm versions, Supabase CLI version, env setup, seed/reset commands, local DB flow. |
| `CONTRIBUTING.md` | Contributor path | Branch naming, PR template/checklist, commit conventions, review checklist, test expectations. |
| `public/llms.txt` or site root `llms.txt` | LLM docs index | Markdown index for AI crawlers/assistants pointing to canonical docs. For web apps, serve it at `/llms.txt`. |

## Generation Details

### README.md

Keep it human-first:

- One paragraph explaining what the product does and who it serves.
- One-command local setup when possible, such as `pnpm install && pnpm dev`.
- Link to live deploy or write `Live deploy: not configured yet`.
- Link to `AGENTS.md`, `docs/architecture.md`, `deployment.md`, and
  `environment-setup.md` instead of repeating their full content.

### AGENTS.md and CLAUDE.md

- `AGENTS.md` is the cross-agent standard. Include commands agents should run,
  style/architecture gotchas, security constraints, and repo-specific hazards.
- `CLAUDE.md` should be a symlink to `AGENTS.md` when the repo does not need
  Claude-specific differences. Otherwise keep it concise and link outward.
- Do not paste the full lint rules; name the deterministic command.

### Architecture and ADRs

- `architecture.md` explains the current shape, not an aspirational future.
- Include a folder map and one data-flow diagram. Mermaid is fine.
- Use the `architecture-decision-records` skill for significant choices. If the
  user explicitly requested docs generation, that counts as approval to create
  a missing `docs/adr/` scaffold; otherwise ask before initializing ADR files.

### API and Database Docs

- Prefer existing OpenAPI files. If missing, derive a minimal spec from Edge
  Functions/route handlers and mark it `Generated from source; verify before
  publishing`.
- For Supabase/Postgres docs, prefer migrations in git. If a live DB is
  available and the user allows it, use:

```bash
pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL"
```

- Include RLS policies inline next to each table. Good sources are
  `supabase/migrations/*.sql`, `pg_policies`, and Supabase CLI output.
- Never dump table data, production secrets, anon/service keys, or connection
  strings into docs.

### llms.txt

Create a concise Markdown file with:

```markdown
# <Project Name>

> One-sentence project summary for LLMs and coding agents.

## Canonical docs
- [README](https://example.com/README.md): human overview and setup.
- [Architecture](https://example.com/docs/architecture.md): system map.
- [API](https://example.com/docs/api.md): endpoints and auth.

## Optional
- [Changelog](https://example.com/CHANGELOG.md): release history.
```

For Vite/React/Ionic, place the served copy in `public/llms.txt` and optionally
keep a root `llms.txt` if the repository itself is published as docs.

## Output Format

End with:

```markdown
AUTO-DOCS REPORT
================

Updated:
- <file> - <what changed>

Created:
- <file> - <why it was needed>

Unverified:
- <fact> - <command/input needed>

Skipped:
- <file> - <reason>

Validation:
- <command> - PASS/FAIL
```
