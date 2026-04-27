---
paths:
  - "apps/**/src/services/**"
  - "apps/**/src/features/**/services/**"
  - "apps/**/src/lib/**"
  - "apps/**/src/utils/**"
  - "packages/api-client/**"
  - "src/services/**"
  - "src/features/**/services/**"
  - "src/lib/**"
  - "src/utils/**"
---

# React + Vite Frontend Security

Baseline application-security rules live in `common/security.md`. This file covers
React + Vite + browser-specific concerns.

## Authentication & tokens

- Never store JWT access tokens in `localStorage` — use `httpOnly` cookies or in-memory only.
- Never log tokens, passwords, or PII to the console.
- Always validate token expiry client-side before making sensitive requests.
- Auth state lives in a Redux slice; the axios interceptor reads from it — nothing else should.
- Refresh-token flow: implement once in `packages/api-client`, never per feature.

## API calls

- Never interpolate user input directly into URL paths — use parameterised route helpers.
- Validate all user-supplied data with a Zod schema **before** sending to the API.
- Never expose API keys or secrets in frontend code — use `VITE_`-prefixed env vars only for non-secret config; route secret-bearing requests through a server-side proxy.

## XSS

- Never use `dangerouslySetInnerHTML` unless the content is explicitly sanitised with DOMPurify.
- Never `eval()` or `new Function()` with user-supplied strings.
- Avoid template-string SQL/HTML construction in shared utilities; if it must exist, gate behind a typed wrapper that escapes.

## CSRF

- For cookie-based auth, set `SameSite=Lax` (or `Strict` where possible) and `Secure` on cookies.
- Use double-submit token or `fetch` with `credentials: "include"` + CSRF header pattern — never trust origin alone.
- WebSockets: send auth in the connection URL or first message, never via cookies.

## Environment variables

- All env vars exposed to the browser must be prefixed `VITE_`.
- Document each var in `.env.example` — never commit `.env` or `.env.local`.
- Secret env vars (server-side API keys, Edge Function secrets) must never appear in `VITE_`-prefixed vars.
- Validate presence at startup: throw on missing critical vars rather than failing later in a request.

## Dependency hygiene

- Pin major versions. Run `npm audit` (or `pnpm audit`) on every install; fail CI on high+ severity.
- Avoid postinstall scripts from untrusted packages — review additions to `package.json`.
- Lockfile committed; never edit by hand.

## Content Security Policy

- Ship a strict CSP header in production. At minimum: `default-src 'self'; script-src 'self'; connect-src 'self' wss://<your-ws-host>`.
- No `unsafe-inline` for scripts. vanilla-extract emits static CSS, so styles can stay strict too.
- Report violations to a dedicated endpoint during rollout.
