---
paths:
  - "apps/**/src/services/**"
  - "apps/**/src/features/**/services/**"
  - "packages/api-client/**"
  - "packages/ws-client/**"
  - "src/services/**"
  - "src/features/**/services/**"
---

# Service Layer Rules

Two service flavours: REST (axios or RTK Query) and real-time (WebSocket). Both are
isolated from components.

## REST — axios services or RTK Query

### When to use which
- **RTK Query** for any data that benefits from caching, refetching, or shared subscriptions across components (most reads).
- **Plain axios service** for one-off mutations, file uploads, or anything where RTK Query's cache adds no value.

### Plain axios service rules
- Plain async functions — not hooks, not classes.
- Explicit return type. No `any`, no implicit `unknown`.
- One file per domain: `users.ts`, `bets.ts`, `markets.ts`.
- Shared axios instance in `packages/api-client` (or `apps/<name>/src/services/api.ts` for app-only).
- Never access localStorage, cookies, or auth tokens inside service functions — pass as arguments, or read in the request interceptor.
- Wrap in try/catch only when you're transforming the error.

### RTK Query rules
- One `createApi` per logical service domain. Endpoints typed end-to-end with zod-inferred types or hand-rolled interfaces.
- Tag-based invalidation: every mutation lists `invalidatesTags`; every query lists `providesTags`.
- Never call `fetchBaseQuery` directly in a component; use the generated hooks (`useGetMarketsQuery`, `useCreateBetMutation`).
- Polling and refetch-on-focus are explicit per-endpoint, not global defaults.

## api-client baseline (shared package)

```ts
// packages/api-client/src/instance.ts
import axios from "axios";

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
  headers: { "Content-Type": "application/json" },
  timeout: 10_000,
});

apiClient.interceptors.request.use((config) => {
  const token = readAuthToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiClient.interceptors.response.use(
  (res) => res,
  (err) => {
    // Map server errors to a typed AppError; never leak axios internals upstream.
    return Promise.reject(toAppError(err));
  },
);
```

## WebSocket — see rules/realtime.md

WebSocket logic lives in `packages/ws-client` (shared) or `apps/<name>/src/services/ws/`.
- Singleton connection per endpoint.
- Components subscribe via hooks (`useChannel`, `useGameTick`) — never call `new WebSocket()` from a component.
- See `rules/realtime.md` for reconnection, back-pressure, and consistency rules.

## Error contract

- Every service surface (REST + WS) maps transport errors to a typed `AppError` hierarchy:
  ```ts
  type AppError =
    | { kind: "network"; retryable: true }
    | { kind: "auth"; status: 401 | 403 }
    | { kind: "validation"; issues: ZodIssue[] }
    | { kind: "server"; status: number; message: string };
  ```
- Components branch on `error.kind` — never on `error.message` or `error.status`.

## Validation
- Validate every response body with zod at the service boundary. Treat `unknown` until validated.
- Trust no payload from the server, even on 200.
