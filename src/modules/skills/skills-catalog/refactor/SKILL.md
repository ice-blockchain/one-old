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
  entrypoint, multi-page, route-module, or allowlist blockers. A scan that hit
  its file BOUND is not one of them — it is recorded rather than refused, and
  pins `uiImpact` to the truncated-scan floor, so it costs the refactor more
  browser evidence instead of a deny. An unreadable file or directory, an entry
  the walk cannot classify, or an unfollowed symbolic link is recorded the same
  way and costs the same extra evidence — and it costs the refactor something
  else too: the subtree behind that entry was not read, so nothing in this
  report says whether the behaviour you are preserving still holds there. A link
  is free when the same walk read its target under the target's own real path,
  and in the structure scan also when its target resolves under a build output
  the compiled architecture DECLARES — that one leaves no record to read, so an
  empty skip list is not proof that no link was stepped over, and the collapse
  scan records the same link anyway. One that carries a source name into a
  generated or build directory the contract does not declare is recorded, because
  no report judges those bytes under either name. Treat a skipped path over code
  you touched as unverified, not as clean. A source root that does not resolve
  is an error and does block, and no exception lifts it.
- Use Playwright/screenshots only when the derived web `uiImpact` requires
  them; use native QA for native UI; use no browser for API/CLI/worker/data-only
  work.
- Report preserved behavior, structural improvement, exact checks, and any
  blocked or intentionally deferred evidence.
