---
name: verification-loop
description: "A comprehensive verification system for Claude Code sessions, including local-evidence production audits and Production-Readiness Score audits for SPA + Supabase and Ionic releases."
metadata:
  source: everything-claude-code
  source_path: skills/verification-loop/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
  merged_source_paths:
    - skills/production-audit/SKILL.md
---

Traffic One precedence: follow this skill only where it does not conflict with Traffic One AGENTS.md and rules/*.md. Forced stack choices, approved libraries, i18n, styling, services, state, testing, accessibility, security, and backend technology rules from Traffic One take precedence.

# Verification Loop Skill

A comprehensive verification system for Claude Code sessions.

## When to Use

Invoke this skill:
- After completing a feature or significant code change
- Before creating a PR
- When you want to ensure quality gates pass
- After refactoring
- When asked for a production-readiness, shipability, launch, or "safe to ship" score
- When asked "what breaks in production", "is this ready to ship", "what did we
  miss", or "audit launch risk"

## Verification Phases

### Phase 1: Build Verification
```bash
# Check if project builds
npm run build 2>&1 | tail -20
# OR
pnpm build 2>&1 | tail -20
```

If build fails, STOP and fix before continuing.

### Phase 2: Type Check
```bash
# TypeScript projects
npx tsc --noEmit 2>&1 | head -30

# Python projects
pyright . 2>&1 | head -30
```

Report all type errors. Fix critical ones before continuing.

### Phase 3: Lint Check
```bash
# JavaScript/TypeScript
npm run lint 2>&1 | head -30

# Python
ruff check . 2>&1 | head -30
```

### Phase 4: Test Suite
```bash
# Run tests with coverage
npm run test -- --coverage 2>&1 | tail -50

# Check coverage threshold
# Target: 80% minimum
```

Report:
- Total tests: X
- Passed: X
- Failed: X
- Coverage: X%

### Phase 5: Security Scan
```bash
# Traffic One pre-deploy scanner
node "${CLAUDE_PLUGIN_ROOT:-.}/scripts/security-check-runner.cjs" --strict --no-stamp

# Check for secrets
grep -rn "sk-" --include="*.ts" --include="*.js" . 2>/dev/null | head -10
grep -rn "api_key" --include="*.ts" --include="*.js" . 2>/dev/null | head -10

# Check for console.log
grep -rn "console.log" --include="*.ts" --include="*.tsx" src/ 2>/dev/null | head -10
```

### Phase 6: Diff Review
```bash
# Show what changed
git diff --stat
git diff HEAD~1 --name-only
```

Review each changed file for:
- Unintended changes
- Missing error handling
- Potential edge cases
- Hidden coupling introduced by AI-generated code
- Security/auth assumptions and rollout risk

### Phase 6b: Local-Evidence Production Audit

Use this when the user asks about launch risk, production readiness, or what
could break in production. Build the audit from local and user-authorized
evidence only; do not upload source or run unpinned external scanners by
default.

Start with:

```bash
git status --short --branch
git log --oneline --decorate -20
git diff --stat origin/main...HEAD
```

Then inspect the surfaces that exist in the repo:

- package scripts, CI workflows, Docker/deploy manifests, release scripts
- auth middleware, API routes, webhooks, background jobs, and migrations
- env documentation and startup validation
- logs, error reporting, health checks, dashboards, and rollback notes
- E2E coverage for launch-critical user paths

Risk lenses:

- **Security/auth**: server-side authz, secret handling, rate limits, CSRF,
  CORS, uploads, and AI/tool abuse boundaries.
- **Data integrity**: safe migrations, RLS/grants, idempotent writes, retries,
  backfills, and recovery path.
- **Payments/webhooks**: signature verification, idempotency, replay handling,
  live/test credential separation.
- **Operations**: clean-checkout startup, env validation, health checks,
  rollback, incident owner path, useful logs without secrets.
- **User experience**: desktop/mobile critical flows, loading/empty/error
  states, permission-denied states, support/recovery path.

Output a one-sentence ship/block recommendation, then blockers, high-value
fixes, evidence checked, evidence missing, and one next action.

### Phase 7: Production-Readiness Score

Use this phase when the user asks whether an SPA + Supabase app, React/Ionic
Capacitor app, or preview/prod release is actually shippable. Score only from
verified evidence. If evidence is missing, mark the item `UNVERIFIED` and award
partial or no credit instead of assuming it exists.

Score out of 100 across 8 weighted dimensions:

| Dimension | Weight | Evidence |
| --- | ---: | --- |
| Security and privacy | 18 | Traffic One pre-deploy scanner / Section 1 security gate passes; OWASP Top 10:2025 risks are addressed; ASVS-relevant auth, session, access control, validation, and logging controls exist; secrets are rotated after exposure; RLS is enabled on every public Supabase table; sensitive/PII columns have least-privilege access. |
| Code quality | 12 | Build, typecheck, lint, and tests pass; no `any` in critical auth/payment/data paths; no dead routes; no unresolved `TODO`/`FIXME` in payment, auth, RLS, or deployment code. |
| Architecture and config | 12 | UI, data access, and business logic are separated; state ownership is consistent; no god component/service; config follows 12-factor environment config. |
| Performance | 12 | Lighthouse mobile and field/CrUX evidence show Core Web Vitals at the 75th percentile: LCP <= 2.5s, INP <= 200ms, CLS <= 0.1. If field data is unavailable, mark CrUX/RUM as `UNVERIFIED` and use lab data only for partial credit. |
| Deployment readiness | 12 | Reproducible build; pinned runtime and lockfile; immutable releases; strict build/release/run separation; preview environments per PR; documented rollback to previous frontend artifact plus forward-only DB undo migration. |
| Database safety | 12 | RLS coverage is 100%; RLS-referenced columns are indexed; migrations are in git and applied by CI; backups are restore-tested; destructive migrations have a tested forward-only rollback or are blocked. |
| Reliability and observability | 12 | Async routes have error boundaries; transient calls use retry/backoff; payment flows use idempotency keys; risky launches use feature flags; Sentry/PostHog Errors or equivalent is wired; logs go to stdout; synthetic uptime check and alert destination exist. |
| Docs, accessibility, mobile, and cost | 10 | README, AGENTS.md/CLAUDE.md, env setup, and architecture diagram/text exist; WCAG 2.2 AA critical-flow checks pass; privacy policy/terms/cookie consent/account deletion exist where required; Ionic builds satisfy App Store/Play preflight; budget forecast and caps cover LLM calls, Supabase compute, and image transformations. |

Hard blockers override the numeric score and force `NOT_READY`:

- Production build, typecheck, scanner, or tests fail.
- A browser/mobile bundle exposes `service_role`, JWT secret, admin DB credentials, Stripe/OpenAI secrets, or committed `.env` values.
- Any public Supabase table lacks RLS, or write policies omit `WITH CHECK`.
- Production DB migration is destructive without a tested forward-only undo migration.
- Payment mutations lack server-side idempotency keys.
- App Store / Play Store submission lacks in-app account deletion, required privacy manifest/data safety declarations, or required review metadata.

Verdict thresholds:

- `90-100`: `READY` for production, assuming no hard blockers.
- `80-89`: `READY_WITH_RISKS`; ship only with the listed mitigations accepted.
- `70-79`: `STAGING_ONLY`; do not promote to production yet.
- `<70`: `NOT_READY`.

Map findings to recognized frameworks in the report:

- 12-factor: config, dependencies, build/release/run, dev/prod parity, logs.
- AWS Well-Architected: operational excellence, security, reliability,
  performance efficiency, cost optimization, sustainability.
- OWASP ASVS / OWASP Top 10:2025: access control, security misconfiguration,
  supply chain, cryptography, injection, insecure design, authentication,
  integrity, logging/alerting, and exceptional-condition handling.

Surface concrete AI-fix examples where possible:

```sql
-- RLS missing on table X: enable it, then add least-privilege policies.
alter table public.items enable row level security;

create policy "items_select_own"
on public.items
for select
to authenticated
using (user_id = (select auth.uid()));

-- Missing WITH CHECK on writes.
create policy "items_insert_own"
on public.items
for insert
to authenticated
with check (user_id = (select auth.uid()));

-- No index on an RLS/JOIN/WHERE column.
create index concurrently if not exists items_user_id_idx
on public.items (user_id);
```

- `service_role` key in client code -> move the operation to a Supabase Edge Function or server endpoint and expose only the anon key to the browser/mobile app.
- Unbounded `select('*')` -> select named columns and add `.range(start, end)` or cursor pagination.
- Realtime subscription without filters -> add tenant/user filters before subscribing.
- No force-update check in Capacitor -> add a hosted version endpoint and block known-bad native/web bundle versions.

## Output Format

After running all phases, produce a verification report:

```
VERIFICATION REPORT
==================

Build:     [PASS/FAIL]
Types:     [PASS/FAIL] (X errors)
Lint:      [PASS/FAIL] (X warnings)
Tests:     [PASS/FAIL] (X/Y passed, Z% coverage)
Security:  [PASS/FAIL] (X issues)
Diff:      [X files changed]

Overall:   [READY/NOT READY] for PR

Issues to Fix:
1. ...
2. ...
```

For production-readiness requests, append:

```markdown
PRODUCTION-READINESS SCORE
==========================

Score:     <N>/100
Verdict:   READY | READY_WITH_RISKS | STAGING_ONLY | NOT_READY

Dimensions:
| Dimension | Weight | Score | Evidence | Fix |
| --- | ---: | ---: | --- | --- |
| Security and privacy | 18 | ... | ... | ... |
| Code quality | 12 | ... | ... | ... |
| Architecture and config | 12 | ... | ... | ... |
| Performance | 12 | ... | ... | ... |
| Deployment readiness | 12 | ... | ... | ... |
| Database safety | 12 | ... | ... | ... |
| Reliability and observability | 12 | ... | ... | ... |
| Docs, accessibility, mobile, and cost | 10 | ... | ... | ... |

Hard blockers:
1. ...

Framework mapping:
- 12-factor: ...
- AWS Well-Architected: ...
- OWASP ASVS / Top 10:2025: ...

Common AI fixes:
1. <specific issue> -> <specific patch/command/policy>
```

## Continuous Mode

For long sessions, run verification every 15 minutes or after major changes:

```markdown
Set a mental checkpoint:
- After completing each function
- After finishing a component
- Before moving to next task

Run: /verify
```

## Integration with Hooks

This skill complements PostToolUse hooks but provides deeper verification.
Hooks catch issues immediately; this skill provides comprehensive review.
