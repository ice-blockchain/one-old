---
name: auto-documentation-generator
description: >
  Generate or refresh the documentation humans and agents actually read:
  README.md, AGENTS.md, CLAUDE.md, `.traffic-one/plan.md`, ADRs,
  `.traffic-one/api.md`, `.traffic-one/database.md`,
  `.traffic-one/deployment.md`, `.traffic-one/security.md`, CHANGELOG.md,
  `.traffic-one/environment-setup.md`, CONTRIBUTING.md, and llms.txt for SPA + Supabase,
  Ionic/Capacitor, React Native, and backend projects. Trigger on "generate
  docs", "auto-documentation", "document this project", "write project docs",
  "create AGENTS.md", "create llms.txt", "update the project plan", or
  release-readiness documentation requests.
metadata:
  source: everything-claude-code
  source_path: skills/codebase-onboarding/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
  merged_source_paths:
    - skills/codebase-onboarding/SKILL.md
---

# Auto-Documentation Generator

Generate the smallest useful documentation set for the current repo. The goal
is not "more markdown"; it is a reliable map for humans and coding agents.

## When to Activate

Use this skill when the user asks to:

- Generate, refresh, audit, or repair project documentation.
- Prepare launch, handoff, onboarding, or production-readiness docs.
- Create or update `README.md`, `AGENTS.md`, `CLAUDE.md`,
  `.traffic-one/plan.md`, `.traffic-one/decisions/`, `.traffic-one/api.md`,
  `.traffic-one/database.md`, `.traffic-one/deployment.md`,
  `.traffic-one/security.md`, `CHANGELOG.md`,
  `.traffic-one/environment-setup.md`, `CONTRIBUTING.md`, or `llms.txt`.

## Core Rules

- Update existing docs first. Create a new file only when the information has no
  better existing home.
- In existing projects, reconcile the docs baseline: if a canonical doc is
  missing, create it from verified repo facts at its canonical path. Keep
  human entry docs at the repo root and detailed operational docs under
  `.traffic-one/`. If legacy canonical docs exist at the repo root or under
  `docs/`, migrate or merge them to the canonical path when that can be done
  without dropping content.
- Treat root `api.md`, `database.md`, `deployment.md`,
  `environment-setup.md`, and `security.md` as legacy. Move their content into
  `.traffic-one/`; when both root `security.md` and `.traffic-one/security.md`
  exist, compact them into the `.traffic-one/security.md` operating doc.
- Prefer pointers to duplicated prose. Link from README/AGENTS/CLAUDE to deeper
  docs instead of copying the same commands everywhere.
- Do not generate empty boilerplate. Omit sections that cannot be filled with
  verified project facts, or mark them `Unverified` with the exact missing input.
- Keep agent-facing docs concise: name the deterministic command instead of
  pasting full lint rules; include only what the agent would otherwise get wrong.
- Treat docs as code: use existing package manager, scripts, deployment config,
  migrations, OpenAPI files, and git history as the source of truth.
- Canonical `.traffic-one` file set, secret-redaction, pg_dump schema snapshot,
  and AGENTS/CLAUDE symlink rules: see the `project-memory` skill.

## Discovery Order

Read only what is needed:

1. `README.md`, `AGENTS.md`, `CLAUDE.md`,
   `.traffic-one/` project memory/docs, legacy root docs, and legacy `docs/`
   only when present.
2. `package.json`, workspace config, lockfile, `.nvmrc`, `.tool-versions`,
   `mise.toml`, `turbo.json`, `vite.config.*`, `capacitor.config.*`,
   `eas.json`, CI workflows, deploy manifests.
3. `.env.example`, Supabase config, `supabase/migrations/*.sql`,
   `supabase/functions/**`, OpenAPI specs, route handlers, Edge Functions.
4. The codebase-graph artefact at the active provider's location (per
   `rules/common/codebase-graph.md`): `.gitnexus/` for gitnexus,
   `graphify-out/GRAPH_REPORT.md` for graphify. Then targeted source files.
5. `git log --oneline --decorate --max-count=50` for changelog candidates.

## Codebase Onboarding Artifacts

When creating onboarding or agent docs, derive the short repo map from verified
signals (manifest/lockfile/runtime pins, framework fingerprints, entrypoints and
ownership boundaries, test/lint/typecheck commands and their confidence, and
known hazards). The `project-memory` skill's reconnaissance workflow covers how
to gather these facts; here, distill them into a navigational map.

Keep the artifact navigational. Link to graph reports, `.traffic-one/plan.md`, ADRs,
and project memory for detail instead of copying large inventories into
README/AGENTS/CLAUDE.

## Documentation Set

Create or refresh these files when relevant:

| File | Purpose | Required content |
| --- | --- | --- |
| `README.md` | Human entry point | What it is, who it is for, one-command setup, live deploy link, where deeper docs live. |
| `AGENTS.md` | Agent entry point | Build/test commands, code-style rules, gotchas, repo map, security/deploy warnings. Root file first; nested files only for large subprojects. |
| `CLAUDE.md` | Claude-specific memory | Per the `project-memory` symlink rule; otherwise keep under ~300 lines with only project-specific traps and pointers. Do not duplicate linter rules. |
| `.traffic-one/plan.md` | Plan and system map | Current goal, module map, public contracts, risks, cut-list, key dependencies, and links to ADRs. Legacy `architecture.md` files are migration-only. |
| `.traffic-one/decisions/NNNN-*.md` | Decision log | Use `architecture-decision-records`; one short Nygard-style ADR per significant decision with Context, Decision, Status, and Consequences. |
| `.traffic-one/api.md` | API reference | Generate from OpenAPI for Edge Functions or route handlers. Include auth, request/response schemas, errors, and examples. |
| `.traffic-one/database.md` | Schema/RLS reference | Generate from migrations or the `project-memory` schema-snapshot command; include RLS policies next to each table using `pg_policies` or migration excerpts. No data dumps. |
| `.traffic-one/deployment.md` | Release/runbook | Preview/staging/prod URLs, deploy commands, secrets list without values, rollback, "build failing", and "DB down" runbooks. |
| `.traffic-one/security.md` | Security memory and operating doc | Merge project non-negotiables, threat model summary, vulnerability reporting, dependency update cadence, RLS testing, secret rotation, and scanner command. Do not create a separate root `security.md`. |
| `CHANGELOG.md` | Release history | Keep a Changelog structure with `Unreleased`, generated from Conventional Commits and edited for humans. |
| `.traffic-one/environment-setup.md` | Reproducible local setup | Exact Node/Bun/pnpm versions, Supabase CLI version, env setup, seed/reset commands, local DB flow. |
| `CONTRIBUTING.md` | Contributor path | Branch naming, PR template/checklist, commit conventions, review checklist, test expectations. |
| `public/llms.txt` or root `llms.txt` | LLM docs index | Markdown index for AI crawlers/assistants pointing to canonical docs. For web apps, serve it at `/llms.txt`. |

## Generation Details

### README.md

Keep it human-first:

- One paragraph explaining what the product does and who it serves.
- One-command local setup when possible, such as `pnpm install && pnpm dev`.
- Link to live deploy or write `Live deploy: not configured yet`.
- Link to `AGENTS.md`, `.traffic-one/plan.md`,
  `.traffic-one/deployment.md`, and `.traffic-one/environment-setup.md`
  instead of repeating their full content.

### AGENTS.md and CLAUDE.md

- `AGENTS.md` is the cross-agent standard. Include commands agents should run,
  style/architecture gotchas, security constraints, and repo-specific hazards.
- `CLAUDE.md` follows the `project-memory` symlink rule; otherwise keep it
  concise and link outward.
- Do not paste the full lint rules; name the deterministic command.

### Plan and ADRs

- `.traffic-one/plan.md` explains the current shape and active implementation plan, not an aspirational future.
- Include a module map and one data-flow diagram when the project shape is non-trivial. Mermaid is fine.
- Use the `architecture-decision-records` skill for significant choices. If the
  user explicitly requested docs generation, that counts as approval to create
  a missing `.traffic-one/decisions/` scaffold; otherwise ask before
  initializing ADR files.

### API and Database Docs

- Prefer existing OpenAPI files. If missing, derive a minimal spec from Edge
  Functions/route handlers and mark it `Generated from source; verify before
  publishing`.
- For Supabase/Postgres docs, prefer migrations in git. If a live DB is
  available and the user allows it, take a schema-only snapshot via the
  `project-memory` schema-snapshot command (never dump table data).
- Include RLS policies inline next to each table. Good sources are
  `supabase/migrations/*.sql`, `pg_policies`, and Supabase CLI output.
- Secret-redaction follows the `project-memory` skill: document env var names
  and owners, never the values, keys, or connection strings.

### llms.txt

Create a concise Markdown file with:

```markdown
# <Project Name>

> One-sentence project summary for LLMs and coding agents.

## Canonical docs
- [README](https://example.com/README.md): human overview and setup.
- [Plan](https://example.com/.traffic-one/plan.md): module map and public contracts.
- [API](https://example.com/.traffic-one/api.md): endpoints and auth.

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
