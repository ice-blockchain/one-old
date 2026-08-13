// src/runners/qa-evidence/native.ts
// Native adapters: Xcode/Android runs, result parsing, and the native
// subcommand.

import * as fs from 'fs';
import * as path from 'path';
import { pluginVersion } from '../../config/plugin-identity';
import { stableContractJson } from '../../shared/architecture-contract';
import { writeJson } from '../../shared/fsjson';
import {
  combineNativeSummaries,
  contentHash,
  createQaNativeEvidence,
  parseAndroidJUnitXml,
  parseXcodeResultSummary,
  type QaNativeArtifactV1,
  type QaNativeTestSummaryV1,
} from '../../shared/qa-evidence-runtime';
import {
  CHECK_INCONCLUSIVE_PREFIX,
  qaReportV2Path,
  validateQaReportV2,
  type QaReportV2,
} from '../../shared/qa-report-v2';
import { sha256 } from '../../shared/text';

import {
  type RunnerArgs,
} from './types';
import {
  ensureProjectDirectory,
  type LoadedNativeRun,
  outputPath,
  publishQaReportV2,
  qaDir,
  withExecutedStackChecks,
} from './run-context';
import { nativeCheckStatuses } from './report-publish';
import {
  androidResultFiles,
  androidResultRoots,
  collectNativeArtifacts,
  configuredNativeCommand,
  fileSnapshot,
  nativeArtifact,
  runBoundedProcess,
  unclassifiedProcessKind,
  type BoundedProcessResult,
  type NativeMachineResult,
} from './native-process';
import { MAX_TIMEOUT_MS } from './cli';
import { copyRegularFile, readRegularFileOrThrow } from '../../shared/bounded-read';

// Reading an .xcresult bundle is a local parse, not a test run, so it takes at
// most this much however wide --timeout-ms is. It stays BELOW the flag's
// ceiling; the pin lives in __tests__/inconclusive-evidence.test.ts.
export const XCRESULTTOOL_MAX_TIMEOUT_MS = 60_000;

/**
 * The bound for ONE native adapter run.
 *
 * It is `args.timeoutMs` and nothing else: a native run is never a leg of
 * another command, so there is no inherited per-step default to widen the way
 * `stackBoundMs` widens one. What it needed is the OTHER half of that
 * function — the guard against a bound that is not a number. `cli.ts` clamps
 * every value the flag can carry, so a real invocation always arrives with one,
 * but a directly-constructed RunnerArgs (tests, the test-environment harness)
 * carries none, and this path took it raw. That is the caller shape
 * `stackBoundMs`'s own docstring was written for, and the consequence is the
 * same one it names: `setTimeout(fn, NaN)` fires IMMEDIATELY, so the timer that
 * enforces the bound would kill a healthy `xcodebuild` before it had started
 * and report a manufactured INCONCLUSIVE. The fallback is the whole-command
 * bound, which is what `cli.ts` produces for `native` anyway.
 */
export function nativeBoundMs(args: RunnerArgs): number {
  return Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : MAX_TIMEOUT_MS;
}

/**
 * One native attempt: what ran, how it ended, and — when it ended badly —
 * WHICH process is being described and what bound that process had.
 *
 * `stage` and `boundMs` exist because the xcode path runs two bounded commands,
 * the adapter and then the result-bundle parser, and it returned the PARSER's
 * result as `process` whenever the parser was what failed. Everything
 * downstream reads that object as the adapter, so a hung `xcresulttool`
 * produced "the xcode-simulator adapter was still running at its bound and was
 * killed" about an adapter that had exited cleanly, quoting `args.timeoutMs`
 * when the bound that actually fired was the parser's own 60 s cap. Those are
 * different problems with different fixes and the message named the wrong one.
 */
interface NativeAttempt {
  process: BoundedProcessResult;
  machine: NativeMachineResult | null;
  detail: string;
  stage: 'adapter' | 'result-bundle parser';
  boundMs: number;
}

async function runXcodeNative(
  args: RunnerArgs,
  command: readonly string[],
  cwd: string,
  qaRoot: string,
  captureRoot: string,
  startedAtMs: number,
): Promise<NativeAttempt> {
  const bundle = path.join(captureRoot, 'result.xcresult');
  const actualCommand = [...command, '-resultBundlePath', bundle];
  const boundMs = nativeBoundMs(args);
  const processResult = await runBoundedProcess(actualCommand, cwd, boundMs, {
    label: 'native xcode-simulator',
  });
  const adapter = { stage: 'adapter' as const, boundMs };
  if (processResult.kind !== 'completed' || !fs.existsSync(bundle)) {
    return {
      process: processResult,
      machine: null,
      detail: processResult.stderr || processOutcome(processResult),
      ...adapter,
    };
  }
  const parserBoundMs = Math.min(boundMs, XCRESULTTOOL_MAX_TIMEOUT_MS);
  const parserResult = await runBoundedProcess([
    'xcrun',
    'xcresulttool',
    'get',
    'test-results',
    'summary',
    '--schema-version',
    '0.1.0',
    '--path',
    bundle,
    '--compact',
  ], cwd, parserBoundMs);
  if (parserResult.kind !== 'completed' || parserResult.exitCode !== 0) {
    return {
      process: parserResult,
      machine: null,
      detail: parserResult.stderr || 'xcresulttool could not read the result bundle',
      stage: 'result-bundle parser',
      boundMs: parserBoundMs,
    };
  }
  let raw: unknown;
  try { raw = JSON.parse(parserResult.stdout); } catch { raw = null; }
  const summary = parseXcodeResultSummary(raw);
  if (!summary) {
    return {
      process: processResult,
      machine: null,
      detail: 'xcresulttool summary JSON is unsupported or incomplete',
      ...adapter,
    };
  }
  const summaryPath = path.join(captureRoot, 'xcode-result-summary.json');
  writeJson(summaryPath, raw);
  const artifacts = collectNativeArtifacts(qaRoot, captureRoot, startedAtMs);
  if (!artifacts) {
    return {
      process: processResult,
      machine: null,
      detail: 'xcresult artifact scan was incomplete or exceeded bounds',
      ...adapter,
    };
  }
  return {
    process: processResult,
    machine: { parser: 'xcode-xcresult-summary-v1', summary, artifacts },
    detail: '',
    ...adapter,
  };
}

async function runAndroidNative(
  args: RunnerArgs,
  command: readonly string[],
  cwd: string,
  qaRoot: string,
  captureRoot: string,
  startedAtMs: number,
): Promise<NativeAttempt> {
  const boundMs = nativeBoundMs(args);
  const adapter = { stage: 'adapter' as const, boundMs };
  const beforeRoots = androidResultRoots(cwd);
  const beforeFiles = beforeRoots ? androidResultFiles(beforeRoots) : null;
  if (!beforeRoots || !beforeFiles) {
    return {
      process: { kind: 'completed', exitCode: null, signal: null, stdout: '', stderr: '' },
      machine: null,
      detail: 'Android result pre-scan was incomplete',
      ...adapter,
    };
  }
  const before = fileSnapshot(beforeFiles);
  const processResult = await runBoundedProcess(command, cwd, boundMs, {
    label: 'native android-emulator',
  });
  const roots = androidResultRoots(cwd);
  const files = roots ? androidResultFiles(roots) : null;
  if (!roots || !files) {
    return { process: processResult, machine: null, detail: 'Android result scan was incomplete', ...adapter };
  }
  const fresh = files.filter((file) => {
    try {
      const real = fs.realpathSync(file);
      const stat = fs.lstatSync(real);
      return !stat.isSymbolicLink()
        && stat.isFile()
        && stat.mtimeMs + 1_000 >= startedAtMs
        && before.get(real) !== contentHash(real);
    } catch {
      return false;
    }
  });
  const summaries: QaNativeTestSummaryV1[] = [];
  const copied: string[] = [];
  for (const [index, source] of fresh.entries()) {
    let text = '';
    try { text = readRegularFileOrThrow(source); } catch { continue; }
    const summary = parseAndroidJUnitXml(text);
    if (!summary) continue;
    const target = path.join(captureRoot, `android-result-${String(index + 1).padStart(4, '0')}.xml`);
    if (!copyRegularFile(source, target, true)) continue;
    summaries.push(summary);
    copied.push(target);
  }
  const summary = combineNativeSummaries(summaries);
  const artifacts = copied.map((file) => nativeArtifact(qaRoot, file, startedAtMs));
  if (!summary || artifacts.some((artifact) => !artifact)) {
    return {
      process: processResult,
      machine: null,
      detail: 'No fresh supported Android connected-test JUnit XML was produced',
      ...adapter,
    };
  }
  return {
    process: processResult,
    machine: {
      parser: 'android-junit-xml-v1',
      summary,
      artifacts: artifacts as QaNativeArtifactV1[],
    },
    detail: '',
    ...adapter,
  };
}

/**
 * Whether the adapter run was killed mid-flight rather than finishing.
 *
 * `timeout` used to be folded into `nativeEnvironmentMissing` below, which
 * reported it as "Native environment unavailable for xcode-simulator" — a
 * DIAGNOSIS the runner never made. A simulator that is absent and a test run
 * that was too slow are different problems with different fixes, and the
 * message named the wrong one. `output-limit` was worse: it fell through to
 * `failed`, so a build that wrote more than 8 MB of log and would otherwise
 * have passed was reported as a product failure nobody observed.
 *
 * A SIGNAL death was the third of these and the last to be classified. An
 * `xcodebuild test` that an OOM killer, a cgroup cancellation or a segfaulting
 * test host takes out reports `exitCode: null` with no error, so it fell into
 * the same `failed` arm as the overflow: "Native adapter xcode-simulator failed
 * or produced no valid machine result: exit null" — a red for a run in which
 * nobody observed a failure. The rule this file already states for the stack
 * path is not a rule about stack commands: reporting a verdict for a killed
 * process is a lie whichever way it points, because `passed` certifies
 * untested source and `failed` invents a red. The honest third value is "we
 * could not tell", and it must name the signal, because "we could not tell"
 * with no cause is not actionable.
 *
 * `abandoned` is the fourth and the only one that arrives WITH an exit code:
 * the adapter itself finished, but a simulator, a Gradle daemon or a Metro
 * server it started outlived it holding the inherited stdout, so the run hit
 * its bound with nothing left to wait for. That code is not a verdict — the
 * output behind it is truncated at whatever the pipe had delivered, no machine
 * result was parsed, and the survivor is about to answer the NEXT run's checks.
 * It cannot become a false green (`passed` below requires `kind ===
 * 'completed'`); what it becomes WITHOUT this arm is the invented red the
 * overflow case was carved out of, "failed or produced no valid machine
 * result" for a run in which nobody observed a failure.
 *
 * `start-failed` is the fifth and the only one where the adapter never ran a
 * single instruction: an EMFILE, ENFILE or EAGAIN at the spawn. It reads like
 * the `unavailable` arm below and is its opposite — an absent simulator is an
 * environment this machine does not have, while a refused descriptor is one
 * this RUNNER ran out of, and the second is transient, so a report that calls
 * it "Native environment unavailable" sends a reader to repair a toolchain that
 * was never broken. Both are `blocked-environment`; only this one carries the
 * inconclusive marker and the cause.
 *
 * All five stay REJECTABLE — `blocked-environment` is this repo's existing
 * "neither a code failure nor verification" value, and senior-tester/agent.md
 * already binds it to a `TESTS_FAILING` verdict.
 *
 * A SWITCH over `BOUNDED_PROCESS_KINDS`, for two reasons. It makes a missing
 * arm a COMPILE ERROR — the union grew a member with no error and no test
 * failure while this was an `if`-chain, and the arm a new kind fell through to
 * is the one that lets `passed` be reached — and it dissolves the ordering
 * hazard the chain had to be careful about. Both bounds are enforced WITH a
 * SIGKILL (the reason exec.ts:74 records), so a timeout and an overflow also
 * carry a signal, and an `if (result.signal)` tested first would have reported
 * every bound as an anonymous kill and lost the fact that explains it. One arm
 * per kind cannot be mis-ordered.
 *
 * An adapter that exits with a code — 65 from a failing xcodebuild, 1 from
 * Gradle — carries no signal and no forced kind, so it is not cut short and
 * keeps its ordinary `failed` verdict. That arm is the whole point of the
 * classification and must not move.
 *
 * Exported so the enumeration test can walk every member of the union against
 * it rather than sampling the four this file happens to describe.
 */
export function nativeRunCutShort(result: BoundedProcessResult): string | null {
  switch (result.kind) {
    case 'timeout':
      return 'was still running at its bound and was killed';
    case 'output-limit':
      return 'was killed after passing its captured-output bound';
    case 'abandoned':
      return `exited ${result.exitCode === null ? 'without a code' : String(result.exitCode)} but something it `
        + 'started outlived it holding its output open past the bound, so the run was abandoned '
        + 'and its process group killed';
    case 'start-failed':
      return 'could not be started by this runner at all — the operating system refused the spawn a '
        + 'descriptor or a process slot, so the adapter exists, never ran, and measured nothing';
    case 'completed':
      return result.signal ? `was killed by ${result.signal} before it could report` : null;
    // Never started, so nothing was cut short: the honest environment gap, and
    // the one arm here that must stay green.
    case 'unavailable':
      return null;
    default:
      return unclassifiedProcessKind(result.kind);
  }
}

/**
 * How a bounded run ended, for the TAIL of a message whose opening clause has
 * already said what that means.
 *
 * `kind` alone cannot answer it: a signal death is `kind: 'completed'`, so the
 * fallback appended the word "completed" to a sentence explaining that the
 * adapter had been killed before it could report. A forced kind still wins,
 * because a timeout and an overflow are enforced WITH a SIGKILL and their own
 * name is the more specific fact.
 */
function processOutcome(result: BoundedProcessResult): string {
  if (result.kind !== 'completed') return result.kind;
  return result.signal ? `killed by ${result.signal}` : result.kind;
}

function nativeEnvironmentMissing(adapter: string, result: BoundedProcessResult, detail: string): boolean {
  if (result.kind === 'unavailable') return true;
  const output = `${result.stdout}\n${result.stderr}\n${detail}`;
  return adapter === 'xcode-simulator'
    ? /unable to find a destination|no devices are booted|simulator.{0,40}(?:unavailable|not available)|requires Xcode|xcrun.{0,40}(?:not found|unable)|SDK.{0,40}(?:cannot be located|not found)/i.test(output)
    : /no connected devices|no devices found|device.{0,40}offline|SDK location not found|adb.{0,40}not found|ANDROID_HOME|emulator.{0,40}(?:not found|unavailable)/i.test(output);
}

function boundedNativeSummary(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || 'Native adapter failed without a machine-readable diagnostic.').slice(0, 500);
}

async function publishNativeResult(
  args: RunnerArgs,
  loaded: LoadedNativeRun,
  out: { absolute: string; relative: string },
  startedAt: string,
  status: 'passed' | 'failed' | 'blocked-environment',
  blockerSummary: string | undefined,
  commandHash: string | undefined,
  machine: NativeMachineResult | null,
): Promise<number> {
  const evidence = createQaNativeEvidence({
    runnerVersion: pluginVersion(),
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    sourceHash: loaded.sourceHash,
    adapter: loaded.contract.nativeAdapter!,
    startedAt,
    generatedAt: new Date().toISOString(),
    status,
    ...(commandHash ? { commandHash } : {}),
    ...(machine ? {
      parser: machine.parser,
      summary: machine.summary,
      artifacts: machine.artifacts,
    } : {}),
    ...(blockerSummary ? { blockerSummary } : {}),
  });
  writeJson(out.absolute, evidence);
  const checks = await withExecutedStackChecks(
    args,
    nativeCheckStatuses(loaded.contract.requiredChecks, status, blockerSummary),
  );
  const report: QaReportV2 = {
    schemaVersion: 2,
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    generatedAt: new Date().toISOString(),
    producer: 'parent-runner',
    status,
    sourceHash: loaded.sourceHash,
    checks,
    routes: [],
    native: { evidencePath: out.relative },
    ...(blockerSummary ? { blockerSummary } : {}),
    // The native path publishes its own report rather than going through
    // run-context's publishers, so it carries the loader's scan disclosure
    // itself. See `loadedSourceIdentity`: the validator refuses a run that
    // proceeded on a qualified scan and reports clean, whichever command
    // produced it.
    ...(loaded.scanQualification ? { settledWithIncompleteScan: loaded.scanQualification } : {}),
  };
  // A refused sidecar write is a failed run, not a passed one: validateQaReportV2
  // below judges the in-memory object and would certify a report no gate can read.
  if (!publishQaReportV2(args.projectRoot, args.runId, report)) {
    process.stderr.write(`qa-evidence: could not persist ${qaReportV2Path(args.projectRoot, args.runId)} — the write was refused.\n`);
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status,
      nativeEvidencePath: out.relative,
      reportPath: qaReportV2Path(args.projectRoot, args.runId),
      validation: { ok: false, code: 'report-missing', message: 'the QA report sidecar could not be written' },
      ...(blockerSummary ? { blockerSummary } : {}),
    })}\n`);
    return 1;
  }
  const validation = validateQaReportV2(report, args.projectRoot, args.runId, loaded.contract);
  process.stdout.write(`${JSON.stringify({
    ok: validation.ok,
    status,
    nativeEvidencePath: out.relative,
    reportPath: qaReportV2Path(args.projectRoot, args.runId),
    validation: validation.ok
      ? { ok: true }
      : { ok: false, code: validation.code, message: validation.message },
    ...(blockerSummary ? { blockerSummary } : {}),
  })}\n`);
  if (status === 'blocked-environment') return 2;
  return validation.ok ? 0 : 1;
}

export async function nativeCommand(
  args: RunnerArgs,
  loaded: LoadedNativeRun,
): Promise<number> {
  const out = outputPath(args, 'native-evidence-v1.json');
  if (!out) {
    process.stderr.write('qa-evidence: native evidence output path is unsafe.\n');
    return 2;
  }
  const startedAt = new Date().toISOString();
  const configured = configuredNativeCommand(args, loaded.contract.nativeAdapter!);
  if (!configured) {
    const blockerSummary =
      `Native adapter ${loaded.contract.nativeAdapter} requires a supported shell-free `
      + '--native-command-json configuration; arbitrary commands and tester-authored artifacts are rejected.';
    return publishNativeResult(
      args,
      loaded,
      out,
      startedAt,
      'blocked-environment',
      blockerSummary,
      undefined,
      null,
    );
  }
  const qaRoot = qaDir(args.projectRoot, args.runId);
  const captureRelative = `native/capture-${Date.now()}-${process.pid}`;
  const captureRoot = ensureProjectDirectory(
    args.projectRoot,
    path.relative(args.projectRoot, path.join(qaRoot, captureRelative)).replace(/\\/g, '/'),
  );
  if (!captureRoot) {
    process.stderr.write('qa-evidence: native capture directory is unsafe.\n');
    return 2;
  }
  const commandHash = sha256(stableContractJson({
    adapter: loaded.contract.nativeAdapter,
    cwd: path.relative(args.projectRoot, configured.cwd).replace(/\\/g, '/') || '.',
    argv: configured.command,
  }));
  const result = loaded.contract.nativeAdapter === 'xcode-simulator'
    ? await runXcodeNative(
        args,
        configured.command,
        configured.cwd,
        qaRoot,
        captureRoot,
        Date.parse(startedAt),
      )
    : await runAndroidNative(
        args,
        configured.command,
        configured.cwd,
        qaRoot,
        captureRoot,
        Date.parse(startedAt),
      );
  const cutShort = nativeRunCutShort(result.process);
  const environmentBlocked = nativeEnvironmentMissing(
    loaded.contract.nativeAdapter!,
    result.process,
    result.detail,
  );
  const passed = result.process.kind === 'completed'
    && result.process.exitCode === 0
    && result.machine
    && result.machine.summary.failed === 0
    && result.machine.summary.passed > 0;
  const status = passed
    ? 'passed'
    : cutShort || environmentBlocked ? 'blocked-environment' : 'failed';
  const summary = passed
    ? undefined
    : cutShort
      ? `${CHECK_INCONCLUSIVE_PREFIX} the ${loaded.contract.nativeAdapter} ${result.stage} ${cutShort} after `
        + `${Date.now() - Date.parse(startedAt)} ms of a ${result.boundMs} ms bound, so no machine-readable `
        + 'result was produced and neither a pass nor a failure was observed: '
        + `${result.detail || result.process.stderr || processOutcome(result.process)}`
      : environmentBlocked
        ? `Native environment unavailable for ${loaded.contract.nativeAdapter}: ${result.detail || result.process.stderr || processOutcome(result.process)}`
        : `Native adapter ${loaded.contract.nativeAdapter} failed or produced no valid machine result: ${result.detail || result.process.stderr || `exit ${String(result.process.exitCode)}`}`;
  return publishNativeResult(
    args,
    loaded,
    out,
    startedAt,
    status,
    summary ? boundedNativeSummary(summary) : undefined,
    commandHash,
    result.machine,
  );
}
