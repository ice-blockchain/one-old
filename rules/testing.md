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

# Testing Rules

Three test layers, each with a distinct job:

| Layer | Tool | Scope |
|-------|------|-------|
| Unit | jest | pure functions, reducers, selectors, hooks (`renderHook`) |
| Integration | jest + RTL + msw | components rendered with real Redux store + mocked network |
| E2E | @playwright/test | full app in a real browser, real navigations, mocked back-end at the network edge |

## What to test
- Every component handling user interaction → integration test.
- Every custom hook → unit test via `renderHook`.
- Every reducer / selector / pure utility → unit test.
- Every user-facing journey (login, place bet, view results) → at least one Playwright test.
- Do not test implementation details — assert on observable behaviour.

## Structure & co-location
- Unit + integration tests sit beside the file they test: `Foo.tsx` + `Foo.test.tsx`.
- Playwright specs live in `apps/<name>/e2e/` (or top-level `e2e/`).
- One `describe` per unit; one `it` per distinct behaviour. Arrange–Act–Assert.

## React Testing Library

- Query order: `getByRole` → label → text → placeholder. `getByTestId` is a last resort.
- `userEvent` over `fireEvent`. Always `await` user interactions and `findBy*`.
- Render through a real Redux provider with the slice(s) under test mounted, not a hand-rolled mock store.
- Never assert on Redux state directly — assert on what the user sees.

## MSW

- HTTP handlers in `src/test/handlers.ts` (or `packages/test-utils/handlers.ts`).
- WebSocket fakes in `src/test/ws-fake.ts` — see `rules/realtime.md` for the contract.
- `server.resetHandlers()` in `afterEach`. Per-test overrides via `server.use(...)`.

## Jest config (baseline)

- Preset: `ts-jest` or `@swc/jest` for speed.
- `testEnvironment: "jsdom"`.
- `setupFilesAfterEach`: import `@testing-library/jest-dom`.
- Aim for ≥80% coverage on `apps/*/src/features/` and on every `packages/*` library.

## Playwright

- One config per app: `playwright.config.ts`.
- Run against a built preview, not the dev server (catches bundler regressions).
- Stub the back-end via `route.fulfill()` for deterministic flows; reserve real back-end for a small smoke suite.
- Use `expect(locator).toHaveAccessibleName(...)` and other a11y assertions where it matters.
- Trace + screenshot on failure (`trace: "on-first-retry"`).

## Real-time tests
- Drive the WS service with the in-memory fake; assert that components re-render when frames are pushed.
- Cover: connect → first message, disconnect → UI degraded state, backlog drain after reconnect, malformed frame rejected.
