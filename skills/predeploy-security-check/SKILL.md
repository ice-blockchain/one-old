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

Run the Traffic One hard security gate before production release work.

## Command

From the project root:

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/scripts/security-check-runner.cjs" --strict --stamp
```

Use `--no-stamp` in CI or read-only verification:

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/scripts/security-check-runner.cjs" --strict --no-stamp
```

## Required Tools

Local runs require installed binaries:

- `gitleaks`
- `trufflehog`

CI pins these versions:

- `gitleaks@v8.30.1`
- `trufflehog@v3.94.3`

If either tool is missing locally, report the failure and do not deploy.

## Missing Tool Prompt

When a local run is requested and `gitleaks` or `trufflehog` is missing, do not
silently fall back to weaker checks. Prompt the user for permission to install
the missing tools before continuing.

Use this wording:

> Traffic One needs `gitleaks` and `trufflehog` to run the local pre-deployment security gate. They scan the working tree and full git history for leaked API keys, Supabase service-role keys, tokens, committed `.env` files, and verified or unknown secrets before anything reaches production. Installing them makes local deploy checks match CI and catches credential leaks earlier. Do you want me to install the missing scanner tools?

If Homebrew is available on macOS, request approval for:

```bash
brew install gitleaks trufflehog
```

If Homebrew is not available on macOS, ask the user to install Homebrew first,
then install the scanners:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install gitleaks trufflehog
```

For the skill validator only, if `quick_validate.py` fails with
`No module named 'yaml'`, ask before creating a tool venv and installing
`PyYAML`. Benefit: it validates skill frontmatter and prevents malformed skill
metadata from shipping.

## What Blocks Deployment

- Gitleaks or TruffleHog findings in git history, working tree, or verified/unknown secret scans.
- Tracked `.env*` files other than examples/templates.
- Supabase service-role, JWT secret, admin DB credentials, OpenAI/Stripe secrets, or hardcoded secret fallbacks in browser/mobile-reachable code.
- Supabase public tables without RLS; policies missing explicit `to authenticated`; unwrapped `auth.uid()`; `user_metadata` used for authorization; unsafe views/functions/RPC; insecure Storage buckets or object policies.
- State-changing endpoints without server-side auth/ownership checks, missing rate limits on auth/OTP/signup/reset/AI/expensive endpoints, user-controlled server fetch URLs, unsafe uploads, wildcard credentialed CORS, SQL interpolation, unsanitized HTML/Markdown, missing production security headers, weak password hashing, or absent security logging on sensitive paths.
- Missing lockfile, high/critical production dependency audit findings, suspicious lifecycle scripts, Shai-Hulud indicators, or CDN scripts without SRI.
- Ionic/Capacitor or Expo/RN secrets in the bundle, insecure token storage, or Supabase mobile auth without PKCE evidence.

## Stamp Contract

A passing `--stamp` run writes these fields to `.traffic-one.json`:

- `lastSecurityCheckAt`
- `lastSecurityCheckStatus`
- `lastSecurityCheckFingerprint`
- `lastSecurityCheckReport`

The deploy gate compares the stamp fingerprint with the current worktree. Any code/config change after the scan requires rerunning the scanner.

## Output

Reports are written under `.traffic-one/reports/security/` as JSON and Markdown. Summarize the report path, high findings, warnings, and whether the stamp was written.
