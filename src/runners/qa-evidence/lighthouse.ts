// src/runners/qa-evidence/lighthouse.ts
// Project-local Lighthouse execution against the owned server plus the
// lighthouse CLI subcommand.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { writeJson } from '../../shared/fsjson';
import {
  createQaLighthouseEvidence,
  readLighthouseArtifact,
} from '../../shared/qa-evidence-runtime';
import {
  CHECK_INCONCLUSIVE_PREFIX,
  qaReportV2Path,
  readQaReportV2,
  validateQaReportV2,
  type QaReportV2,
} from '../../shared/qa-report-v2';
import {
  parentRunnerReportMismatch,
  resolveLighthouseArtifact,
  stackLighthouseBuildIdentity,
  stackLighthouseReportUpdate,
  writeConvertedLighthouseEvidence,
} from './lighthouse-artifact';

import {
  spawnPlan,
  spawnRefusalKind,
  unclassifiedProcessKind,
  type BoundedProcessKind,
} from './native-process';
import {
  GROUP_KILLS_AVAILABLE,
  killProcessGroup,
  reapOnInterrupt,
  spawnedGroupId,
} from './process-group';
import {
  type OwnedServer,
  type RunnerArgs,
} from './types';
import {
  type LoadedRun,
  type LoadedStackRun,
  outputPath,
  publishQaReportV2,
} from './run-context';
import { isConcreteRoutePath, loadScenario } from './scenario';

// A Lighthouse audit does not finish inside the per-step default, so this step
// takes at least this much regardless of --timeout-ms. It stays BELOW the
// flag's ceiling so a narrowing step can never widen the bound; the pin lives
// in __tests__/inconclusive-evidence.test.ts.
export const LIGHTHOUSE_MIN_TIMEOUT_MS = 120_000;

interface LighthouseRunResult {
  status: 'passed' | 'failed' | 'blocked-environment';
  evidencePath?: string;
  blockerSummary?: string;
}

function projectLighthouseBin(args: RunnerArgs): string | null {
  const binName = process.platform === 'win32' ? 'lighthouse.cmd' : 'lighthouse';
  const roots = [
    args.projectRoot,
    ...(args.serverCwd ? [path.resolve(args.projectRoot, args.serverCwd)] : []),
  ];
  for (const root of roots) {
    const candidate = path.join(root, 'node_modules', '.bin', binName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next project-local location
    }
  }
  return null;
}

/**
 * The Lighthouse CLI, bounded — and it owns a CHROME, so its leftover is the
 * heaviest one this runner can produce.
 *
 * Same defect as the other two spawn sites, same fix: the CLI is a Node wrapper
 * that launches a browser, so `child.kill` reaches the wrapper and leaves the
 * browser (and its renderer and GPU children) running, holding its remote
 * debugging port and a profile directory. The kill addresses the group, the
 * group id is snapshotted at spawn, and the whole tree is registered for reaping
 * on interrupt — an audit is the longest single step in this runner, which makes
 * it the step most likely to be the one a Ctrl-C lands in.
 *
 * A FOURTH independent bounded-spawn implementation, which is the real finding
 * and is not fixed here: it repeats what `runBoundedProcess` already does and
 * carries none of what that has learned (no output-limit kill, no grace timer,
 * so a Chrome holding the inherited stdout suppresses `close` — this rejects on
 * `exit`, which is why it does not hang, and which also means it can resolve
 * while output is still in flight). Folding it onto `runBoundedProcess` was
 * re-examined and rejected again; what the fold would have bought is carried
 * across instead, as the `outcome` below.
 *
 * EVERY REJECTION NAMES A KIND, and that is the half the caller could not do
 * without. Its catch matched a Chrome-missing pattern in the message and called
 * everything else `failed`, so an audit killed at its own bound and a Chrome
 * killed by the OOM killer were both reported as a performance FAILURE — a red
 * for a run in which nobody observed one, which is this lane's own rule with
 * the sign flipped. The message is a poor channel for that question (it is
 * prose, and the interesting cases are the ones nobody wrote a pattern for);
 * the kind is the channel `runBoundedProcess` already uses, and reusing its
 * union means a new ending has to be decided here too.
 */
export interface BoundedCommandOutcome {
  kind: BoundedProcessKind;
  /** The signal that killed it, when the kernel named one. */
  signal: NodeJS.Signals | null;
}

/** The rejection shape every failure path of `runBoundedCommand` carries. */
type BoundedCommandRejection = Error & { outcome: BoundedCommandOutcome };

function rejection(message: string, outcome: BoundedCommandOutcome): BoundedCommandRejection {
  return Object.assign(new Error(message), { outcome });
}

/** The `outcome` an error carries, if it came from `runBoundedCommand` at all. */
export function boundedCommandOutcome(error: unknown): BoundedCommandOutcome | null {
  const candidate = (error as { outcome?: BoundedCommandOutcome } | null)?.outcome;
  return candidate && typeof candidate.kind === 'string' ? candidate : null;
}

/**
 * Why this audit produced NO MEASUREMENT — the audit lane's half of
 * `cutShortCause` and `nativeRunCutShort`, and a switch over the same union so
 * a new ending cannot default to a verdict here either.
 *
 * The line is different from the stack path's and deliberately so: there, a
 * command whose binary is absent is an honest exemption; here, an audit that
 * never started measured no performance budget, and the caller already reports
 * an absent Lighthouse as `blocked-environment` one function up. So EVERY
 * ending except a real exit code is "we could not tell", and the only route to
 * `failed` left is a Lighthouse that ran, reported, and exited non-zero.
 */
export function auditNotMeasured(outcome: BoundedCommandOutcome): string | null {
  switch (outcome.kind) {
    case 'timeout':
      return 'the audit was still running at its bound and was killed';
    case 'output-limit':
      return 'the audit was killed after passing its captured-output bound';
    case 'abandoned':
      return 'the audit exited but something it started outlived it past the bound';
    case 'start-failed':
      return 'this runner could not start the audit at all';
    case 'unavailable':
      return 'the Lighthouse binary could not be executed';
    case 'completed':
      return outcome.signal
        ? `the audit was killed by ${outcome.signal} before it could report`
        : null;
    default:
      return unclassifiedProcessKind(outcome.kind);
  }
}
export function runBoundedCommand(
  command: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  /**
   * The platform this spawn is planned for, a parameter for the same reason
   * `spawnPlan`'s is: the Windows branch is unreachable from every machine that
   * runs these tests, and it fails as "the audit could not start" rather than
   * as anything a reader would recognise.
   */
  platform: NodeJS.Platform = process.platform,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const detached = GROUP_KILLS_AVAILABLE;
    // `projectLighthouseBin` picks `lighthouse.cmd` on Windows, and node
    // REFUSES that target: src/process_wrap.cc answers UV_EINVAL for a `.cmd`
    // or `.bat` file before libuv is reached, and `shell: true` escapes it only
    // because the JS layer then makes cmd.exe the spawned FILE. So the audit
    // could not start at all there — an EINVAL the catch below reads as
    // `failed`, on the one platform whose binary name was chosen deliberately.
    // The plan is the native path's, from the same helper rather than a second
    // copy of it; on POSIX it is the `(command, argv)` pair this spawned before.
    const plan = spawnPlan([command, ...argv], platform);
    const child = spawn(plan.file, plan.args, {
      cwd,
      env: { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    const pgid = spawnedGroupId(child, detached);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const stopReaping = reapOnInterrupt(() => { killProcessGroup(pgid, child); });
    const append = (current: string, chunk: Buffer): string => (
      `${current}${chunk.toString('utf8')}`.slice(-1024 * 1024)
    );
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessGroup(pgid, child);
      stopReaping();
      rejectPromise(rejection(
        `Lighthouse timed out after ${timeoutMs}ms`,
        { kind: 'timeout', signal: null },
      ));
    }, timeoutMs);
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup(pgid, child);
      stopReaping();
      // The error object itself travels, so its `message` and its errno still
      // reach a reader unchanged; only the classification rides along.
      rejectPromise(Object.assign(error, {
        outcome: { kind: spawnRefusalKind(error.code), signal: null },
      }));
    });
    // The group is swept on the way out of EVERY path, this one included. A
    // Lighthouse that exits 0 having left a Chrome behind is the browser lane's
    // form of the survivor incident: nothing is late, nothing looks wrong, and
    // the leftover holds a port the next run may be handed.
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup(pgid, child);
      stopReaping();
      if (code === 0) resolvePromise({ stdout, stderr });
      // `exit` reports one of the two: a code, or the signal that killed it.
      // The signal case is the OOM-killed Chrome, and it is the one this used
      // to fold into the same sentence as a non-zero exit and report as a
      // failed performance budget.
      else rejectPromise(rejection(
        `Lighthouse exited ${code ?? signal ?? 'without status'}: ${stderr || stdout}`,
        { kind: 'completed', signal: signal ?? null },
      ));
    });
  });
}

/**
 * The concrete URL path Lighthouse should measure.
 *
 * `contract.changedRoutes` holds route IDENTITIES — `*` and `/courses/:slug`
 * among them — and taking `[0]` verbatim resolved `*` to the literal path `/*`,
 * which is the SPA fallback. The scenario already carries a concrete `startPath`
 * per route for exactly this reason, so prefer it; `/` wins when present because
 * it is the page a performance budget is actually about.
 */
export function lighthouseProbePath(
  args: RunnerArgs,
  loaded: { contract: LoadedRun['contract'] },
): string {
  const candidates: string[] = [];
  const scenario = loadScenario(args, loaded.contract);
  for (const route of scenario?.routes || []) {
    if (isConcreteRoutePath(route.startPath)) candidates.push(route.startPath);
  }
  for (const route of loaded.contract.changedRoutes) {
    if (isConcreteRoutePath(route)) candidates.push(route);
  }
  return candidates.find((candidate) => candidate === '/') || candidates[0] || '/';
}

/**
 * Origin / time-window / probe-path. The live audit and `--artifact`
 * conversion share this so a swapped raw JSON cannot pass conversion after
 * an honest browser run.
 *
 * `new URL` throws on an unparseable `finalUrl` or `owned.url` — the live
 * path's outer catch already treats that as a failed audit.
 */
export function ownedListenerArtifactFailure(
  summary: { finalUrl: string; generatedAt: string },
  owned: Pick<OwnedServer, 'url' | 'startedAt'>,
  probe: string,
): string | null {
  const finalUrl = new URL(summary.finalUrl);
  if (finalUrl.origin !== new URL(owned.url).origin
    || Date.parse(summary.generatedAt) < Date.parse(owned.startedAt)
    || Date.parse(summary.generatedAt) > Date.now() + 1_000) {
    return 'Lighthouse artifact does not belong to the runner-owned live build listener.';
  }
  if (finalUrl.pathname !== probe) {
    return `Lighthouse measured ${finalUrl.pathname} instead of the intended ${probe}; `
      + 'the target must be a concrete route, never a catch-all.';
  }
  return null;
}

export async function runLighthouseOnOwnedServer(
  args: RunnerArgs,
  loaded: LoadedRun,
  owned: OwnedServer,
): Promise<LighthouseRunResult> {
  const binary = projectLighthouseBin(args);
  if (!binary) {
    return {
      status: 'blocked-environment',
      blockerSummary:
        'Project-local Lighthouse is unavailable. Install lighthouse as a devDependency for this performance-required run.',
    };
  }
  const rawOut = outputPath({ ...args, out: 'lighthouse.raw.json' }, 'lighthouse.raw.json');
  const evidenceOut = outputPath(
    { ...args, out: 'lighthouse-evidence-v1.json' },
    'lighthouse-evidence-v1.json',
  );
  if (!rawOut || !evidenceOut) {
    return { status: 'failed', blockerSummary: 'Lighthouse output paths are unsafe.' };
  }
  try {
    if (fs.existsSync(rawOut.absolute)) {
      if (fs.lstatSync(rawOut.absolute).isSymbolicLink()) {
        return { status: 'failed', blockerSummary: 'Lighthouse raw output path is a symlink.' };
      }
      fs.unlinkSync(rawOut.absolute);
    }
    const probe = lighthouseProbePath(args, loaded);
    const target = new URL(probe.replace(/^\//, ''), `${owned.url}/`).href;
    await runBoundedCommand(binary, [
      target,
      '--only-categories=performance,accessibility,best-practices,seo',
      '--chrome-flags=--headless --no-sandbox',
      '--output=json',
      `--output-path=${rawOut.absolute}`,
      '--quiet',
    ], args.projectRoot, Math.max(args.timeoutMs, LIGHTHOUSE_MIN_TIMEOUT_MS));
    const summary = readLighthouseArtifact(rawOut.absolute);
    if (!summary) {
      return {
        status: 'failed',
        blockerSummary: 'Project-local Lighthouse did not write a complete four-category JSON artifact.',
      };
    }
    // Origin alone let a 404 pass. The catch-all route resolved to the literal
    // path `/*`, which every SPA serves as its not-found page, so the single
    // canonical performance and SEO measurement described a page no user visits
    // (observed 9co: perf 88 / SEO 66 on `/*` while the real home scored 98/100).
    const listenerFailure = ownedListenerArtifactFailure(summary, owned, probe);
    if (listenerFailure) {
      return { status: 'failed', blockerSummary: listenerFailure };
    }
    const evidence = createQaLighthouseEvidence({
      runId: args.runId,
      verificationContractHash: loaded.contract.contractHash,
      sourceHash: loaded.sourceHash,
      buildHash: loaded.manifest.manifestHash,
      buildFingerprint: loaded.fingerprint,
      generatedAt: summary.generatedAt,
      artifactPath: rawOut.relative,
      artifactHash: summary.artifactHash,
      finalUrl: summary.finalUrl,
      performance: summary.performance,
      accessibility: summary.accessibility,
      bestPractices: summary.bestPractices,
      seo: summary.seo,
      lcpMs: summary.lcpMs,
      cls: summary.cls,
      ...(summary.inpMs === undefined ? {} : { inpMs: summary.inpMs }),
      ...(summary.fcpMs === undefined ? {} : { fcpMs: summary.fcpMs }),
      ...(summary.tbtMs === undefined ? {} : { tbtMs: summary.tbtMs }),
    });
    writeJson(evidenceOut.absolute, evidence);
    return { status: 'passed', evidencePath: evidenceOut.relative };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    // Two independent reasons this is not a product failure, and the first one
    // is new. `notMeasured` is the audit's own ending, decided from the kind
    // rather than from prose: a bound that fired, a Chrome the OOM killer took,
    // a spawn the runner was refused. None of those observed a slow page, and
    // reporting `failed` for them tells a developer their performance budget is
    // red when their browser was killed. The pattern stays for the case the
    // kind cannot see — a Lighthouse that RAN, exited non-zero, and said in its
    // own output that it could not launch a browser — and for the errors thrown
    // by the artifact checks above, which carry no outcome at all.
    const outcome = boundedCommandOutcome(error);
    const notMeasured = outcome ? auditNotMeasured(outcome) : null;
    return {
      status: notMeasured
        || /chrome.*(?:not found|missing|launch|executable)|enoent|permission/i.test(message)
        ? 'blocked-environment'
        : 'failed',
      blockerSummary: notMeasured ? `${CHECK_INCONCLUSIVE_PREFIX} ${notMeasured}: ${message}` : message,
    };
  }
}

function isLoadedRun(loaded: LoadedRun | LoadedStackRun): loaded is LoadedRun {
  return 'manifest' in loaded && 'fingerprint' in loaded;
}

function browserConversionIdentityFailure(
  report: QaReportV2,
  loaded: LoadedRun,
): boolean {
  return report.build?.outputRoot !== loaded.manifest.outputRoot
    || report.build.buildHash !== loaded.manifest.manifestHash
    || report.build.fingerprint !== loaded.fingerprint
    || !report.build?.url
    || !report.build?.startedAt
    || (loaded.contract.browserRequired && !report.machineEvidencePath);
}

export function lighthouseCommand(
  args: RunnerArgs,
  loaded: LoadedRun | LoadedStackRun,
): number {
  const resolved = resolveLighthouseArtifact(args);
  if (!resolved.ok) {
    process.stderr.write(`qa-evidence: ${resolved.message}\n`);
    return resolved.code;
  }
  const { summary } = resolved;
  // Conversion has no live OwnedServer. A browser report already recorded the
  // listener identity (`build.url`, `build.startedAt`); without that identity
  // there is nothing to check against, so THAT path fails closed. A stack
  // report never starts a listener — skip those checks only when there is no
  // `build.url`. A report that HAS `build.url` always takes the L130 path.
  const existing = readQaReportV2(args.projectRoot, args.runId);
  const report = existing.report;
  const ownedUrl = report?.build?.url;
  const ownedStartedAt = report?.build?.startedAt;
  const stackOnly = !loaded.contract.browserRequired
    && loaded.contract.uiImpact !== 'native-ui'
    && !ownedUrl;
  if (parentRunnerReportMismatch(report, loaded, args.runId) || !report) {
    process.stderr.write(
      stackOnly
        ? 'qa-evidence: Lighthouse conversion requires the matching report-v2 produced by the stack runner.\n'
        : 'qa-evidence: Lighthouse conversion requires the matching report-v2 produced by the browser runner.\n',
    );
    return 1;
  }
  if (ownedUrl) {
    if (isLoadedRun(loaded) && browserConversionIdentityFailure(report, loaded)) {
      process.stderr.write(
        'qa-evidence: Lighthouse conversion requires the matching report-v2 produced by the browser runner.\n',
      );
      return 1;
    }
    if (!ownedStartedAt) {
      process.stderr.write(
        'qa-evidence: Lighthouse conversion requires the matching report-v2 produced by the browser runner.\n',
      );
      return 1;
    }
    let listenerFailure: string | null;
    try {
      listenerFailure = ownedListenerArtifactFailure(
        summary,
        { url: ownedUrl, startedAt: ownedStartedAt },
        lighthouseProbePath(args, loaded),
      );
    } catch {
      listenerFailure = 'Lighthouse artifact does not belong to the runner-owned live build listener.';
    }
    if (listenerFailure) {
      process.stderr.write(`qa-evidence: ${listenerFailure}\n`);
      return 1;
    }
  } else if (!stackOnly) {
    process.stderr.write(
      'qa-evidence: Lighthouse conversion requires the matching report-v2 produced by the browser runner.\n',
    );
    return 1;
  }
  const buildFields = isLoadedRun(loaded) && ownedUrl
    ? { buildHash: loaded.manifest.manifestHash, buildFingerprint: loaded.fingerprint }
    : stackLighthouseBuildIdentity(args.runId, loaded.sourceHash);
  const evidencePath = writeConvertedLighthouseEvidence(resolved, {
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    sourceHash: loaded.sourceHash,
    ...buildFields,
  });
  if (!evidencePath) {
    process.stderr.write('qa-evidence: could not persist converted Lighthouse evidence — the write was refused.\n');
    return 1;
  }
  const updated: QaReportV2 = stackOnly
    ? stackLighthouseReportUpdate(report, evidencePath, summary.generatedAt)
    : {
      ...report,
      generatedAt: new Date(Math.max(Date.now(), Date.parse(summary.generatedAt))).toISOString(),
      lighthouse: { evidencePath },
    };
  // A refused re-publish leaves the PREVIOUS report on disk, still without the
  // `lighthouse` section — so certifying `updated` here would report a performance
  // budget as measured against a sidecar that never records it.
  if (!publishQaReportV2(args.projectRoot, args.runId, updated)) {
    process.stderr.write(`qa-evidence: could not persist ${qaReportV2Path(args.projectRoot, args.runId)} — the write was refused.\n`);
    process.stdout.write(`${JSON.stringify({
      ok: false,
      lighthouse: { evidencePath },
      reportPath: qaReportV2Path(args.projectRoot, args.runId),
      validation: { ok: false, code: 'report-missing', message: 'the Lighthouse-updated QA report could not be written' },
    })}\n`);
    return 1;
  }
  const validation = validateQaReportV2(
    updated,
    args.projectRoot,
    args.runId,
    loaded.contract,
  );
  process.stdout.write(`${JSON.stringify({
    ok: validation.ok,
    lighthouse: { evidencePath },
    reportPath: qaReportV2Path(args.projectRoot, args.runId),
    validation: validation.ok
      ? { ok: true, advisories: validation.advisories }
      : { ok: false, code: validation.code, message: validation.message },
  })}\n`);
  return validation.ok ? 0 : 1;
}
