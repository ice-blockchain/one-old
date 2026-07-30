---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
  - "**/*.spec.tsx"
  - "**/e2e/**"
  - "**/playwright/**"
  - "src/test/**"
  - "apps/**/test/**"
  - "packages/**/test/**"
---

# Frontend Testing — framework-agnostic

Three test layers, each with a distinct job. Framework-specific testing helpers
(React Testing Library, `renderHook`, jest config) live in `frontend/react/testing.md`.

## Layers

| Layer | Tool | Scope |
|-------|------|-------|
| Unit | stack-native test runner | pure functions, reducers, selectors, codecs |
| Integration | stack-native UI test tooling | components rendered with real app state + mocked network |
| E2E | @playwright/test | full app in a real browser, real navigations, mocked back-end at the network edge |

Preserve the project's runner: Vitest/Jest for JavaScript frameworks, PHPUnit
for Laravel, and the native platform runner for native UI. The Jest specifics
in `frontend/react/testing.md` apply only to Jest-based projects.

## What to test

- Every component handling user interaction → integration test.
- Every reducer / selector / pure utility → unit test.
- Every domain-mapping or service helper → unit test, no network.
- Every changed `behavioral` or `visual` user journey → at least one Playwright
  path unless the runtime selects a native simulator/emulator adapter.

## What NOT to test

- Implementation details — assert on observable behaviour.
- Library internals (don't test that `axios` parses JSON).
- Trivial getters/setters or one-line passthroughs.

## Structure & co-location

- Unit + integration tests sit beside the file they test: `Foo.tsx` + `Foo.test.tsx`.
- Playwright specs live in `apps/<name>/e2e/` (or top-level `e2e/`).
- One `describe` per unit; one `it` per distinct behaviour. Arrange–Act–Assert.

## MSW (HTTP mocking)

- HTTP handlers in `src/test/handlers.ts` (or `packages/test-utils/handlers.ts`).
- `server.resetHandlers()` in `afterEach`. Per-test overrides via `server.use(...)`.
- Default handlers represent the *happy path*; tests opt into failure modes explicitly.

## Real-time tests

- WebSocket fake in `packages/test-utils/ws-fake.ts` — see `frontend/realtime.md` for the contract.
- Drive the WS service with the in-memory fake; assert that the UI re-renders when frames are pushed.
- The frame-by-frame coverage matrix (open, first message, malformed frame,
  disconnect, reconnect-with-replay, buffer overflow) is owned by
  `frontend/realtime.md`.

## Playwright

- One config per app: `playwright.config.ts`.
- Run against a built preview, not the dev server (catches bundler regressions).
- Stub the back-end via `route.fulfill()` for deterministic flows; reserve real back-end for a small smoke suite.
- `trace: "on-first-retry"`. Screenshot on failure.
- `@axe-core/playwright` for a11y assertions on every page-level spec.
- Do not require a browser for `none` or `nonvisual` impact. Use local headless
  Playwright for `behavioral`/`visual`, checking actions, routes, hydration,
  console errors, and network errors. The interactive browser plugin is
  optional diagnosis, never canonical evidence.
- Run Lighthouse only when `VerificationContractV2.performance.required` is
  true or the user explicitly asks for it.
- Produce canonical browser evidence with
  `node ~/.traffic-one/bin/qa-evidence-runner.cjs browser --run-id "$RUN_ID" --build-dir <output-root> --scenario-file ".traffic-one/reports/qa/$RUN_ID/scenario-v1.json"`.
  The scenario must exercise an interactive action. Do not hand-author
  `report-v2.json` booleans.
- The runner takes minutes and prints `qa-evidence:` heartbeats on stderr; run
  it in the foreground with a long timeout and wait for the terminal JSON line.
  Never launch a second instance — the per-run lock exits it with
  `already-running` (code 3); wait for the running instance instead.
- Required Lighthouse runs inside that same command against its runner-owned
  live origin/port. Never reuse a report from another listener or run.
- Report the audited route, build mode, Lighthouse Performance score, LCP, CLS, INP/TBT where available, and the top blocking opportunities.
- If Lighthouse cannot run in the environment, mark page speed unverified and list the likely risks; do not imply the page-speed standard was verified.
- `behavioral` work needs no success screenshots; capture one on failure.
  `visual` work requires screenshots at 390 and 1440 for changed routes, plus
  768 only when the contract detects tablet/breakpoint risk.
- Verify responsive layouts have no horizontal overflow and touch targets still work at mobile widths.
- Cover Chrome, Firefox, and Safari/WebKit for scrolling, motion, and fallback behavior on critical journeys.
- Verify reduced-motion behavior when the UI includes animation.
- Prefer deterministic waits and role/label assertions over timeout-based assertions.

## Coverage

- Aim for ≥ 80% on `apps/*/src/features/` and on every `packages/*` library.
- Coverage is a smoke alarm, not a goal — code can be 100% covered and still wrong.
