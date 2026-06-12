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

Work through the always-on security baseline in `rules/common/security.md`
item by item (secrets, schema-validated input, parameterized SQL, escaped HTML,
server-side auth + authorization, provider-first auth, rate limiting, sanitized
errors, gitignored env files, restrictive CORS) — that rule is the source of
truth; do not restate or fork it here. Then add these review-only checks:

1. Tokens: never store JWT access tokens in `localStorage`; prefer httpOnly cookies or in-memory state per app rules.
2. Data access beyond injection: bounded reads, no N+1 loops, RLS/default-deny policies for user-data tables.
3. Files and uploads: validate size, type, extension, storage path, and authorization before read/write.
4. Frontend env discipline: no secrets in `VITE_`-prefixed (client-exposed) variables.
5. Pre-deploy: before release/publish/deploy approval, run `predeploy-security-check` and require a fresh passing `lastSecurityCheck*` stamp matching the current worktree.

## Additional Review Coverage

For broader reviews, cover API endpoints, third-party integrations, payments,
cloud deployment, and CI/CD through Traffic One-approved libraries and
architecture:

- Treat all external data as `unknown` until schema-validated.
- Confirm CSRF protection, rate limiting, secure cookies, HSTS/nosniff/frame/referrer/permissions headers, and concrete CSP origins for state-changing or public endpoints.
- For cloud or deployment reviews, also consult `cloud-infrastructure-security.md`; adapt provider examples to the project’s actual platform and never introduce new SDKs without the dependency gate.
- For payment or sensitive flows, verify least-privilege access, idempotency, audit logging, webhook signature verification, replay protection, and non-leaky error handling.
