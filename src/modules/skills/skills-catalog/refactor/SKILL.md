---
name: refactor
description: >
  Refactor existing code in any supported stack while preserving observable
  behavior and runtime-owned architecture, work-unit, and verification
  contracts. Use for cleanup, simplification, extraction, or complexity
  reduction; never assume React or a UI.
---

# Refactor

## Before editing

- Read the capability profile, compiled architecture, work-unit allowlist, and
  verification contract when present.
- Identify the smallest ownership boundary and the public behavior that must
  remain stable: APIs, types, routes, output, errors, persistence, events, CLI
  exit codes, or UI behavior as applicable.
- Run focused characterization/regression tests, or record why no executable
  harness exists.
- Keep product behavior, dependencies, schema, and public contracts unchanged
  unless the user explicitly requested a migration.

## While editing

- Split responsibilities at the framework's real module boundaries; do not
  replace them with a generic `components/pages` layout when the compiled
  profile uses another convention.
- Prefer explicit data flow and named units over new abstraction layers.
- Remove duplication only when the extracted concept has one clear owner.
- Preserve concurrency, transactions, idempotency, error semantics, and
  compatibility at external boundaries.
- Do not widen the work-unit allowlist or modify runtime-owned roots, limits,
  baseline, or contract hashes.
- Do not add a dependency merely to shorten local code.
- For UI surfaces, preserve semantics, keyboard/focus behavior, responsive
  states, copy, and analytics. These checks do not apply to non-UI profiles.

## After editing

- Run the focused tests plus every check required by
  `VerificationContractV2`.
- Run the structural analyzer; a refactor cannot use an exception to bypass
  entrypoint, multi-page, route-module, allowlist, or incomplete-scan blockers.
- Use Playwright/screenshots only when the derived web `uiImpact` requires
  them; use native QA for native UI; use no browser for API/CLI/worker/data-only
  work.
- Report preserved behavior, structural improvement, exact checks, and any
  blocked or intentionally deferred evidence.
