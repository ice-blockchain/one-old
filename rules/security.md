---
paths:
  - "src/services/**"
  - "src/features/**/services/**"
  - "src/lib/**"
  - "src/utils/**"
---

# Security Rules

## Authentication & tokens
- Never store JWT access tokens in `localStorage` — use `httpOnly` cookies or in-memory only.
- Never log tokens, passwords, or PII to the console.
- Always validate token expiry client-side before making sensitive requests.
- Auth state lives in a Zustand store; the axios interceptor reads from it — nothing else should.

## API calls
- Never interpolate user input directly into URL paths — use parameterised route helpers.
- Validate all user-supplied data with a Zod schema **before** sending to the API.
- Never expose API keys or secrets in frontend code — use `VITE_` env vars and server-side proxies for secrets.

## XSS
- Never use `dangerouslySetInnerHTML` unless the content is explicitly sanitised with DOMPurify.
- Never `eval()` or `new Function()` with user-supplied strings.

## Dependency hygiene
- Never install packages with `--ignore-scripts` disabled (i.e., always allow build scripts only for trusted packages).
- Pin major versions. Run `npm audit` after every install.

## Environment variables
- All env vars exposed to the browser must be prefixed `VITE_`.
- Document each var in `.env.example` — never commit `.env` or `.env.local`.
- Secret env vars (API keys for server actions, Edge Functions) must never appear in `VITE_`-prefixed vars.
