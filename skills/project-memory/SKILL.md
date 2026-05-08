---
name: project-memory
description: >
  Create, refresh, or audit the Traffic One `.traffic-one/` project memory
  folder for persistent AI coding-agent context: product.md, decisions ADRs,
  coding/security rules, schema.sql, deployments.jsonl, known-issues.md,
  stack.md, .agentignore, agent-log.md, mcp.json, and reusable local skills.
  Trigger on "project memory", ".traffic-one folder", "agent memory",
  "persistent context", "agent-log", "known issues", "mcp.json", or requests
  to make agent context survive across Claude Code, Codex, Cursor, or future
  agents.
metadata:
  adapted_for: traffic-one
---

Traffic One precedence: follow this skill only where it does not conflict with
Traffic One AGENTS.md and rules/*.md. Security, deployment, stack, and docs
rules from Traffic One take precedence.

# Project Memory

Use this skill to create or reconcile the `.traffic-one/` project-memory folder.
The goal is persistent, compact context for humans and AI coding agents, not
another long docs tree.

## When to Use

- The user asks for project memory, persistent context, or `.traffic-one/`.
- Starting a new Traffic One project.
- Reconciling an existing project before normal feature work.
- A migration, deployment, significant decision, known bug, stack change, or MCP
  setup changes project context.

## Required Baseline

Create or refresh:

- root `.traffic-one.json` with the Traffic One state schema when it is missing
  or incomplete
- `.traffic-one/product.md`
- `.traffic-one/decisions/README.md` and ADR files as needed
- `.traffic-one/rules/coding.md`
- `.traffic-one/rules/security.md`
- `.traffic-one/rules/AGENTS.md`
- root `AGENTS.md` symlink to `.traffic-one/rules/AGENTS.md` when safe, or a
  generated root file from the same source when symlinks are not appropriate
- root `CLAUDE.md` generated from the same source for Claude Code compatibility
- `.traffic-one/schema.sql`
- `.traffic-one/deployments.jsonl`
- `.traffic-one/known-issues.md`
- `.traffic-one/stack.md`
- `.traffic-one/.agentignore`
- `.traffic-one/agent-log.md`
- `.traffic-one/mcp.json`
- `.traffic-one/skills/` when reusable team commands are needed

## Guardrails

- Keep files concise and source-backed. Mark unknown facts `Unverified`.
- `.traffic-one/` does not replace root `.traffic-one.json`; create or repair
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
- Keep `.traffic-one/digests/`, `.traffic-one/reports/`, and `graphify-out/`
  local/ephemeral unless the user explicitly asks to preserve a report.

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
```

### `.traffic-one/rules/coding.md`

```markdown
# Coding Rules

- Follow the active Traffic One stack rules.
- Keep changes scoped to the requested behavior.
- Validate external input at boundaries.
- Unverified project-specific rule:
```

### `.traffic-one/rules/security.md`

```markdown
# Security Rules

- No secrets in client, mobile, docs, fixtures, or logs.
- No Supabase service-role key outside server-only environments.
- Do not use `user_metadata` in RLS policies.
- Secrets are referenced by env var name only.
```

### `.traffic-one/mcp.json`

```json
{
  "servers": [],
  "notes": "List MCP servers by name, command/scope, and required env var names only. No secret values."
}
```

### `.traffic-one/deployments.jsonl`

Create the file empty. Append one line per deploy:

```json
{"timestamp":"2026-05-08T00:00:00Z","commit":"<sha>","environment":"staging","actor":"<user-or-agent>","trigger":"manual","result":"success","url":"https://example.com","rollbackId":"<id>"}
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
