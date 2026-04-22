---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
  - "**/*.spec.tsx"
  - "src/test/**"
---

# Testing Rules

## What to test
- Every component that handles user interaction gets a test.
- Every custom hook gets a test via `renderHook`.
- Every service function gets a test with MSW mocking the network.
- Do NOT test implementation details — test behaviour from the user's perspective.

## Structure
- Co-locate tests: `ComponentName.test.tsx` next to `ComponentName.tsx`.
- One `describe` block per component/hook. One `it` per distinct behaviour.
- Arrange–Act–Assert pattern inside every test.

## React Testing Library rules
- Query by role first (`getByRole`), then label, then text — never `getByTestId` except as a last resort.
- Use `userEvent` over `fireEvent` for realistic interaction simulation.
- Always `await` async interactions: `await userEvent.click(...)`, `await screen.findBy*`.
- Never assert on internal state — only on what the user sees.

## MSW rules
- Define handlers in `src/test/handlers.ts`.
- Use `server.use(...)` inside individual tests to override the default handler.
- Always reset handlers in `afterEach`: `server.resetHandlers()`.

## Vitest config
- Set `environment: 'jsdom'` in `vitest.config.ts`.
- Import `@testing-library/jest-dom` matchers in `src/test/setup.ts`.
- Aim for 80%+ coverage on `src/features/` and `src/components/common/`.
