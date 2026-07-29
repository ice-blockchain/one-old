// src/runners/qa-evidence/lighthouse.ts
// Project-local Lighthouse execution against the owned server plus the
// lighthouse CLI subcommand.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { writeJson } from '../../shared/fsjson';
import {
  combineNativeSummaries,
  computeBuildOutputManifest,
  contentHash,
  createQaLighthouseEvidence,
  createQaMachineEvidence,
  createQaNativeEvidence,
  parseAndroidJUnitXml,
  parseXcodeResultSummary,
  readLighthouseArtifact,
  type BuildOutputManifestV1,
  type QaMachineRouteEvidenceV1,
  type QaMachineViewportEvidenceV1,
  type QaNativeArtifactV1,
  type QaNativeTestSummaryV1,
} from '../../shared/qa-evidence-runtime';
import {
  expectedBuildFingerprint,
  QA_BUILD_IDENTITY_PROBE_PATH,
  qaReportV2Path,
  readQaReportV2,
  validateQaReportV2,
  type QaReportV2,
} from '../../shared/qa-report-v2';

import {
  type OwnedServer,
  type RunnerArgs,
} from './types';
import {
  loadRun,
  outputPath,
  qaDir,
  safeProjectRelative,
  strictRelative,
} from './run-context';

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

function runBoundedCommand(
  command: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, argv, {
      cwd,
      env: { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const append = (current: string, chunk: Buffer): string => (
      `${current}${chunk.toString('utf8')}`.slice(-1024 * 1024)
    );
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectPromise(new Error(`Lighthouse timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(
        `Lighthouse exited ${code ?? signal ?? 'without status'}: ${stderr || stdout}`,
      ));
    });
  });
}

export async function runLighthouseOnOwnedServer(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
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
    const route = loaded.contract.changedRoutes[0] || '/';
    const target = new URL(route, `${owned.url}/`).href;
    await runBoundedCommand(binary, [
      target,
      '--only-categories=performance,accessibility,best-practices,seo',
      '--chrome-flags=--headless --no-sandbox',
      '--output=json',
      `--output-path=${rawOut.absolute}`,
      '--quiet',
    ], args.projectRoot, Math.max(args.timeoutMs, 120_000));
    const summary = readLighthouseArtifact(rawOut.absolute);
    if (!summary) {
      return {
        status: 'failed',
        blockerSummary: 'Project-local Lighthouse did not write a complete four-category JSON artifact.',
      };
    }
    const finalUrl = new URL(summary.finalUrl);
    if (finalUrl.origin !== new URL(owned.url).origin
      || Date.parse(summary.generatedAt) < Date.parse(owned.startedAt)
      || Date.parse(summary.generatedAt) > Date.now() + 1_000) {
      return {
        status: 'failed',
        blockerSummary: 'Lighthouse artifact does not belong to the runner-owned live build listener.',
      };
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
    });
    writeJson(evidenceOut.absolute, evidence);
    return { status: 'passed', evidencePath: evidenceOut.relative };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    return {
      status: /chrome.*(?:not found|missing|launch|executable)|enoent|permission/i.test(message)
        ? 'blocked-environment'
        : 'failed',
      blockerSummary: message,
    };
  }
}

export function lighthouseCommand(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
): number {
  if (!args.artifact) {
    process.stderr.write('qa-evidence: --artifact is required for Lighthouse conversion.\n');
    return 2;
  }
  const rel = safeProjectRelative(args.projectRoot, args.artifact);
  const out = outputPath(args, 'lighthouse-evidence-v1.json');
  if (!rel || !out) {
    process.stderr.write('qa-evidence: Lighthouse artifact/output path is unsafe.\n');
    return 2;
  }
  const artifactAbsolute = path.join(args.projectRoot, rel);
  const qaRoot = qaDir(args.projectRoot, args.runId);
  const artifactRel = path.relative(qaRoot, artifactAbsolute).replace(/\\/g, '/');
  const safeArtifactRel = strictRelative(artifactRel);
  let realArtifact = '';
  try {
    const realQa = fs.realpathSync(qaRoot);
    realArtifact = fs.realpathSync(artifactAbsolute);
    const boundary = path.relative(realQa, realArtifact);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) throw new Error('outside QA root');
  } catch {
    // handled by the common unsafe-artifact response below
  }
  if (!safeArtifactRel || !realArtifact) {
    process.stderr.write('qa-evidence: raw Lighthouse JSON must be inside this run QA directory.\n');
    return 2;
  }
  const summary = readLighthouseArtifact(realArtifact);
  if (!summary) {
    process.stderr.write('qa-evidence: raw Lighthouse JSON is incomplete or lacks the four standard categories.\n');
    return 1;
  }
  if (Date.parse(summary.generatedAt) > Date.now() + 1_000) {
    process.stderr.write('qa-evidence: raw Lighthouse JSON has a future fetchTime.\n');
    return 1;
  }
  const evidence = createQaLighthouseEvidence({
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    sourceHash: loaded.sourceHash,
    buildHash: loaded.manifest.manifestHash,
    buildFingerprint: loaded.fingerprint,
    generatedAt: summary.generatedAt,
    artifactPath: safeArtifactRel,
    artifactHash: summary.artifactHash,
    finalUrl: summary.finalUrl,
    performance: summary.performance,
    accessibility: summary.accessibility,
    bestPractices: summary.bestPractices,
    seo: summary.seo,
    lcpMs: summary.lcpMs,
    cls: summary.cls,
    ...(summary.inpMs === undefined ? {} : { inpMs: summary.inpMs }),
  });
  writeJson(out.absolute, evidence);
  const existing = readQaReportV2(args.projectRoot, args.runId);
  const report = existing.report;
  if (!report
    || report.producer !== 'parent-runner'
    || report.runId !== args.runId
    || report.verificationContractHash !== loaded.contract.contractHash
    || report.sourceHash !== loaded.sourceHash
    || report.build?.outputRoot !== loaded.manifest.outputRoot
    || report.build.buildHash !== loaded.manifest.manifestHash
    || report.build.fingerprint !== loaded.fingerprint
    || (loaded.contract.browserRequired && !report.machineEvidencePath)) {
    process.stderr.write(
      'qa-evidence: Lighthouse conversion requires the matching report-v2 produced by the browser runner.\n',
    );
    return 1;
  }
  const updated: QaReportV2 = {
    ...report,
    generatedAt: new Date(Math.max(Date.now(), Date.parse(summary.generatedAt))).toISOString(),
    lighthouse: { evidencePath: out.relative },
  };
  writeJson(qaReportV2Path(args.projectRoot, args.runId), updated);
  const validation = validateQaReportV2(
    updated,
    args.projectRoot,
    args.runId,
    loaded.contract,
  );
  process.stdout.write(`${JSON.stringify({
    ok: validation.ok,
    lighthouse: { evidencePath: out.relative },
    reportPath: qaReportV2Path(args.projectRoot, args.runId),
    validation: validation.ok
      ? { ok: true, advisories: validation.advisories }
      : { ok: false, code: validation.code, message: validation.message },
  })}\n`);
  return validation.ok ? 0 : 1;
}
