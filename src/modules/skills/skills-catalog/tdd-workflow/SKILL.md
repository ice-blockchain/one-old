---
name: tdd-workflow
description: >
  Apply test-driven development to features, bug fixes, and behavior-preserving
  refactors in any supported stack. Select tests and tools from the runtime
  capability and verification contracts; never assume React, npm, or a browser.
metadata:
  source: everything-claude-code
  source_path: skills/tdd-workflow/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Test-driven development

## Authority

Before choosing a test:

1. Read the active capability profile, `WorkUnitContractV1`, and
   `VerificationContractV2` when present.
2. Use only the test adapters and output paths enabled by those contracts.
3. Detect the repository's real commands from its manifests, task files, and
   existing tests. Do not invent npm scripts, frameworks, or directory layouts.
4. Treat explicit project thresholds as exact gates. Existing repository
   thresholds remain authoritative. In their absence, coverage is evidence and
   a review signal, not a fabricated universal percentage gate.

The runtime-owned contracts override examples in this skill. An agent may raise
test rigor or `uiImpact`, but may not lower a required check.

## RED → GREEN → REFACTOR

For each observable behavior:

1. **RED** — add the smallest regression test that exercises the missing or
   broken behavior. Run that target and confirm it fails for the intended
   reason.
2. **GREEN** — implement the smallest production change that makes the same
   target pass.
3. **REFACTOR** — improve names and structure without changing behavior, then
   rerun the focused target.
4. Run the broader checks required by `VerificationContractV2`.

A compile-time failure is valid RED only when the new test deliberately
references the missing contract and the failure is not setup noise. If the
repository has no suitable harness, record that limitation and use the nearest
deterministic executable check; do not claim TDD evidence that was not run.

Do not create commits merely because this skill is active. Commit only when the
user or the current workflow explicitly authorizes it.

## Select the test by capability

- `api`: unit tests for domain logic plus handler/contract/integration tests for
  changed boundaries.
- `cli`: argument, exit-code, stdout/stderr, filesystem, and error-path tests.
- `worker`: job input/output, retry, idempotency, and failure-path tests.
- `data`: migration/query/serialization tests using the repository's safe local
  adapter.
- `web-ui` + `nonvisual`: unit or component tests; no browser is required solely
  because the repository contains a frontend.
- `web-ui` + `behavioral`: Playwright headless on the identified build for
  routing, hydration, forms, state, navigation, console, and network failures.
  A screenshot is required only on failure.
- `web-ui` + `visual`: the behavioral checks plus contract screenshots at 390
  and 1440 for changed routes; add 768 only for detected tablet/breakpoint risk.
- `native-ui`: use the declared simulator/emulator adapter and native UI tests;
  never substitute browser QA.
- no UI surface: do not load or invoke browser, design, accessibility-DOM, or
  screenshot workflows.

Playwright is for browser behavior that cannot be established by unit or
component tests. The interactive browser plugin is never a TDD prerequisite.

## Test quality

- Assert observable behavior, not private implementation state.
- Cover the happy path, boundaries, invalid inputs, and meaningful failures.
- Keep tests independent and deterministic; replace sleeps with observable
  readiness conditions.
- Stub external services at owned boundaries. Never call production systems.
- Prefer semantic selectors for UI and stable public contracts for APIs.
- Preserve existing test organization unless the compiled architecture contract
  permits a new test root.
- Add generated fixtures only inside the work-unit allowlist.

Use the stack-specific testing skill when active, for example Go, Python,
Laravel, Django, Spring, Kotlin, C#, C++, Rust, Perl, or the repository's
JavaScript runner. Those skills supply syntax and commands; this skill owns the
RED/GREEN evidence protocol.

## Evidence

Report:

- the exact RED command and intended failure;
- the exact GREEN command and result;
- broader contract checks and their results;
- coverage only when measured, with the repository/plan threshold identified;
- skipped or blocked checks with the exact reason;
- UI impact and adapter used, if any.

Never mark a run verified from test prose alone. The tester evidence,
`VerificationContractV2`, QA report, and canonical settlement must agree.
