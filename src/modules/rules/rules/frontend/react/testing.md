---
paths:
  - "**/*.test.tsx"
  - "**/*.spec.tsx"
  - "src/test/**"
  - "apps/**/src/test/**"
---

# React Testing — RTL runner specifics

Framework-agnostic test layering, MSW patterns, Playwright config live in
`frontend/testing.md`. This file covers React Testing Library and the runner
config it needs.

## The runner is Vitest on Vite-based stacks

Runtime compiles `vitest.config.ts` for Vite/React, so Vitest is the runner. The
Jest section below applies only to Expo/React Native, whose runner is jest-expo.

**A component suite needs a DOM.** `environment: 'node'` cannot render, and a
suite that cannot render degrades into asserting on source text — which passes
whenever a string is present and proves nothing about behaviour. Observed 9co: 11
of 16 test files did `readFileSync` + `toContain` on component sources, and the
RLS/idempotency "tests" grepped a `.sql` migration.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: true,
  },
});
```

```ts
// src/test/setup.ts
import '@testing-library/jest-dom/vitest';
```

Dependencies to declare alongside it: `vitest`, `jsdom`,
`@testing-library/react`, `@testing-library/user-event`,
`@testing-library/jest-dom`, `@vitejs/plugin-react`. A config naming a tool the
manifest does not install is not a test setup.

## Never substitute source text for behaviour

- Do not read a production file and assert on its contents as a stand-in for a
  test. That is a grep, and it passes for a file whose whole body is a comment.
- If a runtime is genuinely unavailable (no DOM, no database, no simulator), write
  the test and `it.skip` it with the reason in the title. A skipped test is
  visible in the report; a green grep is indistinguishable from real coverage.
- The same applies to SQL and infrastructure: `toContain('revoke …')` on a
  migration cannot prove the final effective permissions, because SQL is
  cumulative and a later statement can grant them back.

## React Testing Library

- Query order: `getByRole` → label → text → placeholder. `getByTestId` is a last resort.
- `userEvent` over `fireEvent`. Always `await` user interactions and `findBy*`.
- Render through a real Redux Provider with the slice(s) under test mounted, not a hand-rolled mock store.
- Never assert on Redux state directly — assert on what the user sees.

## Test render helper

Every app exports a `renderWithProviders` helper that wraps RTL's render with the real
provider chain (Redux store, Router, Theme). Tests should never construct providers
ad-hoc — feature drift across tests is a known smell.

```tsx
// apps/web/src/test/render.tsx
import { Provider } from "react-redux";
import { setupStore } from "@/store";
import { ThemeProvider } from "@/styles/theme";

export function renderWithProviders(
  ui: ReactElement,
  { store = setupStore(), ...options }: ProvidersOptions = {},
) {
  return {
    store,
    ...rtlRender(<Provider store={store}><ThemeProvider>{ui}</ThemeProvider></Provider>, options),
  };
}
```

## Custom hooks

- Use `renderHook` from `@testing-library/react`.
- Wrap with the same provider chain via the `wrapper` option.
- Drive state changes with `act(() => ...)` and assert via `result.current`.

## Jest config (React Native / Expo only)

- Preset: `jest-expo`; `ts-jest` or `@swc/jest` for a non-Expo jest project.
- `testEnvironment: "jsdom"`.
- `setupFilesAfterEach`: import `@testing-library/jest-dom` for matchers (`toBeInTheDocument`, `toHaveAccessibleName`).

## Real-time tests in React

Real-time test contract and coverage matrix: see `rules/frontend/testing.md`. React delta: render via `renderWithProviders` against a store whose WS bridge middleware is wired to the in-memory fake, then `await screen.findByText(...)`.

## Accessibility assertions

- Use `getByRole` with `name:` predicate to enforce accessible names.
- `expect(button).toHaveAccessibleName(/place bet/i)`.
- Run `axe` per spec via `@axe-core/react` (component) or `@axe-core/playwright` (E2E).
