---
name: click-path-audit
description: Trace user-facing UI touchpoints through handlers, state stores, effects, async calls, and final visible state. Use when buttons/forms/toggles appear wired but do the wrong thing, after store refactors, before release on critical flows, or when users report "nothing happens".
metadata:
  source: everything-claude-code
  source_path: skills/click-path-audit/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Click Path Audit

Find bugs where functions work individually but the final UI state contradicts
what the control promises.

## When to use

- A button, menu item, form submit, toggle, tab, or keyboard shortcut appears to
  do nothing.
- Store actions were refactored and shared state may reset other fields.
- A critical launch path needs behavioral verification beyond static reading.
- A UI path has async races, optimistic updates, or multiple state layers.

## Workflow

### 1. Map state actions first

For every Redux slice, RTK Query mutation, zustand store, context, and service in
scope, list:

- state read
- state written
- fields reset as side effects
- network or WebSocket side effects
- relevant effects/subscriptions that respond to the state

Flag actions that reset fields owned by another action.

### 2. Trace each touchpoint

For each user-facing control:

```text
TOUCHPOINT: <label> in <file:line>
HANDLER: <handler name or inline>
TRACE:
  1. <call> -> reads {...}, writes {...}
  2. <call> -> resets {...}
  3. <effect/mutation/socket> -> final state {...}
EXPECTED: <what the label promises>
ACTUAL: <what the user can observe>
VERDICT: OK | BUG | UNVERIFIED
```

### 3. Check bug patterns

- Sequential undo: a later call resets an earlier state change.
- Async race: requests resolve out of order and overwrite current UI state.
- Stale closure: callbacks use old state or missing dependencies.
- Missing transition: handler validates or opens UI but never performs the named
  action.
- Conditional dead path: required branch is unreachable in the current state.
- Effect interference: `useEffect` or subscription resets the state after the
  user action.
- Optimistic rollback gap: failed mutation rolls back data but leaves controls,
  toast, route, or loading state inconsistent.

### 4. Verify with user-visible evidence

- Prefer React Testing Library or Playwright assertions on what the user sees.
- For store-level bugs, add focused unit tests for the action sequence and one
  integration test for the touchpoint.
- If the path depends on backend state, mock at the service/network boundary.

## Output

Report only actionable findings:

```text
CLICK-PATH-001 [HIGH]
Touchpoint: Save button in apps/web/src/features/profile/ProfileForm.tsx:88
Pattern: Async race
Trace: submitProfile -> updateProfile mutation -> route refresh resets draft
Expected: user remains on saved profile with success state
Actual: draft reappears after refresh
Fix: invalidate the profile tag after success and clear draft only after the
mutation settles successfully.
```
