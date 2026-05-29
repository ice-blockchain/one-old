---
name: project-memory
description: >
  Create, refresh, or audit the Traffic One `.traffic-one/` project memory
  folder for persistent AI coding-agent context: product.md, decisions ADRs,
  coding/security rules, schema.sql, deployments.jsonl, known-issues.md,
  stack.md, .agentignore, agent-log.md, and reusable local skills.
  Trigger on "project memory", ".traffic-one folder", "agent memory",
  "persistent context", "agent-log", "known issues", or requests
  to make agent context survive across all supported host agents, or future
  agents.
metadata:
  source: everything-claude-code
  source_path: skills/codebase-onboarding/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
  merged_source_paths:
    - skills/codebase-onboarding/SKILL.md
---

# Project Memory

Use this skill to create or reconcile the `.traffic-one/` project-memory folder.
The goal is persistent, compact context for humans and AI coding agents, not
another long docs tree.

## When to Use

- The user asks for project memory, persistent context, or `.traffic-one/`.
- Starting a new Traffic One project.
- Reconciling an existing project before normal feature work.
- A migration, deployment, significant decision, known bug, or stack change
  changes project context.

## Reconnaissance Workflow

For an existing project, build memory from verified local facts:

1. Respect `.traffic-one/.agentignore` if it already exists.
2. Use `rg --files` plus targeted reads of manifests and configs before broad
   source inspection.
3. Identify package manager, workspace layout, runtime pins, framework,
   backend/database, deploy target, CI, test runners, and lint/format scripts.
4. Locate app entrypoints, routes, API handlers, native packaging config,
   migrations/schema, realtime services, and integration boundaries.
5. Note the commands that verify the main path: build, typecheck, lint, unit,
   integration, E2E, security scan, and deploy dry run where available.
6. Write concise onboarding artifacts. Do not paste directory trees, full
   command output, source excerpts, or chat history into memory.

## Required Baseline

Create or refresh:

- root `.traffic-one/.one.json` with the Traffic One state schema when it is missing
  or incomplete
- `.traffic-one/product.md`
- `.traffic-one/decisions/README.md` and ADR files as needed
- `.traffic-one/coding.md`
- `.traffic-one/security.md`
- `.traffic-one/api.md`, `.traffic-one/database.md`,
  `.traffic-one/deployment.md`, and `.traffic-one/environment-setup.md` when
  those operational docs apply; root copies are legacy and should be merged
  into `.traffic-one/`
- `.traffic-one/rules/**` generated active rule files only
- `.traffic-one/manifest.json` generated active bundle manifest
- root `AGENTS.md` containing the compact active rule kernel/index by default
- root `CLAUDE.md` symlinked to root `AGENTS.md` only when no `CLAUDE.md`
  exists; preserve and merge existing `AGENTS.md` and `CLAUDE.md` content in
  place with Traffic One managed blocks
- `.traffic-one/schema.sql`
- `.traffic-one/deployments.jsonl`
- `.traffic-one/known-issues.md`
- `.traffic-one/stack.md`
- `.traffic-one/.agentignore`
- `.traffic-one/agent-log.md`
- `.traffic-one/skills/` when reusable team commands are needed
- generated active stack bundle: `.traffic-one/rules/**`,
  `.traffic-one/manifest.json`, `.traffic-one/skills/`, root `AGENTS.md`, and
  root `CLAUDE.md`

## Guardrails

- Keep files concise and source-backed. Mark unknown facts `Unverified`.
- `.traffic-one/` does not replace root `.traffic-one/.one.json`; create or repair
  the root state file before feature-source work so hooks and agents know the
  project mode, stack, backend, and deploy/security stamps.
- Never write secret values, service-role keys, DB passwords, production
  connection strings, or raw customer data.
- Append to `agent-log.md` and `deployments.jsonl`; do not rewrite history
  except to redact an accidentally logged secret.
- Use `.traffic-one/decisions/` as the canonical ADR path. Migrate or mirror
  legacy root `adr/` files only when safe.
- Refresh `schema.sql` after each migration. Prefer migrations or
  `pg_dump --schema-only --no-owner --no-privileges`; never dump table data.
- Keep `.traffic-one/digests/`, `.traffic-one/reports/`, `.traffic-one/backups/`,
  `graphify-out/`, and `.gitnexus/` local/ephemeral unless the user explicitly
  asks to preserve a report. The codebase-graph artefact location depends on
  the current user's local `codeGraphProvider` preference.
- Treat memory as continuity, not a transcript. Store stable facts, decisions,
  failed approaches, current work state, and "next session" handoffs; do not
  paste chat history or bulky generated output.
- Do not hand-create active rule or skill bundles. After the complete
  `.traffic-one/.one.json` state exists, rely on the generic post-tool materializer
  hook or run
  `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime.cjs" materialize-project`
  from the project root. Feature-source work must wait until `.traffic-one/.one.json`
  has `materializedStack`, `materializedAt`, and `materializedVersion`.
  Never write those `materialized*` fields by hand; they are valid only when
  the materializer also created `.traffic-one/manifest.json`,
  `.traffic-one/rules/**`, `.traffic-one/skills/**`, root `AGENTS.md`, and root
  `CLAUDE.md`. Existing root `AGENTS.md` and `CLAUDE.md` files are merged in
  place and must not be replaced.
- For user-facing/product work, capture audience, tone, voice, words to avoid,
  and permanent facts only when the user or codebase provides them. Mark guesses
  `Unverified`.

## Minimal File Templates

### `.traffic-one/product.md`

```markdown
# Product

## User
- Unverified:

## Job To Be Done
- Unverified:

## Core Workflow
- Unverified:

## Success Metric
- Unverified:

## Non-Goals
- Unverified:

## Voice And Tone
- Unverified:

## Permanent Facts
- Unverified:
```

### `.traffic-one/coding.md`

```markdown
# Coding Rules

- Follow the active Traffic One stack rules.
- Keep changes scoped to the requested behavior.
- Validate external input at boundaries.
- Unverified project-specific rule:
```

### `.traffic-one/security.md`

```markdown
# Security Memory

## Non-Negotiables
- No secrets in client, mobile, docs, fixtures, or logs.
- No Supabase service-role key outside server-only environments.
- Do not use `user_metadata` in RLS policies.
- Secrets are referenced by env var name only.

## App And Data Rules
- Unverified:

## Release Gate
- Run the project security/predeploy check before production promotion.
```

### `.traffic-one/deployments.jsonl`

Create the file empty. Append one line per deploy:

```json
{"timestamp":"2026-05-08T00:00:00Z","commit":"<sha>","environment":"staging","actor":"<user-or-agent>","trigger":"manual","result":"success","url":"https://example.com","rollbackId":"<id>"}
```

### `.traffic-one/known-issues.md`

```markdown
# Known Issues And Failed Approaches

## Open Issues
- Unverified:

## Failed Approaches
- Task:
- What did not work:
- What worked:
- Note for next time:
```

### `.traffic-one/agent-log.md`

Append entries in this shape:

```markdown
## Session Summary, <ISO date>
**Worked on:** <focus>
**Completed:** <done>
**In progress:** <started but not done>
**Decisions made:** <key choices>
**Verification:** <commands/checks or unverified>
**Next session:** <first thing to pick up>
```

## Output Format

End with:

```markdown
PROJECT MEMORY REPORT
=====================

Updated:
- <file> - <what changed>

Created:
- <file> - <why it was needed>

Unverified:
- <fact> - <command/input needed>

Skipped:
- <file> - <reason>
```
