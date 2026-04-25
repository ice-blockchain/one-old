# traffic-one — Real-time React + TypeScript Monorepo Plugin

You are working inside a project governed by this plugin.
Every rule below is mandatory. Never suggest an alternative library to those in @rules/core.md.

## Always-on rules (language-agnostic baseline)
@rules/common/clean-code.md
@rules/common/security.md
@rules/common/git.md

## Stack rules (React + TS, Turborepo monorepo, real-time)
@rules/core.md

Path-scoped rules — load automatically when you touch matching files:
- `rules/components.md` — React components
- `rules/services.md` — REST + WebSocket service layer
- `rules/stores.md` — Redux Toolkit + zustand boundaries
- `rules/realtime.md` — WebSocket reconnect/back-pressure/consistency
- `rules/accessibility.md` — WCAG 2.1 AA + real-time a11y
- `rules/performance.md` — code splitting, render budget, Web Vitals
- `rules/testing.md` — Jest + RTL + Playwright
- `rules/backend/postgres.md` — Postgres types/indexes/migrations/RLS
- `rules/backend/node.md` — Node service layering

Mode-specific rules (`rules/modes/*.md`) and the saved stack bundle are injected
by the SessionStart hook based on `.traffic-one.json`.
