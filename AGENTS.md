# traffic-one — Codex CLI
<!-- SOURCE OF TRUTH for rules content: rules/*.md — update there first, then mirror here -->

You are working in a React / React Native + TypeScript monorepo. Every rule below is mandatory.
Never suggest an alternative library to those listed here.

The rules are layered:
1. **Common baseline** (clean-code, security, git) — applies to any TypeScript project.
2. **Project core** (TypeScript strict, Turborepo, Gitflow) — `rules/core.md`, framework-agnostic.
3. **Stack core** — React web uses `rules/frontend/react/core.md`; Expo React Native uses `rules/frontend/react-native/core.md`.
   Replace this layer per frontend flavour — never mix stack-specific rules into the framework-agnostic core.
4. **Path-scoped rules** (components, design quality, services, stores, real-time, perf, a11y, testing) — load when matching files are touched.

---

## Clean-code baseline (always)
- KISS, DRY (only after 2–3 real repetitions), YAGNI.
- Immutability: return new objects/arrays, never mutate inputs. `const` by default.
- Names describe intent; booleans start with `is`/`has`/`should`/`can`; no `any`.
- Files 200–400 lines; functions do one thing (~50 lines max); early returns over nesting.
- Handle every error explicitly; validate all input at boundaries with a schema.

## Execution discipline (always)
- State important assumptions before changing code; verify behavior/security/data-shape choices instead of guessing.
- If a request has multiple plausible meanings, name the interpretations and ask or choose the smallest reversible step.
- Implement the smallest code that satisfies the current requirement; no speculative abstractions or future-proofing.
- Every changed line must trace to the user's request or to keeping verification healthy.
- Do not reformat, rename, move, or improve adjacent code as a drive-by change.
- Convert non-trivial work into concrete success criteria; reproduce bugs first when practical.

## Security baseline (always)
- No hardcoded secrets. All secrets via env vars, presence checked at startup.
- Parameterized SQL only. Validate every request body/query/params with Zod.
- Auth AND authorization checks on every protected endpoint — UI gating is not enough.
- No stack traces in production responses. `.env*` gitignored.

## Dependencies (always — applies to any new install)
- **Library-first**: when a need isn't covered by the active stack core, search 2–3 candidates and apply the quality gate.
- Quality gate (lib MUST pass all): maintained (commit ≤ 6 mo) · adopted (≥ 1k stars OR ≥ 100k weekly downloads) · permissive license (MIT/Apache/BSD/ISC) · ships types · no high+ `npm audit`. Frontend extras: ≤ 30 KB gz feature / 100 KB heavy, ESM treeshakeable.
- If nothing passes → build under `packages/<name>` and write `architecture.md` **before** code. CI fails packages missing `architecture.md`.
- Note the decision (chosen + rejected with reasons) in the commit body.
- Trigger `library-pick` skill when in doubt.

## Git baseline (Gitflow)
- Branches: `main` (production), `develop` (integration), `feature/*`, `release/*`, `hotfix/*`.
- Conventional commits: `<type>(scope): <imperative>` — subject ≤72 chars, ticket id in scope where applicable.
- PR title ≤70 chars; body = *why* bullets + test-plan checklist + a11y check + Storybook link.
- Analyze full `git diff <base>...HEAD` when writing PR descriptions.
- Never force-push `main`/`develop`. Never `--no-verify`.

---

## Project core (framework-agnostic — `rules/core.md`)

- **TypeScript ^5** strict (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- Public TypeScript APIs have explicit parameter and return types; obvious locals may be inferred.
- Use `interface` for extensible object shapes/public DTOs; use `type` for unions/intersections/tuples/mapped types.
- Prefer string literal unions over `enum` unless protocol or generated-code interop requires an enum.
- Treat caught errors and external data as `unknown` until narrowed.
- Infer schema-backed types with `z.infer<typeof Schema>`; do not duplicate types beside Zod schemas.
- **Monorepo:** Turborepo with pnpm workspaces (npm/yarn fallback).
- Shared code in `packages/*`; cross-package imports use workspace package names.
- Validate every external input with a typed schema; map errors to a typed `AppError`.
- Husky + lint-staged + commitlint; lockfile committed; `pnpm audit` in CI.

## React (web) stack core (`rules/frontend/react/core.md`)

### Forced library stack — no exceptions

### Build
- **Per-app bundler**: Vite for libraries and standalone apps

### Runtime
- **UI:** react ^18 (.tsx/.ts only)
- **Routing:** react-router-dom v6
- **Global state:** Redux Toolkit (slices + RTK Query for server state)
- **Lightweight UI state:** zustand (only ephemeral, non-server, non-shared-business)
- **Real-time:** native WebSocket or socket.io-client, wrapped in a service singleton
- **HTTP:** axios (in service functions) or RTK Query — never axios in a component
- **Forms:** react-hook-form + zod + @hookform/resolvers
- **i18n:** i18next + react-i18next; shared typed resources default to `packages/i18n`
- **Animations:** framer-motion (declarative); CSS for micro; lottie-react / @react-three/fiber as needed

### Styling
- **vanilla-extract** — `.css.ts` files generate static CSS at build time
- **Design tokens** in a shared `packages/design-tokens` (themeContract + createTheme)
- **No** tailwindcss, styled-components, @emotion, CSS modules, inline `style={{}}`

### Testing
- **Unit + integration:** jest + @testing-library/react + @testing-library/user-event
- **E2E:** @playwright/test
- **Mocks:** msw for HTTP, in-memory WS fake for real-time
- **Component dev:** Storybook (@storybook/react-vite)

## Absolute rules
- Function components only. No class components.
- Named exports only. No `export default` for components.
- No `any` — use `unknown` and narrow.
- No inline `style={{}}` — vanilla-extract `.css.ts` only.
- No Tailwind utility classes — define styles in `.css.ts`.
- Props always have an explicit `ComponentNameProps` interface.
- All API calls go through `services/` or RTK Query slices — never axios in components.
- User-facing text, placeholders, labels, loading/error/empty copy, alt text, and ARIA labels come from translation keys.
- Server state lives in RTK Query (or Redux) — never duplicated in zustand or component state.
- WebSocket connections owned by a service singleton; components subscribe via hooks. Never `new WebSocket()` in a component.
- Cross-package imports use workspace package names (`@app/ui`, `@app/utils`) — never deep relative paths.
- New apps use `packages/i18n` for locale config, typed resources, and feature-based namespaces.
- Existing apps with a mature i18n package may keep it, but new UI copy still uses i18next/react-i18next.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.

## React Native (Expo) stack core (`rules/frontend/react-native/core.md`)

### Forced library stack — no exceptions

### Runtime
- **App runtime:** Expo SDK + React Native + TypeScript (`.tsx/.ts` only)
- **Architecture:** Hermes and React Native New Architecture for new apps
- **Routing:** Expo Router with typed routes enabled
- **Global state:** Redux Toolkit (slices + RTK Query for server state)
- **Lightweight UI state:** zustand (only ephemeral, non-server, non-shared-business)
- **Real-time:** native WebSocket or socket.io-client, wrapped in a service singleton
- **HTTP:** axios (in service functions) or RTK Query — never axios in a component
- **Forms:** react-hook-form + zod + @hookform/resolvers
- **Storage:** expo-secure-store for secrets; AsyncStorage only for non-sensitive preferences
- **i18n:** i18next + react-i18next; expo-localization for device locale detection; shared typed resources default to `packages/i18n`
- **Animations:** react-native-reanimated + react-native-gesture-handler; lottie-react-native as needed

### Build
- **Native builds:** Expo CLI locally and EAS Build/Submit for release artifacts
- **Bundler:** Metro; Turborepo orchestrates the workspace

### Styling
- **React Native StyleSheet** — sibling `*.styles.ts` files with `StyleSheet.create`
- **Design tokens** in shared `packages/design-tokens` as platform-neutral TS values
- **No** NativeWind, tailwindcss, styled-components, @emotion, CSS modules, DOM tags, inline object styles

### Testing
- **Unit + integration:** jest + jest-expo + @testing-library/react-native
- **E2E:** Maestro flows in `.maestro/*.yml`
- **Mocks:** msw for HTTP, in-memory WS fake for real-time

## React Native absolute rules
- Function components only. Named exports for reusable components.
- Expo Router route files may use `export default`; route files stay thin and compose named feature components.
- Props always have an explicit `ComponentNameProps` interface.
- Use React Native primitives (`View`, `Text`, `Pressable`, `TextInput`, `Image`) or approved shared primitives.
- No DOM tags, NativeWind/Tailwind classes, or inline object styles.
- All API calls go through `services/` or RTK Query slices — never axios in components.
- User-facing text, placeholders, labels, loading/error/empty copy, image accessibility copy, and accessibility labels come from translation keys.
- Server state lives in RTK Query or Redux — never duplicated in zustand or component state.
- WebSocket connections owned by a service singleton; components subscribe via hooks. Never `new WebSocket()` in a component.
- Route params contain ids/filters only; validate params and deep links with Zod before use.
- Cross-package imports use workspace package names (`@app/ui-native`, `@app/utils`) — never deep relative paths.
- React Native apps read the device locale through `expo-localization` and feed it into i18next.
- New apps use `packages/i18n` for locale config, typed resources, and feature-based namespaces.
- Existing apps with a mature i18n package may keep it, but new UI copy still uses i18next/react-i18next.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.

## Folder structure (Turborepo monorepo)
```
<repo>/
├── apps/
│   └── web/
│       ├── src/
│       │   ├── store/             redux store + middleware
│       │   ├── features/<name>/   components/ hooks/ slice.ts api.ts index.ts
│       │   ├── pages/             thin route wrappers, no business logic
│       │   ├── services/ws/       app-specific WS bridges (if not shared)
│       │   ├── components/        app-only components
│       │   └── styles/            theme.css.ts, global.css.ts
│       └── e2e/                   Playwright specs
└── packages/
    ├── ui/                        shared component library + Storybook
    ├── design-tokens/             vanilla-extract themes & tokens
    ├── i18n/                      shared typed i18next resources & locale config
    ├── api-client/                axios + RTK Query baseQuery + AppError
    ├── ws-client/                 WebSocket transport + protocol + hooks
    ├── utils/                     pure utilities (no React imports)
    ├── tsconfig/                  shared TS configs
    └── eslint-config/             shared ESLint config
```

## React Native folder structure (Expo monorepo)
```
<repo>/
├── apps/
│   └── mobile/
│       ├── app/                 Expo Router routes and layouts only
│       ├── src/
│       │   ├── store/           redux store + middleware
│       │   ├── features/<name>/ components/ hooks/ slice.ts api.ts index.ts
│       │   ├── services/ws/     app-specific WS bridges
│       │   ├── components/      app-only native components
│       │   └── styles/          theme.ts, token adapters
│       └── .maestro/            device E2E flows
└── packages/
    ├── ui-native/               shared React Native primitives
    ├── design-tokens/           platform-neutral design tokens
    ├── i18n/                    shared typed i18next resources & locale config
    ├── api-client/              axios + RTK Query baseQuery + AppError
    ├── ws-client/               WebSocket transport + protocol + hooks
    ├── utils/                   pure utilities
    ├── tsconfig/
    └── eslint-config/
```

## Component rules (apps/**/src/components/**, packages/ui/**)
- ≤150 lines, one per file. Co-locate `*.css.ts` and `*.stories.tsx`.
- Named export. Explicit `ComponentNameProps` interface.
- Discriminated unions over flag+optional combos for state shapes.
- Always handle isLoading / isError / empty states explicitly.
- Lazy-load page-level components: `React.lazy` + `Suspense` with skeleton fallback.
- `React.memo` / `useCallback` / `useMemo` only after profiling — measure, don't guess.
- All design values from `@app/design-tokens` — never hardcode colours/spacing.
- All visible copy, placeholders, alt text, ARIA/accessibility labels, and loading/error/empty states use translation keys.

## React web design quality (apps/web/src/**, packages/ui/**)
- Build the actual usable app/tool/game experience as the first screen; do not default to a marketing page.
- UI must feel specific to the product, workflow, and audience — no generic template-looking surfaces.
- Choose a concrete visual direction, then express it with design tokens, layout, typography, states, and motion.
- Finish hover/focus/active/loading/empty/error states intentionally; verify mobile/desktop overflow, clipping, and overlap.
- Use vanilla-extract `.css.ts` and `@app/design-tokens`; never hardcode visual values.

## Real-time rules (services/ws/**, packages/ws-client/**)
- Singleton connection per endpoint. Components subscribe via hooks.
- Reconnect with exponential backoff + jitter; heartbeat ping every 15–30 s.
- Validate every inbound frame with zod; drop malformed, never crash the connection.
- High-rate streams: aggregate frames and flush via `requestAnimationFrame`. Cap render rate at 30 fps for non-game UIs.
- States components must render: `idle`, `connecting`, `live`, `reconnecting`, `offline`, `degraded`.
- Always `wss://` in production. Strip PII from client-side frame logs.

## State rules
- Server data → RTK Query (or a Redux slice fed by a WS service). Never copy into zustand/state.
- Cross-feature business state → Redux Toolkit slice (auth, session, game phase).
- Ephemeral UI state → zustand (one store per concern, never a mega-store).
- Component-local → useState/useReducer. Form state → react-hook-form.
- Selectors: `createSelector` for non-trivial derivations. Type with `useAppSelector`/`useAppDispatch`.

## Service rules
- Plain async services in `services/<domain>.ts`, RTK Query in feature `api.ts`.
- Shared axios instance in `packages/api-client`. Interceptors map errors to a typed `AppError`.
- Validate every response body with zod at the service boundary.
- One file per domain; explicit return types; no `any`.

## Testing rules (**/*.test.*, **/*.spec.*, **/e2e/**)
- Unit: jest for pure functions / reducers / selectors / hooks (`renderHook`).
- Integration: jest + RTL + msw, real Redux provider.
- E2E: Playwright against a built preview, route-mocked back-end.
- Query order: `getByRole` → label → text → placeholder. `getByTestId` last resort.
- ≥80% coverage on `apps/*/src/features/` and every `packages/*` library.
- Real-time tests: drive in-memory WS fake; cover connect/first/disconnect/reconnect/malformed/buffer-overflow.
- Visual-heavy frontend work: Playwright screenshots at key breakpoints, no horizontal overflow, reduced-motion verification, and Chrome/Firefox/Safari coverage for critical paths.

## Performance rules
- Lazy-load every page; preload on hover/focus.
- Bundle budget: critical path ≤180 KB gz, per-route chunk ≤80 KB gz.
- Web Vitals targets: LCP ≤2.5 s, FCP ≤1.5 s, INP ≤200 ms, TBT ≤200 ms, CLS ≤0.1.
- Tree-shake: named imports only (`import { x } from "lodash-es"`).
- Hero media may use eager/high-priority loading only for the primary asset; lazy-load below-the-fold media.
- Third-party scripts load async/defer and only where needed; use `will-change` narrowly and remove it after animation.
- Real-time render budget: ≤30 fps for non-game UIs; batch via `requestAnimationFrame`.
- Defensive UI under degraded network: show "reconnecting" banner, mark stale data, queue or fail optimistic actions.

## React web security additions
- Never store JWT access tokens in `localStorage`; use `httpOnly` cookies or in-memory state.
- Validate user-supplied data with Zod before sending it to the API; no frontend secrets in `VITE_` vars.
- CSP uses concrete production origins and per-request nonces for required inline scripts; no `unsafe-inline` scripts.
- Use SRI for CDN scripts, self-host critical assets when practical, and send HSTS/nosniff/frame/referrer/permissions headers.
- State-changing forms require CSRF protection, server validation, rate limiting, and lightweight anti-abuse controls.

## Accessibility rules
- Semantic HTML first. `<button>` for actions, `<a>` for navigation, `<dialog>` for modals.
- Every interactive element keyboard-reachable; visible focus styles.
- Modals trap focus, restore on close. Skip-link at top of layout.
- Forms: `<label htmlFor>`; errors via `aria-describedby` + `role="alert"`.
- Visible labels, helper text, errors, image `alt`, ARIA labels, and live-region copy come from translation keys.
- Live regions: `aria-live="polite"` for non-urgent (score updates), `"assertive"` only for critical.
- Respect `prefers-reduced-motion`. Avoid flashes ≥3 Hz.
- Run `@axe-core/playwright` on every E2E spec.

## React Native accessibility additions
- Support VoiceOver and TalkBack on critical journeys.
- Interactive controls expose role, label, and state when needed.
- Minimum touch target is 44x44 points; use `hitSlop` for compact controls.
- Respect dynamic type and reduced motion. Never use colour alone for state.
- Visible copy, placeholders, accessibility labels/hints, validation errors, and state copy come from translation keys.
- Maestro/RNTL tests should prefer stable accessibility labels for critical controls.

## Backend rules (when editing SQL, migrations, server/, api/)
- Postgres types: `timestamptz`, `numeric` (money), `text` (not `varchar(n)`), `jsonb`.
- Indexes: every hot-path WHERE/JOIN/ORDER BY column; composite indexes equality-first.
- RLS enabled on every user-data table; default-deny policies; tested with anon + authed roles.
- Migrations: non-null on big tables = nullable → backfill → NOT NULL. Drops two-phase.
- API layering: route → controller → service → repository → db. No layer-skipping.
- Public API responses use typed DTO envelopes (`success`, `data`, `error`, optional `meta`); paginated responses include metadata matching the endpoint contract.
- All handler input validated with Zod; return 400 with flattened errors.
- Controllers map service results to typed HTTP DTOs; never expose raw DB rows/ORM entities in API responses.
- Repositories expose small typed contracts; services own business logic, depend on repository interfaces, and never receive HTTP response objects.
- Rate-limit public/auth/search/write endpoints; cookie/session state-changing endpoints require CSRF protection.
- Large reads must be bounded. Avoid N+1 query loops by batching with `IN (...)`, joins, or bulk repository methods.
- API and DB integration tests cover routing/middleware, constraints, auth filters, pagination metadata, and failure paths.
- No `console.log` in production server code; use the project logger and strip secrets/PII.
- Run a focused security review when touching auth/authz, DB queries, filesystem, crypto, external APIs, payments, or user input handling.

## Backend technology rules
- TypeScript/JavaScript backend is covered by `rules/core.md` plus `rules/backend/node.md`.
- C++: modern C++17/20/23, RAII/smart pointers, Rule of Zero/Five, repository interfaces, sanitizers, `clang-tidy`/`cppcheck`, GoogleTest/gMock.
- C#/.NET: nullable reference types, immutable records/DTOs, async repositories with `CancellationToken`, typed options, constructor DI, parameterized ADO.NET/Dapper/EF, xUnit/Testcontainers/WebApplicationFactory.
- Go: `gofmt`/`goimports`, small consumer-owned interfaces, constructor DI, contextual errors, `context.Context` timeouts, `gosec`, table-driven tests with race and coverage.
- Java: records/final fields, repository/service/controller separation, constructor DI, DTO mapping, Bean Validation, parameterized JDBC/JPA, JUnit 5/AssertJ/Mockito/Testcontainers.
- Kotlin/JVM: ktlint/Detekt, `val`/immutable collections, null safety, sealed error models, structured coroutines, repository `suspend`/`Flow` contracts, Ktor/JUnit/Turbine/Testcontainers.
- Perl: `v5.36`, subroutine signatures, Moo DTOs, DBI/DBIx::Class repositories, taint mode for web scripts, three-arg `open`, list-form `system`, DBI placeholders, Test2/prove/Devel::Cover.
- PHP: PSR-12, `strict_types`, typed properties, DTOs/value objects, thin controllers/services, prepared statements, mass-assignment whitelists, `composer audit`, password/session/CSRF safety, PHPUnit/Pest.
- Python: PEP 8 typed signatures, dataclass/Protocol DTO and repository boundaries, context managers, environment secrets, Bandit, parameterized queries, pytest with unit/integration markers.
- Rust: `cargo fmt`/Clippy, ownership-first APIs, `Result` and typed errors, trait repositories, service constructors, newtype IDs, audited dependencies, documented `unsafe`, async/integration tests and `cargo llvm-cov`.

## Available skills (invoke with $skill-name or describe your intent)
- `$stack-setup` — first-run onboarding Q&A or stack reconfigure
- `$create-component` — scaffold a React component (with `.css.ts` + story)
- `$create-feature` — scaffold a full feature slice (Redux + components + api)
- `$create-page` — scaffold a lazy-loaded page + route entry
- `$create-service` — scaffold a service function or RTK Query endpoint
- `$create-native-component` — scaffold a React Native component (with `.styles.ts`)
- `$create-native-screen` — scaffold an Expo Router screen/route
- `$create-native-feature` — scaffold a React Native feature slice
- `$create-native-service` — scaffold a mobile service or RTK Query endpoint
- `$i18n-text` — add, extract, review, or localize user-facing UI copy
- `$security-review` — audit code for security issues
- `$refactor` — clean up and improve existing code
- `$postgres-review` — review SQL, migrations, indexes, RLS
- `$context-budget` — audit token consumption across loaded rules/skills
- `$git-commit` — craft Gitflow-conforming commits and PR descriptions
- `$execution-discipline` — apply Karpathy-style assumptions, simplicity, surgical edits, and verification
