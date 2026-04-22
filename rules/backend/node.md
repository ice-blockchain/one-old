---
paths:
  - "src/services/**"
  - "src/api/**"
  - "server/**"
  - "api/**"
  - "**/*.route.ts"
  - "**/*.controller.ts"
---

# Node.js / Backend Rules

## API shape (REST)
```
GET    /api/widgets            list
GET    /api/widgets/:id        read
POST   /api/widgets            create
PATCH  /api/widgets/:id        partial update
DELETE /api/widgets/:id        delete
```
- Resource URLs, nouns not verbs.
- Query params for filter/sort/pagination: `?status=active&sort=-createdAt&limit=20&cursor=...`.
- Prefer cursor pagination over `offset` once tables exceed ~10k rows.

## Layering (never skip layers)
```
route  →  controller  →  service  →  repository  →  db
```
- **Route**: binds URL to controller. No logic.
- **Controller**: parses input (zod), calls service, maps result to HTTP. No DB access.
- **Service**: business logic. Orchestrates repos. Knows nothing about HTTP.
- **Repository**: the only layer that talks to the DB.

## Validation
- Every handler validates its `body`, `query`, and `params` with a schema.
- Return `400` with the zod error flattened, never a raw stack trace.

## Errors
- One typed error hierarchy (e.g. `AppError` with `status`, `code`, `message`).
- Central error middleware maps thrown errors → HTTP.
- Log with request id; never log secrets or full request bodies containing PII.

## Async & performance
- Always `await` — unhandled promise rejections crash Node.
- Cache read-heavy endpoints (HTTP cache headers or Redis).
- Long jobs go to a queue (BullMQ, pg-boss) — never block the request.
- Connection pool sized to `cpu_cores × 2` as a starting point; tune via load test.

## Dependencies (backend)
- HTTP client: `axios` or native `fetch` — wrapped in a typed client module.
- DB: parameterized queries only (`pg`, `drizzle`, `prisma`, `supabase-js`).
- Auth: battle-tested libs (`jsonwebtoken`, provider SDK) — never hand-roll crypto.
