---
# Always loaded
---

# Security Baseline

Pre-commit checklist — applies to every change that touches input, auth, storage, or the network.

- [ ] No hardcoded secrets (API keys, tokens, passwords, connection strings).
- [ ] All secrets from environment variables; presence validated at startup.
- [ ] All user input validated with a schema (zod, pydantic, etc.) at the boundary.
- [ ] SQL uses parameterized queries — never string interpolation.
- [ ] HTML output is escaped / auto-escaped by the framework. No `dangerouslySetInnerHTML` without sanitization.
- [ ] Auth check on every protected endpoint — not just the UI.
- [ ] Authorization check: is THIS user allowed to access THIS resource?
- [ ] Auth uses the stack-native/provider-backed default before custom JWT,
      sessions, password storage, or token parsing.
- [ ] Rate limiting on public endpoints (auth, search, write operations).
- [ ] Error responses do not leak stack traces, internal paths, or DB structure in production.
- [ ] `.env`, `.env.local`, credential files in `.gitignore`.
- [ ] CORS is restrictive — no `*` for credentialed endpoints.

## If a secret leaks
1. Rotate it immediately.
2. Invalidate any derived tokens/sessions.
3. Scrub git history only after rotation (history scrubbing alone does not help — assume the value is compromised).

## Explicit confirmation boundaries

The following actions require explicit confirmation in the current user turn.
Prior discussion or implied intent is not enough:

- Deploying, publishing, releasing, submitting to a store, or pushing to a
  protected/staging/production environment.
- Running migrations, schema changes, destructive scripts, or data backfills
  against any shared or production database.
- Sending email/messages, scheduling calendar events, sharing documents, posting
  social content, or making external API calls with side effects.
- Deleting files, dropping records, removing dependencies, overwriting existing
  code in a way that is not trivially reversible, or scrubbing git history.

Before these actions, list exactly what will be affected and wait for a clear
yes in the current message.

## Dependencies
- Pin exact majors; review transitive updates.
- Run `npm audit` / `pip-audit` / equivalent in CI; fail on high+ severity.

## Logs, replay, and AI fixes

Redaction defaults, session-replay privacy gates (masking, consent/legal basis,
retention), and the AI-remediation approval boundary are owned by the
`observability` skill — read it before wiring logging, analytics, replay, or
auto-fix flows; do not fork that policy here.

## Traffic One pre-deployment security check

Before deploy, release, publish, production promotion, app-store submission,
`supabase db push --linked`, or Edge Function deploy, run:

```bash
node ~/.traffic-one/bin/security-check-runner.cjs --strict --stamp
```

CI uses `--strict --no-stamp` with pinned `gitleaks@v8.30.1` and
`trufflehog@v3.94.3`. Local runs require installed `gitleaks` and
`trufflehog` binaries; missing scanners block deployment.

If local scanners are missing, explicitly ask the user to install them before
continuing. Explain the benefit: `gitleaks` scans the working tree and full git
history for committed API keys, Supabase service-role keys, tokens, and `.env`
secrets; `trufflehog` verifies and flags known/unknown secrets across git
history; together they make the local deploy gate match CI and catch credential
leaks before push/deploy. On macOS with Homebrew, ask approval to run
`brew install gitleaks trufflehog`. If Homebrew is missing, ask the user to
install Homebrew first, then install the scanners. Do not deploy using weaker
fallback checks.

The scanner blocks exposed secrets, Supabase service-role/JWT/admin DB secrets
in browser/mobile code, weak auth/session patterns, broken access control,
missing rate limits on sensitive or expensive endpoints, insecure Supabase RLS
and Storage policies, unsafe views/functions/RPC, unsafe uploads, CORS/security
header misconfiguration (OWASP A02:2025), SQLi/XSS injection (OWASP A05:2025),
admin routes gated only in the UI, hardcoded env fallbacks, high+ production
dependency vulnerabilities, suspicious npm supply-chain indicators, weak
crypto, missing security logging, and Ionic/Capacitor/Expo bundled secrets or
non-PKCE mobile auth.

Passing `--stamp` writes `lastSecurityCheckAt`, `lastSecurityCheckStatus`,
`lastSecurityCheckFingerprint`, `lastSecurityCheckReport`, and
`lastSecurityCheckStrict` to
`.traffic-one/.one.json`. High findings never stamp, even without `--strict`.
The deploy hook denies production commands if the stamp is
missing, stale, failed, not from a `--strict` run, or its fingerprint no longer matches the worktree.
