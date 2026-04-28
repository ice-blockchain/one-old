---
paths:
  - "apps/**/e2e/**"
  - "apps/**/src/**/*.test.*"
  - "apps/**/src/**/*.spec.*"
  - "src/**/*.test.*"
  - "src/**/*.spec.*"
  - "capacitor.config.*"
  - "apps/**/capacitor.config.*"
---

# Ionic Testing Rules

React unit and integration rules still apply. Ionic delivery adds packaging and
device-behavior verification.

## Unit and integration

- Keep component tests in Jest + Testing Library with the same provider helpers
  as React web.
- Mock Capacitor plugins at the service/hook boundary, not inside components.
- Cover permission granted, denied, unavailable, and plugin-error paths.

## E2E

- Playwright remains required for web routes and responsive mobile viewport
  checks.
- Capacitor packaging changes require at least one native smoke check on the
  requested platform before release.
- Critical flows cover app launch, auth/session restore, deep links, Android
  back behavior, keyboard input, offline/reconnect, and permission prompts.

## Visual QA

- Capture mobile screenshots for dense screens, modals, forms, and bottom
  actions.
- Verify no horizontal overflow, clipped text, hidden focus, or keyboard-covered
  submit actions.
