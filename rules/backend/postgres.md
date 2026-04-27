---
paths:
  - "**/*.sql"
  - "supabase/migrations/**"
  - "db/migrations/**"
  - "prisma/schema.prisma"
  - "src/services/**"
  - "src/lib/db/**"
---

# PostgreSQL Rules

## Data types
| Use case | Correct | Avoid |
|---|---|---|
| IDs | `bigint` / `uuid` | `int` |
| Strings | `text` | `varchar(n)` |
| Timestamps | `timestamptz` | `timestamp` |
| Money | `numeric(12,2)` | `float` |
| JSON | `jsonb` | `json` |

## Indexes
- B-tree default. Composite `(a, b)` with equality columns first.
- `GIN` for `jsonb @>` and full-text. `BRIN` for wide time-series ranges.
- Partial: `WHERE deleted_at IS NULL`. Covering: `INCLUDE (...)`.

## Queries
- Parameterised only — never string interpolation.
- Every hot query: `EXPLAIN ANALYZE` shows index usage (no `Seq Scan` on large tables).
- No `SELECT *` in services. No N+1 — batch with `IN (...)` or JOIN.

## Migrations
- One concern per migration. Reversible where feasible.
- Non-null on big table: nullable → backfill in batches → NOT NULL.
- Drops are two-phase (stop reading → deploy → drop).

## RLS (multi-tenant)
- ON for every user-data table. Default-deny. Per-role per-action policies.
- Never rely on client-side tenant filtering. Test with anon + authed in CI.

## Connections
- Pooler (PgBouncer / Supavisor) in serverless or high-concurrency apps.
- Transaction-mode pooling breaks prepared statements — match driver config.
