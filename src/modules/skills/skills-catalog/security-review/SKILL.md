---
name: security-review
description: >
  Use PROACTIVELY whenever the user asks to review, audit, or check code for security issues,
  or when writing authentication, authorization, token handling, or any code that touches
  user data, passwords, secrets, or environment variables.
  Triggers: "review security", "is this secure", "check for vulnerabilities", "auth",
  "JWT", "token", "password", "env var", "API key", "dangerouslySetInnerHTML".
metadata:
  source: everything-claude-code
  source_path: skills/security-review/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Skill: Security Review

Use a code-review stance: list concrete findings first, with severity and file/line references when possible. For implementation tasks, state the security assumptions and apply the smallest fix that satisfies the local rules.

## Traffic One Checklist

1. Secrets: no hardcoded secrets, no frontend secrets in `VITE_`, required env vars checked at startup.
2. Input: validate request bodies, query params, route params, deep links, and user-supplied data with Zod or the local schema layer.
3. Auth: protected endpoints enforce authentication and authorization server-side; UI gating never stands alone.
4. Provider-first auth: Next.js uses NextAuth/Auth.js unless an existing provider is present; Supabase uses Supabase Auth + RLS; other stacks use framework/provider auth before custom JWT/session/password code.
5. Tokens: never store JWT access tokens in `localStorage`; prefer httpOnly cookies or in-memory state per app rules.
6. Data access: parameterized SQL only, bounded reads, no N+1 loops, RLS/default-deny policies for user-data tables.
7. Browser safety: avoid unsafe HTML; if `dangerouslySetInnerHTML` is unavoidable, sanitize and review CSP.
8. Files and uploads: validate size, type, extension, storage path, and authorization before read/write.
9. Errors and logs: no stack traces in production responses; strip secrets and PII from client/server logs.
10. Dependencies: run the local dependency quality gate before adding packages; no high+ audit findings.
11. Pre-deploy: before release/publish/deploy approval, run `predeploy-security-check` and require a fresh passing `lastSecurityCheck*` stamp matching the current worktree.

## Additional Review Coverage

For broader reviews, cover API endpoints, third-party integrations, payments,
cloud deployment, and CI/CD through Traffic One-approved libraries and
architecture:

- Treat all external data as `unknown` until schema-validated.
- Confirm CSRF protection, rate limiting, secure cookies, HSTS/nosniff/frame/referrer/permissions headers, and concrete CSP origins for state-changing or public endpoints.
- For cloud or deployment reviews, also consult `cloud-infrastructure-security.md`; adapt provider examples to the project’s actual platform and never introduce new SDKs without the dependency gate.
- For payment or sensitive flows, verify least-privilege access, idempotency, audit logging, webhook signature verification, replay protection, and non-leaky error handling.
