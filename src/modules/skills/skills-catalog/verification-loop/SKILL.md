---
name: verification-loop
description: >
  Verify changes and production readiness across supported stacks using
  runtime-owned capability, work-unit, and verification contracts. Select
  stack-native build/test/QA adapters and never assume npm, React, Supabase, or
  a browser.
metadata:
  source: everything-claude-code
  source_path: skills/verification-loop/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
  merged_source_paths:
    - skills/production-audit/SKILL.md
---

# Verification loop

## Contract preflight

1. Read the runtime capability profile, compiled architecture,
   `WorkUnitContractV1`, and `VerificationContractV2`.
2. Verify the current diff against the immutable run baseline and work-unit
   allowlist.
3. Use the repository's existing manifests and commands to resolve build,
   typecheck/static-analysis, lint, unit, integration, and QA adapters.
4. Refuse a silent partial scan. Missing evidence, a truncated structural scan,
   or an unavailable required adapter is not a pass.

The agent may add checks or raise `uiImpact`; it may not remove a contract check,
lower `uiImpact`, widen an allowlist, alter roots, or replace runtime hashes.

## Core verification

Run the checks that exist and apply to the changed surfaces:

- reproducible build or compile;
- language-native type/static analysis;
- lint/format verification;
- focused tests followed by the required broader suite;
- structural analyzer and compiled route/module contract;
- security scanner for changed/deployable surfaces;
- diff review for unrelated changes, unsafe generated files, and missing tests.

Examples are stack hints, not defaults:

- Node/TypeScript: package scripts already present in the selected workspace.
- Go: `go test`/`go vet` for the affected module.
- Python: the configured pytest/unittest, type checker, and linter.
- Laravel/PHP: Composer/PHPUnit/Pest/Artisan commands declared by the project.
- Native Swift/Kotlin: the selected Xcode/Gradle test and emulator adapter.

Do not require a frontend build, browser, DOM audit, or npm command for an API,
CLI, worker, data-only project, or Python script.

## UI QA matrix

Follow the mechanically derived `uiImpact`:

- `none`: relevant build/test/lint only; no browser.
- `nonvisual`: unit/component tests, DOM accessibility checks only where a DOM
  exists, and build; no mandatory browser E2E.
- `behavioral`: Playwright headless against the served identified build. Assert
  DOM behavior, actions, routing, hydration, and absence of unexpected console
  and network failures. Capture a screenshot only on failure.
- `visual`: all behavioral checks plus screenshots for changed routes at 390
  and 1440. Add 768 only when the contract detects tablet/breakpoint risk.
- `native-ui`: simulator/emulator and native adapter; no browser.

The interactive browser plugin is optional. Playwright remains required only
when the behavioral or visual web contract requires real-browser evidence.
If the required browser/native runtime is unavailable, report
`blocked-environment`; do not report a code failure or `verified`.

## Build identity

For served UI evidence, verify and record:

- run ID and source/build hash;
- PID, port, start time, and URL;
- application-served fingerprint;
- timestamp for each artifact.

Reject stale servers, reused ports with a different process/build, fingerprints
that do not match the current source, and artifacts older than the run.

## Lighthouse and SEO

Lighthouse is independent from functional QA. Run it only for redesigns,
important visual changes, detected performance risk, or an explicit request.

- Explicit plan thresholds are exact gates.
- Implicit thresholds are advisory and may use the existing 3% tolerance.
- SEO is a gate only when `seoMin` is explicit; otherwise report it as advisory.

## Production-readiness audit

Activate this section only when the user asks whether a release is safe to ship.
Evaluate only capabilities that exist:

- security/auth and secret handling;
- data integrity, migrations, retries, recovery, and backups;
- API/payment/webhook idempotency where present;
- reproducible deployment, health, observability, rollback, and incident owner;
- UI accessibility, privacy, support, and critical flows only for actual UI
  surfaces;
- native-store requirements only for a native release;
- cost controls for metered dependencies actually used.

Score only verified evidence. Mark missing evidence `UNVERIFIED`; do not infer it
from source shape. A numeric score can never override a failed required check,
an active claim, fallback pending, or incomplete verification.

Hard blockers include a failing required build/test/security gate, exposed
production credentials, unsafe destructive migrations, missing authorization on
owned data, and absent idempotency for payment mutations. Apply additional
surface-specific blockers only when that surface exists.

## Canonical report

Produce:

```text
VERIFICATION REPORT
===================
Capability profile: <id/hash>
Baseline:           <kind/hash>
Work unit:          <role/hash>
UI impact:          <none|nonvisual|behavioral|visual|native-ui>
Build/static/lint:  <PASS|FAIL|NOT_APPLICABLE|BLOCKED>
Tests:              <PASS|FAIL|BLOCKED> (<exact command/result>)
Structure:          <PASS|FAIL> (<finding IDs>)
QA:                 <PASS|FAIL|NOT_APPLICABLE|BLOCKED_ENVIRONMENT>
Security:           <PASS|FAIL|NOT_APPLICABLE>
Overall:            <VERIFIED|FAILED|BLOCKED>
```

List exact commands, hashes, artifacts, timestamps, skipped checks, and reasons.
Write evidence through the runtime helpers so lifecycle JSON remains atomic.
Never fabricate success or edit the settlement directly. A run is verified only
when reviewer, tester, QA, contracts, claims, fallback state, and canonical
settlement all agree.
