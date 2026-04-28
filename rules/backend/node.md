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
- Resource nouns: `GET/POST/PATCH/DELETE /api/widgets[/:id]`.
- Query params for filter/sort/pagination. Cursor pagination >10k rows.
- Public response shapes are typed DTOs with a consistent envelope: `success`, `data`, `error`, and optional `meta`.
- Do not leak raw DB rows, ORM entities, or internal field names.
- Paginated responses include typed metadata (`cursor`/`nextCursor` or `total`/`page`/`limit`) that matches the endpoint contract.

## Layering — never skip
`route → controller → service → repository → db`
- **Route**: wires middleware and delegates to the controller. No business logic.
- **Controller**: zod-validate params/query/body, call service, map service results/errors to HTTP DTOs. No DB.
- **Service**: business logic over typed input/output DTOs. No HTTP response objects.
- **Repository**: only layer that talks to DB; expose a small typed contract instead of query-builder details.
- Business logic depends on repository contracts, not concrete storage. Use domain operations (`findById`, `create`, `update`, `delete`, or clearer domain verbs) where they fit.

## Validation & errors
- Validate body / query / params with zod in every handler.
- Treat request data, upstream API responses, and DB-adjacent parsing as `unknown` until schema-validated.
- Return 400 with flattened zod errors — never raw stack traces.
- One typed error hierarchy; central middleware maps to HTTP. Log with request id.
- No `console.log` in production server code; use the project logger and strip secrets/PII.

## Security & abuse controls
- Rate-limit public endpoints, auth endpoints, search, and state-changing operations.
- Cookie/session-authenticated state-changing endpoints require CSRF protection.
- Protected endpoints require both authentication and authorization checks in the service/controller path; UI gating never counts.
- CORS must be restrictive; never use wildcard origins for credentialed endpoints.

## Security review triggers
- Stop for a focused security pass when touching auth/authz, database queries, filesystem access, crypto, payment/financial flows, external API calls, or user input handling.
- Also review changes that introduce new external inputs, new response DTOs, or new persistence boundaries.

## Async & performance
- Always `await`. Cache read-heavy endpoints. Long jobs → queue (BullMQ, pg-boss).
- Connection pool `cpu_cores × 2` starting point.
- Large reads must be paginated or otherwise bounded; never ship unbounded list endpoints.
- Watch for N+1 query loops; batch with `IN (...)`, joins, or repository methods designed for bulk access.
- Cache expensive read paths only after defining invalidation/staleness behavior.

## Testing
- Unit-test services, mappers, repositories with fakes, and error mapping.
- Integration-test API endpoints with real routing/middleware and mocked external services.
- Integration-test database operations that cover constraints, authorization filters, pagination metadata, and failure paths.

## Dependencies
- Parameterised SQL only (`pg`, `drizzle`, `prisma`, `supabase-js`).
- Auth: battle-tested libs (`jsonwebtoken`, provider SDK). Never hand-roll crypto.
