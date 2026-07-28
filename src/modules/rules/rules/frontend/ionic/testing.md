---
paths:
  - "apps/**/e2e/**"
  - "apps/**/src/**/*.test.*"
  - "apps/**/src/**/*.spec.*"
  - "web/**/src/**"
  - "frontend/**/src/**"
  - "client/**/src/**"
  - "packages/**/src/**"
  - "src/**/*.test.*"
  - "src/**/*.spec.*"
  - "capacitor.config.*"
  - "apps/**/capacitor.config.*"
---

# Ionic Testing Rules

The test layers, coverage targets, runner, and framework-specific helpers from
the selected web profile apply in full. Ionic delivery adds packaging and
device-behavior verification.

## Unit and integration

- Mock Capacitor plugins at the service/hook boundary, not inside components.
- Cover permission granted, denied, unavailable, and plugin-error paths.

## E2E

- Playwright remains required for web routes and responsive mobile viewport
  checks.
- Capacitor packaging changes require at least one native smoke check on the
  requested platform before release.
- Critical flows cover app launch, auth/session restore, deep links, Android
  back behavior, keyboard input, offline/reconnect, and permission prompts.

## Mobile-UX visual QA (canonical owner)

This file owns the mobile-UX verification checklist; components/core/styles
reference it rather than restating it.

- Capture mobile screenshots for dense screens, modals, forms, and bottom
  actions.
- Verify no horizontal overflow, clipped text, hidden focus, keyboard-covered
  submit actions, or safe-area collisions before delivery.
