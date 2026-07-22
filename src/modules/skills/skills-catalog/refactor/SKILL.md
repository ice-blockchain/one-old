---
name: refactor
description: >
  Use PROACTIVELY whenever the user asks to refactor, clean up, improve, simplify, or fix
  code quality issues in existing React code.
  Triggers: "refactor this", "clean up", "improve this code", "simplify", "this is messy",
  "too complex", "extract", "split this component", "this component is too big".
---

# Skill: Refactor

Identify issues and confirm before making changes.

1. List each issue found (size, state, performance, type safety, forbidden patterns)
2. State what will change and what will NOT change
3. Ask: "Should I go ahead?"

## Refactor checklist

Before editing:

- Capture the behavior that must remain stable: public props/types, routes, API calls,
  loading/error/empty states, analytics, accessibility, and visible copy.
- Run the smallest relevant tests or record the missing coverage. Add a regression
  test before changing logic when the current behavior is easy to break.
- Identify the narrowest ownership boundary. Do not mix a refactor with unrelated
  styling, dependency upgrades, or product behavior changes.

While editing:

- Prefer small named components/hooks and explicit data flow over new abstraction
  layers. Extract only concepts with a clear responsibility or reuse case.
- Preserve semantic HTML, keyboard behavior, focus order, and responsive states.
- Keep effects synchronized with their real dependencies; remove duplicated or
  derived state and avoid memoization without a measured reason.
- Replace unsafe casts and implicit `any` with domain types and narrowing at input
  boundaries. Keep exported contracts backward-compatible unless the user approved
  a migration.
- Do not add a package merely to shorten local code. Any new dependency still needs
  the repository's dependency approval flow.

After editing:

- Run focused tests, typecheck, lint, and the relevant production build.
- Compare the affected UI at supported widths when layout or interaction changed.
- Report the preserved behavior, the structural improvement, checks run, and any
  intentionally deferred follow-up.
