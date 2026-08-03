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
  const timeoutRaw = Number(valueAfter(argv, '--timeout-ms'));
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw >= 1_000 && timeoutRaw <= 300_000
    ? Math.floor(timeoutRaw)
    : 30_000;
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
    '',
    'Browser (runner serves outputRoot itself; performance contracts run project-local Lighthouse on this listener):',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs browser --run-id <id> --build-dir <outputRoot> --scenario-json \'<json>\'',
    '  Add --with-lighthouse to request the same live-listener audit when performance is advisory.',
    '',
    'Browser SSR/custom command (runner starts command behind its own proxy; {PORT} is replaced):',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs browser --run-id <id> --build-dir <outputRoot> --server-command-json \'["pnpm","exec","next","start","-H","127.0.0.1","-p","{PORT}"]\' --scenario-json \'<json>\'',
    '',
    'Lighthouse raw artifact conversion:',
    '  node ~/.traffic-one/bin/qa-evidence-runner.cjs lighthouse --run-id <id> --build-dir <outputRoot> --artifact .traffic-one/reports/qa/<id>/lighthouse/report.json',
    '  (advanced: the raw artifact must have been captured from the exact report build origin/port while it was live)',
    '',
    'Native simulator/emulator:',
    '  iOS: node ~/.traffic-one/bin/qa-evidence-runner.cjs native --run-id <id> --native-command-json \'["xcodebuild","test","-scheme","App","-destination","platform=iOS Simulator,name=iPhone 16"]\'',
    '  Android: node ~/.traffic-one/bin/qa-evidence-runner.cjs native --run-id <id> --native-command-json \'["./gradlew",":app:connectedDebugAndroidTest"]\'',
    '  Add --native-cwd <project-relative-root> for a nested native project.',
    '  Commands are executed as bounded argv without a shell. PASS requires runtime-parsed xcresulttool summary JSON or Android connected-test JUnit XML.',
    '',
    'Scenario schema:',
    '  {"schemaVersion":1,"routes":[{"route":"/","finalPath":"/","stableSelector":"main","steps":[{"type":"click","selector":"button"},{"type":"expect-visible","selector":"main"}]}]}',
    '  `route` is the CONTRACT route (evidence is indexed by it). When it is not a literal path — `*`,',
    '  `/courses/:courseSlug` — add `startPath` with the concrete URL to visit; it must match the pattern,',
    '  and for `*` it must be a URL no other declared route claims:',
    '  {"route":"*","startPath":"/does-not-exist",...}   {"route":"/courses/:courseSlug","startPath":"/courses/html-css",...}',
  ].join('\n');
}
