---
name: browser-qa
description: >
  Verify a web UI against Traffic One VerificationContractV2 with local
  Playwright, risk-proportional screenshots, build identity, runtime assertions,
  and conditional Lighthouse. Trigger on browser QA, visual QA, responsive
  testing, UI flows, Lighthouse, page speed, or Core Web Vitals.
---

# Browser QA

Use the runtime contract, not a fixed screenshot checklist.

## Required input

1. Read `.traffic-one/.one.json` and its exact `currentRunId`.
2. Read `.traffic-one/runs/<runId>/verification-v2.json`.
3. Refuse to guess missing routes, widths, UI impact, or performance thresholds.
4. Use the production build from the same source state. Never validate a
   leftover dev/preview server.

`uiImpact` is runtime-derived. You may raise it when you discover more risk;
never lower it:

- `none`: run the contract's stack build/test/lint checks. Do not launch a browser.
- `nonvisual`: run unit/component checks and axe when a DOM fixture exists. Do
  not require browser E2E.
- `behavioral`: run local headless Playwright on every changed route. Assert
  DOM, actions, routing, hydration, console errors, and network errors.
  Screenshots are optional and should normally be captured only on failure.
- `visual`: run the behavioral matrix and capture fresh screenshots at every
  width listed in `requiredScreenshotWidths`—normally 390 and 1440; 768 appears
  only when runtime detected tablet/breakpoint risk.
- `native-ui`: stop. Use the contract's simulator/emulator adapter; a browser is
  invalid evidence.

## Browser choice

Use the project's local Playwright setup or local `@playwright/test` dependency
in a separate browser process. The interactive browser plugin/in-app browser is
optional for diagnosis and manual exploration; it is never required evidence
and never replaces the canonical report. Do not use editor-embedded screenshot
APIs from a role subagent.

If the required browser binary is unavailable, keep `none` and `nonvisual`
eligible to pass. Mark `behavioral` or `visual` as `blocked-environment`; do not
call it a code failure and do not emit `TESTS_GREEN`.

## Canonical runtime runner

Do not hand-author `report-v2.json`, build fingerprints, route booleans, or
Lighthouse summaries. The bundled dependency-free runner computes the build
manifest, owns the listener, loads Playwright and Lighthouse only from the
project, writes machine evidence, writes `report-v2.json`, validates it while
the listener is live, and then tears the listener down.

After the stack's production build, run this manifest preflight with the actual
output directory:

```bash
node ~/.traffic-one/bin/qa-evidence-runner.cjs manifest \
  --run-id "$RUN_ID" \
  --build-dir apps/web/dist
```

Write a bounded scenario at
`.traffic-one/reports/qa/$RUN_ID/scenario-v1.json`. It must cover
`changedRoutes` exactly. Every route needs a stable selector, its planned final
path, and at least one real `click`, `fill`, `press`, `check`, or `select`
action—not only visibility assertions:

```json
{
  "schemaVersion": 1,
  "routes": [{
    "route": "/",
    "finalPath": "/",
    "stableSelector": "main",
    "steps": [
      { "type": "click", "selector": "button[data-testid='primary-action']" },
      { "type": "expect-visible", "selector": "main" }
    ]
  }]
}
```

`route` is the compiled contract's route IDENTITY and the key the evidence is
filed under — it is matched against `changedRoutes`, never fetched. When the
identity is not a literal path, add `startPath` with the concrete URL to visit:

```json
{ "route": "*", "startPath": "/does-not-exist", "finalPath": "/does-not-exist", "stableSelector": "[data-testid='not-found']", "steps": [ … ] }
{ "route": "/courses/:courseSlug", "startPath": "/courses/html-css", "finalPath": "/courses/html-css", "stableSelector": "main", "steps": [ … ] }
```

A route that `fill`s a form must also SUBMIT it (`click`/`press` after the last
`fill`) and assert the result afterwards (`expect-visible`, `expect-text`, or
`expect-url`). A scenario that fills fields and stops is compatible with the
form being completely broken and still reports `actions: passed`. The success
assertion must name the working outcome — never a degraded-state affordance
(a "configure this first" call to action, a placeholder, a coming-soon panel,
or an off-site `a[href='https://…']` link). Asserting the fallback the app
renders when it is misconfigured makes the bug the pass condition; the runner
rejects such a scenario.

`startPath` must satisfy its own pattern, and a `*` probe must be a URL no other
declared route claims — otherwise the sweep exercises the sibling route instead
of the 404. Never rewrite the architecture to turn a pattern into a literal path
to simplify the scenario.

Run the exact QA command:

```bash
node ~/.traffic-one/bin/qa-evidence-runner.cjs browser \
  --run-id "$RUN_ID" \
  --build-dir apps/web/dist \
  --scenario-file ".traffic-one/reports/qa/$RUN_ID/scenario-v1.json"
```

For an SSR/custom server, append a bounded argv adapter. The runner starts it
behind its own listener; `{PORT}` is replaced without a shell:

```bash
--server-command-json '["pnpm","exec","next","start","-H","127.0.0.1","-p","{PORT}"]'
```

Use the real output root for each stack (`dist`, `.next`, `.output`, or the
custom build directory); never point at source files. `behavioral` success
needs no screenshot, but the runner captures one when a behavioral assertion
fails. `visual` captures and decodes the contract widths and rejects horizontal
overflow. Evidence paths containing dot/traversal segments, globs, control
characters, or symlink escapes are invalid.

The run takes MINUTES (screenshots × widths × routes, plus Lighthouse when
performance is required). Run it in the foreground with a long timeout and
watch the `qa-evidence: …` heartbeat lines on stderr; the single JSON line on
stdout is the completion signal. NEVER start a second instance while one is
running — a per-run lock makes the second exit immediately with
`{"status":"already-running","lockPid":…}` (exit code 3); treat that as "a
runner is already working: wait", not as an error to retry. Overlapping
runners once interleaved artifacts and invalidated an entire QA pass.

The command produces:

- `.traffic-one/reports/qa/$RUN_ID/machine-evidence-v1.json`;
- Playwright traces and risk-required/failure screenshots;
- `.traffic-one/reports/qa/$RUN_ID/report-v2.json`;
- when performance is required, `lighthouse.raw.json` and
  `lighthouse-evidence-v1.json`.

When `performance.required` is true, install project-local `lighthouse`; the
same browser command runs it against the same live origin and port before
report validation. Add `--with-lighthouse` only for an explicitly requested
advisory audit. An artifact from another localhost port is stale/foreign and
must fail. Explicit thresholds have zero tolerance; advisory thresholds retain
the contract's 3% tolerance; SEO gates only with explicit `seoMin`.

Missing project-local Playwright/browser or required Lighthouse is
`blocked-environment`, never a code pass. A chat summary, copied screenshot,
timestamp-only Lighthouse JSON, arbitrary server self-report, or manually set
booleans is not canonical evidence.

## Blocked environment

Use `status: "blocked-environment"` with a short, secret-free blocker summary
when the contract requires a real browser or native runtime and that environment
cannot run. This is nonterminal: never reinterpret it as verified and never
fabricate screenshots.

## Handoff

Report the contract hash, UI impact, commands, source/build fingerprint, routes,
widths, artifact paths, Lighthouse gate/advisories when applicable, and the
runtime verifier result.
