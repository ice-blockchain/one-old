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
- Resource nouns: `GET/POST/PATCH/DELETE /api/widgets[/:id]`. Cursor pagination >10k rows.
- Public response is a typed DTO with envelope: `success`, `data`, `error`, optional `meta`.
- Never leak raw DB rows / ORM entities / internal field names.
- Paginated responses include typed metadata matching the endpoint contract.

## Layering — never skip
`route → controller → service → repository → db`
- **Route**: middleware wiring, delegates. No business logic.
- **Controller**: zod-validate params/query/body, call service, map results/errors to HTTP DTOs. No DB.
- **Service**: business logic over typed I/O DTOs. No HTTP response objects.
- **Repository**: only layer talking to DB; small typed contract, not query-builder details.
- Business logic depends on repository contracts, not concrete storage.

## Validation & errors
- zod-validate every handler input. Treat upstream/DB data as `unknown` until validated.
- Return 400 with flattened zod errors. One typed error hierarchy; central middleware maps to HTTP.
- Log with request id; never log secrets/PII. No `console.log` in production.

## Security & abuse
- Rate-limit public endpoints, auth, search, state-changing routes.
- Cookie/session auth requires CSRF protection. CORS restrictive — no wildcard for credentialed.
- Auth + authorization in the server path; UI gating never counts.
- Security pass when touching: authn/authz, DB, fs, crypto, payments, external APIs, user input, new DTOs, new persistence.

## Async & performance
- Always `await`. Cache reads only after defining invalidation/staleness.
- Long jobs → queue (BullMQ, pg-boss). Pool: `cpu_cores × 2` start.
- Bounded reads (LIMIT / cursor / hard cap). Watch N+1; batch with `IN (...)` / joins.

## Testing
- Unit: services, mappers, repos with fakes, error mapping.
- Integration: API endpoints (real routing/middleware, mocked externals); DB ops (constraints, auth filters, pagination, failure paths).

## Dependencies
- Parameterised SQL only (`pg`, `drizzle`, `prisma`, `supabase-js`).
- Auth: battle-tested libs. Never hand-roll crypto.
