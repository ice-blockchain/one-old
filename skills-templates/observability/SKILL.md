---
name: observability
description: >
  Use PROACTIVELY when the user asks for logs, monitoring, Sentry, PostHog,
  LogRocket, uptime, SLOs, error budgets, slow queries, failed deployment
  analysis, post-deploy observability, AI fix suggestions, or automated error
  fixing. Guides plugin-side implementation and verification for generated
  projects without creating provider dashboards inside the plugin.
---

# Observability

Use this skill to add or verify post-deploy observability that a non-technical
founder can act on. Traffic One provides rules, scaffolding, CI checks,
runbooks, and verification prompts; it does not run a custom observability
backend inside the plugin.

## Scope split

- **Plugin-side work:** update project rules/docs, add env names, CI/build
  steps, release tags, source-map upload commands, runbook sections, verification
  checks, alert-routing guidance, and AI fix suggestion prompts.
- **Frontend/mobile app work:** wire Sentry React/Ionic/Capacitor/Expo clients,
  PostHog or explicit LogRocket replay/analytics, release SHA tagging, replay
  privacy masking, and mobile crash symbol uploads.
- **Supabase/backend work:** guide Supabase Logs usage, Edge Function Sentry
  Deno `withScope`, API non-2xx metrics, `/health`, `pg_stat_statements`, and
  SLO/burn-rate alerting. Implement only when touching the actual app/backend,
  never as plugin runtime code.
- **Side-effect boundary:** opening PRs, pushing branches, changing provider
  settings, running migrations, deploying, sending alerts, or posting to Slack
  requires explicit current-turn user approval.

## Default stack

1. **Central logs:** Supabase Dashboard Logs Explorer for PostgREST/API, Auth,
   Edge Functions, Postgres, Storage, and Realtime. App runtime logs go to
   stdout/stderr for the host to collect; never write app-managed log files.
2. **Client errors:** Sentry React/Ionic with `release` set to the deployed git
   SHA. Upload source maps on every production build and remove/block public
   `.map` files after upload.
3. **Edge Function errors:** Sentry Deno SDK inside Supabase Edge Functions.
   Use `withScope` per request or pass capture context directly because reused
   runtimes make global scope-sharing unsafe.
4. **Replay and analytics:** PostHog by default for session replay, funnels,
   product analytics, and feature flags. LogRocket only when existing/explicit.
   Replay is blocked until masking and consent/legal basis are documented.
5. **Uptime:** synthetic checks on `/` and `/health` every 1-5 minutes with
   email plus one chat route.
6. **SLOs:** start with simple founder-readable SLOs such as "99% of auth
   requests succeed over 7 days" and alert on multi-window burn rate.
7. **Slow queries:** enable `pg_stat_statements`; surface normalized query,
   p95/mean execution time, calls, rows read when available, and one suggested
   index or an `EXPLAIN ANALYZE` follow-up.
8. **Failed deploys:** fetch build logs, isolate the failing step, and map
   common causes to canned fixes: lockfile drift, missing env var, Sentry
   source-map auth/upload failure, migration conflict, missing Supabase link,
   quota, or failing test/typecheck/build.

## Privacy gate

Before enabling replay or broad analytics:

- Mask all inputs by default.
- Redact emails, tokens, payment fields, precise location, contact data, query
  strings, request bodies, response bodies, and sensitive DOM/native views.
- Mark auth, payment, account, health, admin, and customer-data regions as
  no-capture unless a documented product/legal decision says otherwise.
- Keep Sentry `sendDefaultPii` off unless there is a documented reason and
  scrubbing is configured.
- Store provider DSNs/tokens in the correct place: public DSNs may be app env,
  build/upload tokens and provider admin keys must be CI/host secrets only.

## AI fix suggestion format

For each error class, output:

1. `Impact`: founder-readable symptom and affected users/routes.
2. `Likely cause`: one sentence tied to evidence.
3. `Suggested patch`: smallest diff or file-level change.
4. `Why this works`: one paragraph.
5. `Approval needed`: explicit action that needs user approval, such as opening
   a PR, pushing a branch, rerunning deploy, changing provider settings, or
   applying a migration.

Never auto-open a PR or execute a fix tool because an alert fired.

## Verification

- Sentry test error resolves to original source in the release tied to the git
  SHA.
- Source-map files are not publicly retrievable after upload.
- Supabase Logs show recent API/Auth/Edge/Postgres entries without PII.
- Replay masking is tested on auth/payment/account/admin surfaces.
- `/` and `/health` synthetic checks have passing history and alert contacts.
- SLO alerts use burn-rate windows, not raw error count alone.
- `pg_stat_statements` query or dashboard evidence exists for slow queries.
- Failed-deploy runbook includes log retrieval and canned fix mapping.
