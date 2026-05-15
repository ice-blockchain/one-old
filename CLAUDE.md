# traffic-one — React + Ionic/Capacitor + TypeScript Plugin

You are working inside a project governed by this plugin.
Every rule below is mandatory. Never suggest an alternative library to those in
`rules/core.md` and the active stack core (e.g. `rules/frontend/react/core.md`).
`.traffic-one.json` uses stack ids `minimal`, `default`, `custom-frontend`,
`custom-backend`, and `custom-stack`; concrete `frontend`, `backend`, and
`mobile.framework` fields decide which local `.traffic-one/` rules and skills
are active.

When `mode === "new-project"`, Claude Code and Codex must switch to Plan mode
before onboarding questions, `.traffic-one.json`, `.traffic-one/plan.md`,
subagent prompts, file writes, installs, or scaffolding. If the host cannot
switch automatically, stay plan-only, ask the fallback chat questions, and stop.
In Codex Default mode, the fallback must be the next visible assistant response
before any tool use: say Plan mode is required and not active, ask `Do you want
a mobile app too?` with `1. Web only (Recommended)`, `2. Ionic + Capacitor`,
and `3. React Native / Expo`, tell the user to reply with the option number or
label, and stop.
Before onboarding is resolved, mention only project-detection/onboarding. Do
not say `create-feature`, `frontend-design`, `tdd-workflow`, or other
implementation skills are active yet.

## Always-on rules (language-agnostic baseline)
@rules/common/clean-code.md
@rules/common/execution-discipline.md
@rules/common/security.md
@rules/common/stack-recommendations.md
@rules/common/library-catalog.md
@rules/common/project-memory.md
@rules/common/documentation.md
@rules/common/seo.md
@rules/common/senior-engineer-team.md
@rules/common/quality-tooling.md
@rules/common/git.md

## Framework-agnostic project rules (TypeScript, monorepo, Gitflow)
@rules/core.md

## Stack-specific core (React web — replace this import for other flavours)
@rules/frontend/react/core.md

Generic mobile variants of React web products stay on the React stack and use
Ionic Framework with Capacitor packaging. React Native Expo stacks use
`@rules/frontend/react-native/core.md` only when the client explicitly asks for
React Native, Expo, RN, or a fully React Native implementation, selected by
`.traffic-one.json` through the SessionStart hook.

Path-scoped rules — load automatically when you touch matching files:

**Framework-agnostic frontend** (`rules/frontend/`):
- `i18n.md` — automatic i18n detection/integration, catalog entries, `<Trans>` for rich copy
- `accessibility.md` — WCAG 2.2 AA + real-time a11y
- `ui-quality.md` — mandatory frontend-stack design brief, modern clean UI gate, state coverage, visual QA
- `typography.md` — mandatory frontend-stack readable type, character-level copy polish, line length rules
- `performance.md` — Web Vitals, bundle budgets, code splitting, defensive UI
- `realtime.md` — WebSocket transport / protocol / bridge architecture
- `services.md` — REST + WS service split, AppError contract, zod validation
- `testing.md` — three-layer model, MSW, Playwright, real-time fakes

**React-specific** (`rules/frontend/react/`):
- `components.md` — component structure, props, Tailwind/shadcn composition, Storybook
- `design-quality.md` — mandatory React-stack product-specific UI quality, usable first screen, responsive visual QA
- `vite.md` — Vite config, env safety, dev proxy, typecheck/build split, chunking
- `stores.md` — Redux Toolkit + RTK Query + zustand boundaries
- `services.md` — RTK Query slice patterns, generated hooks, tag invalidation
- `supabase-client.md` — lazy Supabase client, EnvBanner/ConfigurePromptCard, Traffic setup CTA to `https://traffic.io/`
- `realtime.md` — subscription hooks, Redux bridge middleware
- `performance.md` — React.lazy, memo/useCallback, useSyncExternalStore
- `testing.md` — React Testing Library, renderHook, jest config
- `security.md` — JWT in cookies, DOMPurify, VITE_ env vars, CSP
- `predeploy-security-check` skill — hard pre-deployment scanner and stamp for deploy gate
  Ask to install `gitleaks` and `trufflehog` when missing; if Homebrew is missing on macOS, ask the user to install Homebrew first.

**Ionic/Capacitor hybrid mobile** (`rules/frontend/ionic/`):
- `core.md` — Ionic + Capacitor stack defaults and decision rules
- `capacitor.md` — Capacitor config, native platform folders, plugins, release checks
- `components.md` — Ionic-aware React components, overlays, mobile states
- `navigation.md` — React Router wrapper defaults, deep links, Android back behavior
- `styles.md` — Tailwind/shadcn with Ionic CSS variable bridge
- `services.md` — API and Capacitor plugin service boundaries
- `stores.md` — mobile shell state, native capability state, persistence rules
- `realtime.md` — WebSocket lifecycle across background/resume and mobile networks
- `performance.md` — WebView startup/runtime budgets and mobile assets
- `testing.md` — Capacitor plugin mocks, native smoke checks, mobile visual QA
- `security.md` — native boundary, secrets, permissions, deep-link input
- `accessibility.md` — touch targets, overlays, focus, screen readers

**React Native-specific, explicit React Native / Expo only** (`rules/frontend/react-native/`):
- `core.md` — Expo-first stack core, forced libraries, folder structure
- `components.md` — native primitives, explicit props, list rendering
- `styles.md` — NativeWind/RNR design tokens, dynamic styles only through native style APIs
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
