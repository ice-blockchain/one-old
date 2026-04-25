---
name: stack-setup
description: PROACTIVELY drive the traffic-one onboarding Q&A or update the saved stack config. TRIGGER when the user opens a project and SessionStart injected the "FIRST-RUN ONBOARDING REQUIRED" directive — run the Q&A immediately, writing answers to `.traffic-one.json`. Also TRIGGER when the user says "change stack", "switch stack", "reconfigure", "redo setup", "use a different stack", "I picked wrong earlier". Writes the config file and tells the user to restart for the full rule bundle to load.
---

# traffic-one Stack Setup

Persist the user's rule-stack choice into `.traffic-one.json`. The SessionStart hook reads this to decide which rules to inject.

## Two entry paths

### Path A — First-run onboarding
Triggered right after SessionStart shows `═══ traffic-one — FIRST-RUN ONBOARDING REQUIRED ═══`. The directive itself lists the questions. Run the Q&A, write the file, confirm.

### Path B — Mid-project reconfigure
Triggered when the user asks to change stacks on an existing setup. Read the current `.traffic-one.json`, ask only the fields the user wants to change, keep the rest, bump `confirmedAt`, leave `onboardingComplete: true`.

## Stack ids (only these are valid)

- `react-realtime-monorepo` — Real-time React monorepo: Turborepo + RTK + RTK Query + zustand + vanilla-extract + Jest + Playwright. **Recommended for new projects.**
- `react-frontend-only` — Single React app (no monorepo): Vite + RTK + vanilla-extract.
- `node-backend` — Node + Postgres backend, no frontend.
- `minimal` — clean-code + security + git baseline, language-agnostic.

## Backend values

- `ours` — our managed Postgres / Supabase-compatible fork
- `self-hosted` — user runs their own Postgres
- `managed` — Supabase / Neon / RDS / similar
- `other` — Firebase / DynamoDB / custom (skip Postgres rules)
- `external-api` — frontend-only, consumes an existing API
- `none` — minimal stack, no backend

## Realtime values

- `heavy` — gameplay / live markets / trading; full WebSocket rules + back-pressure
- `light` — mostly REST with occasional live updates; WebSocket rules apply
- `none` — pure REST; skip the WebSocket rule bundle (saves ~1k tokens)

## File shape (write exactly this via the Write tool)

```json
{
  "version": 2,
  "mode": "<existing mode, read from current file if present — never change>",
  "stack": "<chosen id from list above>",
  "backend": "<chosen backend>",
  "realtime": "<heavy|light|none>",
  "confirmed": true,
  "onboardingComplete": true,
  "confirmedAt": "<ISO-8601 UTC timestamp, e.g. 2026-04-25T10:00:00Z>"
}
```

**Path A note:** if the file does not exist yet, `mode` should be the mode from the SessionStart directive header (e.g. `new-project`). If you can't see it, default to `new-project`.

**Path B note:** `mode` MUST be preserved from the current file — never change it during a reconfigure.

## After writing

Reply with ONE short line:
> "Saved — stack set to `<id>` with backend `<backend>` and realtime `<realtime>`. Restart Claude Code so the full rule bundle loads on SessionStart."

Do not try to load the rules yourself or re-run the hook. Only session restart picks up the new bundle.

## Must-not-do

- Do not ask the user to edit the JSON themselves.
- Do not use stack ids that aren't in the list above. If the user describes Vue / Next.js / Svelte, say those aren't supported yet and offer `minimal` as a safe default.
- Do not change the `mode` field during a reconfigure.
- Do not proceed with any other skill (`create-component`, etc.) while onboarding is incomplete — the SessionStart directive instructs you to hold.
