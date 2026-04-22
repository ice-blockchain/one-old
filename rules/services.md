---
paths:
  - "src/services/**"
  - "src/features/**/services/**"
---

# Service Layer Rules

- Service functions are **plain async functions** — not hooks, not classes.
- Always type the return value explicitly — never `any` or implicit `unknown`.
- The shared axios instance lives in `src/services/api.ts`. All service files import from there.
- One file per domain: `users.ts`, `products.ts`, `orders.ts`.
- Wrap every call in try/catch only if you're transforming the error — otherwise let React Query handle it.
- Never access `localStorage`, cookies, or auth tokens inside service functions — pass them as arguments or read from the axios interceptor.
- Interceptors for auth headers and error handling live in `src/services/api.ts` only.

## api.ts baseline
```ts
import axios from 'axios';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = /* read from store or cookie */ null;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => Promise.reject(err),
);
```
