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

Applies to any project using PostgreSQL — including Supabase and compatible forks.

## Data types (use these, not the tempting alternatives)

| Use case     | Correct          | Avoid                |
|--------------|------------------|----------------------|
| IDs          | `bigint` / `uuid` | `int`, random uuid in hot path |
| Strings      | `text`           | `varchar(n)` (no perf benefit in PG) |
| Timestamps   | `timestamptz`    | `timestamp` (silent TZ bugs) |
| Money        | `numeric(12,2)`  | `float` / `real` |
| Flags        | `boolean`        | `int`, `char(1)` |
| JSON         | `jsonb`          | `json` (unless strict ordering needed) |

## Indexing cheat sheet

| Query shape                        | Index type       |
|------------------------------------|------------------|
| `WHERE col = v` / `col > v`        | B-tree (default) |
| `WHERE a = x AND b > y`            | Composite `(a, b)` — equality first |
| `WHERE jsonb @> '{}'`              | `GIN`            |
| Full-text search                   | `GIN` on `tsvector` |
| Wide time-series ranges            | `BRIN`           |
| Only-active rows                   | Partial: `WHERE deleted_at IS NULL` |
| Covering projection                | `INCLUDE (...)`  |

## Query rules
- NEVER build SQL via string interpolation — parameterize.
- Every hot query must have an `EXPLAIN ANALYZE` that shows index usage (no `Seq Scan` on big tables).
- Avoid `SELECT *` in services — list columns.
- Beware N+1: batch with `IN (...)` or a join; never loop queries in app code.

## Migrations
- One concern per migration. Reversible where feasible.
- Adding a non-null column to a large table: add nullable → backfill in batches → add NOT NULL.
- Never drop a column in the same deploy as the code that stops reading it — two-phase.
- Every migration is reviewed; no ad-hoc schema changes in production.

## Row Level Security (Supabase / any multi-tenant PG)
- RLS ON for every table with user data. No exceptions.
- Default deny; policies added per role per action (`SELECT`, `INSERT`, `UPDATE`, `DELETE`).
- Never rely on client-side filtering for tenancy — enforce in the DB.
- Test policies with anon + authed roles as part of CI.

## Connections
- Use a pooler (PgBouncer / Supavisor) in serverless or high-concurrency apps.
- Transaction-mode pooling breaks prepared statements — match your driver config.
