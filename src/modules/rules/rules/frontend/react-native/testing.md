---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
  - "**/*.spec.tsx"
  - "**/.maestro/**"
  - "apps/**/src/test/**"
  - "packages/**/test/**"
---

# React Native Testing — Jest + RNTL + Maestro

Framework-agnostic test layering lives in `rules/frontend/testing.md`. This file
covers native-specific tools.

## Unit and integration
- Use jest + jest-expo.
- Use `@testing-library/react-native` for components and hooks.
- Query order: role -> label text -> visible text -> placeholder -> testID last.
- Use `userEvent` from RNTL when available; otherwise use `fireEvent` sparingly.

## Test helper
- The shared-render-helper rule (every app exports `renderWithProviders`; tests never assemble ad-hoc provider stacks) is framework-agnostic — see `rules/frontend/testing.md`. The RN helper lives at `apps/mobile/src/test/render.tsx` and wires the real provider chain: Redux, theme, safe area, and router mocks.
- Mock native modules at the boundary, not inside components.

## Services
- Use msw or typed service fakes for HTTP.
- Use in-memory WS fake for real-time.
- Never hit real devices, sockets, or network services in unit/integration tests.

## Maestro E2E
- Device flows live in `.maestro/*.yml`.
- Cover critical journeys: onboarding/login, core navigation, primary mutation, offline/reconnect behavior.
- E2E builds use an EAS profile that creates simulator/emulator artifacts.
- Prefer stable accessibility labels over brittle text when selecting controls.

## Coverage
- The coverage target (>=80% on `apps/*/src/features/` and every `packages/*` library, treated as a smoke alarm not a goal) is framework-agnostic — see `rules/frontend/testing.md`.
- Coverage does not replace device smoke testing on iOS and Android before release.
