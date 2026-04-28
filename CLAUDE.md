# traffic-one — Real-time React + TypeScript Monorepo Plugin

You are working inside a project governed by this plugin.
Every rule below is mandatory. Never suggest an alternative library to those in
`rules/core.md` and the active stack core (e.g. `rules/frontend/react/core.md`).

## Always-on rules (language-agnostic baseline)
@rules/common/clean-code.md
@rules/common/execution-discipline.md
@rules/common/security.md
@rules/common/git.md

## Framework-agnostic project rules (TypeScript, monorepo, Gitflow)
@rules/core.md

## Stack-specific core (React web — replace this import for other flavours)
@rules/frontend/react/core.md

React Native Expo stacks use `@rules/frontend/react-native/core.md` instead,
selected by `.traffic-one.json` through the SessionStart hook.

Path-scoped rules — load automatically when you touch matching files:

**Framework-agnostic frontend** (`rules/frontend/`):
- `accessibility.md` — WCAG 2.1 AA + real-time a11y
- `performance.md` — Web Vitals, bundle budgets, code splitting, defensive UI
- `realtime.md` — WebSocket transport / protocol / bridge architecture
- `services.md` — REST + WS service split, AppError contract, zod validation
- `testing.md` — three-layer model, MSW, Playwright, real-time fakes

**React-specific** (`rules/frontend/react/`):
- `components.md` — component structure, props, vanilla-extract, Storybook
- `design-quality.md` — product-specific UI quality, usable first screen, visual QA
- `stores.md` — Redux Toolkit + RTK Query + zustand boundaries
- `services.md` — RTK Query slice patterns, generated hooks, tag invalidation
- `realtime.md` — subscription hooks, Redux bridge middleware
- `performance.md` — React.lazy, memo/useCallback, useSyncExternalStore
- `testing.md` — React Testing Library, renderHook, jest config
- `security.md` — JWT in cookies, DOMPurify, VITE_ env vars, CSP

**React Native-specific** (`rules/frontend/react-native/`):
- `core.md` — Expo-first stack core, forced libraries, folder structure
- `components.md` — native primitives, explicit props, list rendering
- `styles.md` — `StyleSheet.create`, design tokens, no NativeWind/Tailwind
- `stores.md` — Redux Toolkit + RTK Query + zustand mobile boundaries
- `services.md` — RTK Query/axios services, SecureStore, offline concerns
- `realtime.md` — mobile WS lifecycle, foreground/background handling
- `navigation.md` — Expo Router, typed routes, params, deep links
- `performance.md` — Hermes, New Architecture, list/media budgets
- `testing.md` — Jest, RNTL, MSW/fakes, Maestro E2E
- `accessibility.md` — VoiceOver/TalkBack, touch targets, dynamic type
- `security.md` — SecureStore, deep-link validation, native dependency checks

**Backend** (`rules/backend/`):
- `postgres.md` — Postgres types/indexes/migrations/RLS
- `node.md` — Node service layering
- `cpp.md` — C++ service/native backend rules
- `csharp.md` — C#/.NET backend rules
- `golang.md` — Go backend rules
- `java.md` — Java backend rules
- `kotlin.md` — Kotlin/JVM backend rules
- `perl.md` — Perl backend rules
- `php.md` — PHP backend rules
- `python.md` — Python backend rules
- `rust.md` — Rust backend rules

Mode-specific rules (`rules/modes/*.md`) and the saved stack bundle are injected
by the SessionStart hook based on `.traffic-one.json`.
