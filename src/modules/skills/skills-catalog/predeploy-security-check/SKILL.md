---
name: predeploy-security-check
description: >
  Use PROACTIVELY before deploy, ship, release, publish, production promotion,
  app-store submission, Supabase db push, Edge Function deploy, or when the
  user asks to run the Traffic One Security Check / pre-deployment security
  scanner. Runs the hard gate for secrets, Supabase RLS, auth/authz, rate
  limits, uploads, CORS, SQLi/XSS, headers, dependency supply chain, logging,
  crypto, and mobile bundle security.
---

# Pre-Deployment Security Check

The framework-agnostic security checklist (secrets, input validation, parameterized SQL, output escaping, authn/authz, CORS, rate limiting, security headers, dependency audit, error sanitization) and the Traffic One pre-deploy gate are owned by the always-on `rules/common/security.md` — that rule is the source of truth; do not restate or fork it here. Below are only the framework-specific specifics.

## Output

Reports are written under `.traffic-one/reports/security/` as JSON and Markdown. Summarize the report path, high findings, warnings, and whether the stamp was written.
