---
name: postgres-patterns
description: >
  PostgreSQL database patterns and best practices for schema design, native data
  types, query optimization, indexing, JSONB, partitioning, connection pooling,
  transactions, maintenance, monitoring, backups, and security.
  Triggers: "PostgreSQL best practices", "Postgres schema", "Postgres index",
  "EXPLAIN ANALYZE", "JSONB", "RLS", "pg_stat_statements", "VACUUM",
  "PgBouncer", "Postgres partitioning", "slow query".
metadata:
  origin: ECC
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  merged_sources:
    - https://github.com/Mindrally/skills/blob/main/postgresql-best-practices/SKILL.md
  adapted_for: traffic-one
---

Traffic One precedence: follow this skill only where it does not conflict with Traffic One AGENTS.md and rules/*.md. Forced stack choices, approved libraries, i18n, styling, services, state, testing, accessibility, security, and backend technology rules from Traffic One take precedence. Treat upstream examples that use unapproved frameworks or libraries as conceptual patterns to adapt.

# PostgreSQL Patterns

Quick reference for PostgreSQL implementation and review. Pair this with `postgres-review` for a focused pre-merge checklist, and with `database-migrations` for production migration sequencing.

## When to Activate

- Writing SQL queries or migrations
- Designing database schemas
- Troubleshooting slow queries
- Implementing Row Level Security
- Setting up connection pooling
- Choosing PostgreSQL native types
- Adding JSONB, partitioning, or full-text search
- Reviewing database maintenance, monitoring, backups, or lock behavior

## Core Principles

- Use PostgreSQL-native capabilities deliberately: `jsonb`, arrays, `inet`/`cidr`, full-text search, range types, partitions, and extensions where they fit the workload.
- Optimize with real plans: use `EXPLAIN (ANALYZE, BUFFERS)` for slow or hot-path queries.
- Model data with constraints first: primary keys, foreign keys, `not null`, `check`, and unique constraints.
- Keep transactions short and bounded; avoid long idle transactions and unbounded reads.
- Design for least privilege, RLS/default-deny where user data is involved, and observable maintenance.

## Quick Reference

### Schema Design

- Every table has a primary key.
- Foreign keys declare intentional `ON DELETE` / `ON UPDATE` behavior.
- Use `check` constraints for domain validation instead of relying only on application code.
- Use nullable -> backfill -> `not null` for existing large tables.
- Partition only when table size and query patterns justify it; choose `RANGE`, `LIST`, or `HASH` based on access patterns.

### Index Cheat Sheet

| Query Pattern | Index Type | Example |
|--------------|------------|---------|
| `WHERE col = value` | B-tree (default) | `CREATE INDEX idx ON t (col)` |
| `WHERE col > value` | B-tree | `CREATE INDEX idx ON t (col)` |
| `WHERE a = x AND b > y` | Composite | `CREATE INDEX idx ON t (a, b)` |
| `WHERE jsonb @> '{}'` | GIN | `CREATE INDEX idx ON t USING gin (col)` |
| `WHERE tsv @@ query` | GIN | `CREATE INDEX idx ON t USING gin (col)` |
| Time-series ranges | BRIN | `CREATE INDEX idx ON t USING brin (col)` |
| Hot filtered subset | Partial | `CREATE INDEX idx ON t (col) WHERE deleted_at IS NULL` |

### Data Type Quick Reference

| Use Case | Correct Type | Avoid |
|----------|-------------|-------|
| IDs | `bigint` identity by default; `uuid` when distributed/public IDs are needed | `int`, unnecessary random UUID hot indexes |
| Strings | `text` | `varchar(255)` |
| Timestamps | `timestamptz` | `timestamp` |
| Money | `numeric(10,2)` | `float` |
| Flags | `boolean` | `varchar`, `int` |
| Semi-structured data | `jsonb` | `json` |
| IP/network data | `inet`, `cidr` | `text` |

### Common Patterns

**Schema With Native Types:**
```sql
CREATE TABLE orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  order_data jsonb NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  total_amount numeric(12, 2) NOT NULL CHECK (total_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**Composite Index Order:**
```sql
-- Equality columns first, then range columns
CREATE INDEX idx ON orders (status, created_at);
-- Works for: WHERE status = 'pending' AND created_at > '2024-01-01'
```

**Covering Index:**
```sql
CREATE INDEX idx ON users (email) INCLUDE (name, created_at);
-- Avoids table lookup for SELECT email, name, created_at
```

**Partial Index:**
```sql
CREATE INDEX idx ON users (email) WHERE deleted_at IS NULL;
-- Smaller index, only includes active users
```

**JSONB Query:**
```sql
CREATE INDEX idx_products_metadata ON products USING gin (metadata);

SELECT id, metadata->>'brand' AS brand
FROM products
WHERE metadata @> '{"category": "electronics"}';
```

**Partitioning:**
```sql
CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_01 PARTITION OF events
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
```

**RLS Policy (Optimized):**
```sql
CREATE POLICY policy ON orders
  USING ((SELECT auth.uid()) = user_id);  -- Wrap in SELECT!
```

**UPSERT:**
```sql
INSERT INTO settings (user_id, key, value)
VALUES (123, 'theme', 'dark')
ON CONFLICT (user_id, key)
DO UPDATE SET value = EXCLUDED.value;
```

**Cursor Pagination:**
```sql
SELECT * FROM products WHERE id > $last_id ORDER BY id LIMIT 20;
-- O(1) vs OFFSET which is O(n)
```

**Slow Query Plan:**
```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT customer_id, count(*)
FROM orders
WHERE created_at >= now() - interval '30 days'
GROUP BY customer_id;
```

**Queue Processing:**
```sql
UPDATE jobs SET status = 'processing'
WHERE id = (
  SELECT id FROM jobs WHERE status = 'pending'
  ORDER BY created_at LIMIT 1
  FOR UPDATE SKIP LOCKED
) RETURNING *;
```

**Advisory Lock:**
```sql
SELECT pg_advisory_lock(hashtext('billing-close'));
-- Do bounded work.
SELECT pg_advisory_unlock(hashtext('billing-close'));
```

### Anti-Pattern Detection

```sql
-- Find unindexed foreign keys
SELECT conrelid::regclass, a.attname
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey)
  );

-- Find slow queries
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
WHERE mean_exec_time > 100
ORDER BY mean_exec_time DESC;

-- Check table bloat
SELECT relname, n_dead_tup, last_vacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC;
```

### Administration and Operations

- Use PgBouncer or pgpool-II when application connection counts exceed safe Postgres limits.
- Prefer transaction pooling for short-lived request/response workloads.
- Set bounded session timeouts: `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout`.
- Keep autovacuum enabled and tune it for high-write tables.
- Run manual `VACUUM ANALYZE` after bulk operations when statistics need to catch up.
- Use logical backups (`pg_dump`) and physical backups (`pg_basebackup`) intentionally; test restore flows.
- Use WAL archiving/PITR when the recovery point objective requires it.
- Monitor replication lag, connection count, disk usage, table bloat, locks, and slow queries.

### Configuration Template

```sql
-- Connection limits (adjust for RAM)
ALTER SYSTEM SET max_connections = 100;
ALTER SYSTEM SET work_mem = '8MB';

-- Timeouts
ALTER SYSTEM SET idle_in_transaction_session_timeout = '30s';
ALTER SYSTEM SET statement_timeout = '30s';

-- Monitoring
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Security defaults
REVOKE ALL ON SCHEMA public FROM public;

SELECT pg_reload_conf();
```

### Security Defaults

- Require SSL/TLS for remote connections.
- Use roles with minimal `GRANT` permissions; never let application users own schemas.
- Enable RLS on user-data and multi-tenant tables, with default-deny policies.
- Use `current_setting('app.tenant_id', true)` only after setting it safely per request.
- Audit sensitive operations where required by the product and compliance model.

```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_tenant_policy ON documents
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

GRANT SELECT, INSERT, UPDATE ON orders TO app_user;
```

## Related

- Skill: `postgres-review` - Focused Postgres review checklist
- Skill: `database-migrations` - Safe migration and backfill patterns
- Skill: `backend-patterns` - API and backend patterns

---

*Based on Supabase Agent Skills (credit: Supabase team) and merged with Mindrally PostgreSQL best practices.*
