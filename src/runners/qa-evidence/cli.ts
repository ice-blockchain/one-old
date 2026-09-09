// src/runners/qa-evidence/cli.ts
// CLI argument parsing and the usage text (scenario schema included).

import * as path from 'path';

import {
  type Rec,
  type RunnerArgs,
} from './types';

export function isRecord(value: unknown): value is Rec {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function valueAfter(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  return index >= 0 && typeof argv[index + 1] === 'string' ? argv[index + 1]!.trim() : '';
}

/**
 * The window `--timeout-ms` is admitted into. Unchanged bounds; what changed is
 * that a value OUTSIDE them is now clamped to the nearest end instead of being
 * discarded for the default. The old form admitted a value only when it was
 * already in range, so `--timeout-ms 600000` — a caller explicitly asking for
 * ten minutes — silently became thirty seconds. Asking for more time must never
 * yield less time than asking for nothing at all.
 */
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;

/**
 * The default for a bound that wraps ONE interaction — a Playwright navigation,
 * an action, an HTTP readiness wait. Unchanged, and deliberately: this is the
 * same knob `browser.ts` hands to `page.goto(..., { timeout })` and to every
 * step, so a 300 s value here would multiply the wall clock of reporting one
 * hung route by ten (per route, per viewport) and buy nothing — a route that
 * has not painted in thirty seconds is not going to.
 */
export const STEP_TIMEOUT_MS = 30_000;

/**
 * Commands whose bound wraps a WHOLE external command rather than one
 * interaction: a project's entire test suite, `xcodebuild test`,
 * `./gradlew connectedAndroidTest`. Thirty seconds is not a bound on those, it
 * is a guarantee they are killed — and until the cut-short classification in
 * stack.ts landed, being killed was laundered into a justified exemption and
 * settled the run green.
 *
 * Their default is MAX_TIMEOUT_MS: not a new number, but this flag's own
 * ceiling one line up, so the default and the ceiling cannot drift apart. That
 * this repo already treats 30 s as under-sized for a whole evidence step is
 * visible in lighthouse.ts's LIGHTHOUSE_MIN_TIMEOUT_MS, which floors the same
 * knob at 120 s rather than honouring it. No shipped invocation passes `--timeout-ms` at all
 * (browser-qa/SKILL.md, senior-tester/agent.md, frontend/testing.md and
 * test-environment/core/run-sim/qa.ts all omit it), so this default is what
 * every real run actually gets.
 */
const WHOLE_COMMAND_BOUNDS: readonly string[] = ['stack', 'native'];

/**
 * Whether the caller actually ASKED for a bound, as opposed to leaving the flag
 * off or passing something that carries no request (``, `abc`, `0`, `-1`).
 * Single-sourced because two decisions turn on it and they must agree: which
 * default applies here, and whether stack.ts may widen a per-step bound to the
 * whole-command one. An explicit request is never widened.
 */
export function timeoutRequested(raw: string): boolean {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0;
}

export function resolveTimeoutMs(command: string, raw: string): number {
  const value = Number(raw);
  if (timeoutRequested(raw)) {
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
  }
  return WHOLE_COMMAND_BOUNDS.includes(command) ? MAX_TIMEOUT_MS : STEP_TIMEOUT_MS;
}

export function parseArgs(argv: readonly string[], cwd: string): RunnerArgs | null {
  const first = argv[0] || '';
  const command = first === 'manifest' || first === 'browser' || first === 'lighthouse' || first === 'native' || first === 'stack'
    ? first
    : first === 'help' || first === '--help' || first === '-h'
      ? 'help'
      : null;
  if (!command) return null;
  const projectRoot = path.resolve(valueAfter(argv, '--project-root') || cwd);
  const runId = valueAfter(argv, '--run-id');
  const buildDir = valueAfter(argv, '--build-dir');
  const timeoutRaw = valueAfter(argv, '--timeout-ms');
  const timeoutMs = resolveTimeoutMs(command, timeoutRaw);
  const timeoutMsExplicit = timeoutRequested(timeoutRaw);
  return {
    command,
    projectRoot,
    runId,
    buildDir,
    ...(valueAfter(argv, '--scenario-json') ? { scenarioJson: valueAfter(argv, '--scenario-json') } : {}),
    ...(valueAfter(argv, '--scenario-file') ? { scenarioFile: valueAfter(argv, '--scenario-file') } : {}),
    ...(valueAfter(argv, '--server-command-json')
      ? { serverCommandJson: valueAfter(argv, '--server-command-json') }
      : {}),
    ...(valueAfter(argv, '--server-cwd') ? { serverCwd: valueAfter(argv, '--server-cwd') } : {}),
    ...(valueAfter(argv, '--native-command-json')
      ? { nativeCommandJson: valueAfter(argv, '--native-command-json') }
      : {}),
    ...(valueAfter(argv, '--native-cwd') ? { nativeCwd: valueAfter(argv, '--native-cwd') } : {}),
    withLighthouse: argv.includes('--with-lighthouse'),
    ...(valueAfter(argv, '--artifact') ? { artifact: valueAfter(argv, '--artifact') } : {}),
    ...(valueAfter(argv, '--lighthouse-evidence')
      ? { lighthouseEvidence: valueAfter(argv, '--lighthouse-evidence') }
      : {}),
    ...(valueAfter(argv, '--out') ? { out: valueAfter(argv, '--out') } : {}),
    timeoutMs,
    timeoutMsExplicit,
  };
}

export function usage(): string {
  return [
    'traffic-one QA evidence runner',
    '',
    'Manifest:',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs manifest --run-id <id> --build-dir <outputRoot>',
    '',
    'Stack (no-browser contracts — uiImpact none/nonvisual; runs build/test/lint and writes the canonical report):',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs stack --run-id <id>',
    '  Add --artifact .traffic-one/reports/qa/<id>/lighthouse.raw.json when performance.required (no served listener).',
    '',
    'Browser (runner serves outputRoot itself; performance contracts run project-local Lighthouse on this listener):',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs browser --run-id <id> --build-dir <outputRoot> --scenario-json \'<json>\'',
    '  Add --with-lighthouse to request the same live-listener audit when performance is advisory.',
    '',
    'Browser SSR/custom command (runner starts command behind its own proxy; {PORT} is replaced):',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs browser --run-id <id> --build-dir <outputRoot> --server-command-json \'["pnpm","exec","next","start","-H","127.0.0.1","-p","{PORT}"]\' --scenario-json \'<json>\'',
    '',
    'Lighthouse raw artifact conversion (browser reports — owned listener; --build-dir required):',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs lighthouse --run-id <id> --build-dir <outputRoot> --artifact .traffic-one/reports/qa/<id>/lighthouse/report.json',
    '  (the raw artifact must have been captured from the exact report build origin/port while it was live)',
    '',
    'Lighthouse raw artifact conversion (stack / none-nonvisual + performance.required — no served listener, no --build-dir):',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs stack --run-id <id> --artifact .traffic-one/reports/qa/<id>/lighthouse.raw.json',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs lighthouse --run-id <id> --artifact .traffic-one/reports/qa/<id>/lighthouse.raw.json',
    '  (place a lighthouse-runner --skip-build JSON in this run QA directory first; conversion keeps contract/source/artifact-in-QA-dir/threshold checks)',
    '',
    'Native simulator/emulator:',
    '  iOS: node ~/.traffic-one/bin/qa-evidence-runner.cjs native --run-id <id> --native-command-json \'["xcodebuild","test","-scheme","App","-destination","platform=iOS Simulator,name=iPhone 16"]\'',
    '  Android: node ~/.traffic-one/bin/qa-evidence-runner.cjs native --run-id <id> --native-command-json \'["./gradlew",":app:connectedDebugAndroidTest"]\'',
    '  Add --native-cwd <project-relative-root> for a nested native project.',
    '  Commands are executed as bounded argv without a shell. PASS requires runtime-parsed xcresulttool summary JSON or Android connected-test JUnit XML.',
    '',
    'Bounds:',
    `  --timeout-ms <n>   clamped to ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}. Defaults to ${MAX_TIMEOUT_MS} for \`stack\` and \`native\`,`,
    `                     which bound a whole command, and ${STEP_TIMEOUT_MS} elsewhere, where it bounds one`,
    '                     navigation or action. A command killed at this bound reports INCONCLUSIVE:',
    '                     it produced no verdict, so the run is rejected rather than passed.',
    '                     Two steps narrow it further and say so here rather than silently: the',
    '                     Lighthouse audit takes at least 120000 whatever you pass, and the',
    '                     xcresulttool read takes at most 60000. It bounds ONE step, not the whole',
    '                     run: `browser` spends it per route, per viewport, per wait.',
    '',
    'Scenario schema:',
    '  {"schemaVersion":1,"routes":[{"route":"/","finalPath":"/","stableSelector":"main","steps":[{"type":"click","selector":"button"},{"type":"expect-visible","selector":"main"}]}]}',
    '  `route` is the CONTRACT route (evidence is indexed by it). When it is not a literal path — `*`,',
    '  `/courses/:courseSlug` — add `startPath` with the concrete URL to visit; it must match the pattern,',
    '  and for `*` it must be a URL no other declared route claims:',
    '  {"route":"*","startPath":"/does-not-exist",...}   {"route":"/courses/:courseSlug","startPath":"/courses/html-css",...}',
  ].join('\n');
}
