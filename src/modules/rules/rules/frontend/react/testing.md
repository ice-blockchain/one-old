---
paths:
  - "**/*.test.tsx"
  - "**/*.spec.tsx"
  - "src/test/**"
  - "apps/**/src/test/**"
---

# React Testing — RTL + jest specifics

Framework-agnostic test layering, MSW patterns, Playwright config live in
`frontend/testing.md`. This file covers React Testing Library + jest.

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

## Jest config (baseline)

- Preset: `ts-jest` or `@swc/jest` for speed.
- `testEnvironment: "jsdom"`.
- `setupFilesAfterEach`: import `@testing-library/jest-dom` for matchers (`toBeInTheDocument`, `toHaveAccessibleName`).

## Real-time tests in React

Real-time test contract and coverage matrix: see `rules/frontend/testing.md`. React delta: render via `renderWithProviders` against a store whose WS bridge middleware is wired to the in-memory fake, then `await screen.findByText(...)`.

## Accessibility assertions

- Use `getByRole` with `name:` predicate to enforce accessible names.
- `expect(button).toHaveAccessibleName(/place bet/i)`.
- Run `axe` per spec via `@axe-core/react` (component) or `@axe-core/playwright` (E2E).
