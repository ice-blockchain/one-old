---
paths:
  - "src/services/**"
  - "src/api/**"
  - "server/**"
  - "api/**"
  - "**/*.route.ts"
  - "**/*.controller.ts"
---

# Node.js Backend Rules

## REST shape
```
GET /api/widgets            list
GET /api/widgets/:id        read
POST /api/widgets           create
PATCH /api/widgets/:id      partial update
DELETE /api/widgets/:id     delete
```
- Resource nouns. Query params for filter/sort/pagination.
- Cursor pagination once tables exceed ~10k rows.

## Layering — never skip
`route → controller → service → repository → db`
- **Controller**: zod-validate input, call service, map to HTTP. No DB.
- **Service**: business logic. No HTTP.
- **Repository**: only layer that talks to DB.

## Validation & errors
- Validate body / query / params with zod in every handler.
- Return 400 with flattened zod errors — never raw stack traces.
- One typed error hierarchy; central middleware maps to HTTP.
- Log with request id; never log secrets or PII.

## Async & performance
- Always `await`. Cache read-heavy endpoints. Long jobs → queue (BullMQ, pg-boss).
- Connection pool: `cpu_cores × 2` starting point.

## Dependencies
- Parameterised SQL only (`pg`, `drizzle`, `prisma`, `supabase-js`).
- Auth: battle-tested libs (`jsonwebtoken`, provider SDK) — never hand-roll crypto.
