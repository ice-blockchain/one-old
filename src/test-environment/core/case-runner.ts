// src/test-environment/core/case-runner.ts
// Runs ONE case for ONE target (a host id, or 'pure-node'): isolated temp project
// → seed/onboard → optional host run → assertions → artifact capture → cleanup.

import * as fs from 'fs';
import * as path from 'path';

import { isInsidePluginAuthoringRoot } from '../../shared/authoring-root';
import { writeState } from '../../shared/state/normalize';
import { modelForRoleHost } from '../../shared/performance';
import type {
  Assertion, AssertionContext, AssertionResult, AssertionSpec, Case, CaseRunResult,
  HostId, HostRunResult, RootTestConfig,
} from './types';
import { buildCaseEnv, withCaseEnv, type CaseEnv } from './env';
import {
  RUNTIME_PROOF_ENTRY_ENV,
  RUNTIME_PROOF_FILE_ENV,
  RUNTIME_PROOF_TOKEN_ENV,
} from './current-dist';
import { materializeFixture } from './fixtures';
import { preseed } from './preseed';
import { driveOnboarding } from './onboarding-sim';
import { prepareCaseHostIntegration } from './host-integration';
import { DRIVERS } from '../drivers';
import { currentHostCapabilityReport } from '../host-capability-report';
import { seedCodexE2eModelCatalog } from './codex-e2e-models';

function copyIfExists(from: string, to: string): void {
  try {
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  } catch { /* best effort */ }
}

function sessionModel(testCase: Case, host: HostId, config: RootTestConfig): string | undefined {
  // A fixed test model (e.g. 'auto' for Cursor) wins — decouples e2e from a
  // possibly-stale model-tiers table.
  const override = config.hosts[host].testModel;
  if (override) return override;
  const level = testCase.preSeed.performance ?? 'balanced';
  const resolved = modelForRoleHost(level, 'senior-architect', host, testCase.preSeed.team?.overrides ?? null, null);
  return resolved ?? config.hosts[host].defaultModelByTier?.highest;
}

export async function runCase(
  testCase: Case,
  target: HostId | 'pure-node',
  config: RootTestConfig,
  distRoot: string,
  assertions: Map<string, Assertion>,
  runDir: string,
): Promise<CaseRunResult> {
  const startedAt = new Date().toISOString();
  // Per-case folder INSIDE the run folder (which lives outside the repo). Holds
  // the live project plus isolated state, logs, and snapshots — all persisted.
  const caseFolder = path.join(runDir, 'projects', `${testCase.id}__${target}`);
  fs.mkdirSync(path.join(caseFolder, 'state'), { recursive: true });

  const projectDir = path.join(caseFolder, 'project');
  if (isInsidePluginAuthoringRoot(projectDir)) {
    throw new Error(`project dir ${projectDir} resolved inside the plugin authoring root — state writers would no-op. runsRoot must be outside the repo.`);
  }
  materializeFixture(projectDir, testCase.fixture);
  const tmpDir = projectDir;

  const env: CaseEnv = buildCaseEnv(config, caseFolder, distRoot, target);

  // --- seed / onboard (in-process, isolated) ---
  const modelCatalogBlocker = withCaseEnv(env, () => {
    let blocker = '';
    if (target === 'codex') {
      try {
        seedCodexE2eModelCatalog(config.hosts.codex, env);
      } catch (error) {
        blocker = `blocked-environment: could not seed the isolated Codex E2E model catalog: ${String(error)}`;
      }
    }
    if (testCase.scriptedAnswers && testCase.scriptedAnswers.length > 0) {
      // Flow-sim: start from an incomplete state carrying only the mode, then
      // drive the real wizard to completion.
      writeState(tmpDir, { mode: testCase.preSeed.mode });
      const sim = driveOnboarding(tmpDir, testCase.scriptedAnswers);
      fs.writeFileSync(path.join(caseFolder, 'onboarding-sim.json'), JSON.stringify(sim, null, 2));
    } else {
      preseed(tmpDir, testCase.preSeed);
    }
    return blocker;
  });

  // The proof file must be created by the selected host runtime, never by a
  // previous attempt or by the in-process seed/materialization phase.
  const runtimeProofFile = env[RUNTIME_PROOF_FILE_ENV];
  if (runtimeProofFile) fs.rmSync(runtimeProofFile, { force: true });

  // --- optional host run ---
  let hostResult: HostRunResult = { status: 'NOT_RUN', exitCode: null, durationMs: 0 };
  if (target !== 'pure-node' && testCase.layer === 'host-e2e') {
    const driver = DRIVERS[target];
    const cfg = config.hosts[target];
    const environmentBlocker = cfg.e2eBlockedReason || modelCatalogBlocker;
    if (environmentBlocker) {
      hostResult = {
        status: 'BLOCKED_ENVIRONMENT',
        exitCode: null,
        durationMs: 0,
        skippedReason: environmentBlocker,
      };
    } else if (!driver.isAvailable(cfg, env)) {
      hostResult = { status: 'SKIPPED', exitCode: null, durationMs: 0, skippedReason: `${cfg.bin} not found on PATH` };
    } else {
      const prepared = prepareCaseHostIntegration(target, distRoot, tmpDir, env);
      if (!prepared.ok) {
        hostResult = { status: 'ERROR', exitCode: null, durationMs: 0, skippedReason: prepared.error };
      } else {
        const prompt = resolveCasePrompt(testCase, target, config);
        hostResult = await driver.run(cfg, {
          cwd: tmpDir,
          prompt,
          env,
          timeoutMs: config.defaultTimeoutMs,
          model: sessionModel(testCase, target, config),
          distRoot,
          runFolder: caseFolder,
        });
      }
      // Optional second-phase edit in the SAME project (lifecycle text edits etc.).
      if (testCase.phase2Prompt && hostResult.status === 'COMPLETED') {
        await driver.run(cfg, {
          cwd: tmpDir, prompt: testCase.phase2Prompt, env,
          timeoutMs: config.defaultTimeoutMs, model: sessionModel(testCase, target, config),
          distRoot, runFolder: path.join(caseFolder, 'phase2'),
        });
      }
    }
  }

  // --- assertions ---
  const results = await runAssertions(
    testCase,
    target,
    tmpDir,
    env,
    hostResult,
    assertions,
    config,
    assertionSpecsForRun(testCase, target),
  );
  if (target !== 'pure-node') {
    hostResult = {
      ...hostResult,
      hostCapability: currentHostCapabilityReport(tmpDir, target),
    };
  }

  // --- capture artifacts (the live project is persisted in place; copy a stable
  // snapshot of .one.json for the report/verdict agent's convenience) ---
  copyIfExists(path.join(projectDir, '.traffic-one', '.one.json'), path.join(caseFolder, 'state', 'one.json'));
  fs.writeFileSync(path.join(caseFolder, 'meta.json'), JSON.stringify({
    caseId: testCase.id,
    target,
    projectDir,
    distRoot,
    runtimeProof: env[RUNTIME_PROOF_TOKEN_ENV] && env[RUNTIME_PROOF_ENTRY_ENV]
      ? { token: env[RUNTIME_PROOF_TOKEN_ENV], entry: env[RUNTIME_PROOF_ENTRY_ENV] }
      : undefined,
    hostResult,
  }, null, 2));

  return {
    caseId: testCase.id,
    category: testCase.category,
    layer: testCase.layer,
    host: target,
    runFolder: caseFolder,
    hostResult,
    assertions: results,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

// Run a case's assertions against an already-prepared project dir + host result.
// Shared by a live run and by reassertCase (re-evaluating a persisted run).
async function runAssertions(
  testCase: Case,
  target: HostId | 'pure-node',
  cwd: string,
  env: CaseEnv,
  hostResult: HostRunResult,
  assertions: Map<string, Assertion>,
  config: RootTestConfig,
  specs: AssertionSpec[],
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const spec of specs) {
    const assertion = assertions.get(spec.id);
    if (!assertion) {
      results.push({ id: spec.id, title: spec.id, status: 'INCONCLUSIVE', detail: 'no such assertion registered' });
      continue;
    }
    if (!assertion.appliesTo(testCase)) {
      results.push({ id: spec.id, title: assertion.title, status: 'SKIP', detail: 'not applicable to this case' });
      continue;
    }
    const ctx: AssertionContext = {
      cwd,
      env,
      host: target,
      testCase,
      spec,
      hostResult,
      hostConfig: target === 'pure-node' ? undefined : config.hosts[target],
    };
    try {
      const r = await withCaseEnvAsync(env, () => Promise.resolve(assertion.run(ctx)));
      r.title = assertion.title;
      results.push(r);
    } catch (e) {
      results.push({ id: spec.id, title: assertion.title, status: 'FAIL', detail: `assertion threw: ${String(e)}` });
    }
  }
  return results;
}

// Re-evaluate a case's assertions against its PERSISTED project from a prior run
// — no host invocation, no re-seed, no token spend. Reads the recorded hostResult
// so TIMEOUT/COMPLETED gating is preserved. Used by `--reassert <runDir>`.
export async function reassertCase(
  testCase: Case,
  target: HostId | 'pure-node',
  config: RootTestConfig,
  assertions: Map<string, Assertion>,
  runDir: string,
  hostResult: HostRunResult,
): Promise<CaseRunResult> {
  const startedAt = new Date().toISOString();
  const caseFolder = path.join(runDir, 'projects', `${testCase.id}__${target}`);
  const projectDir = path.join(caseFolder, 'project');
  let recordedDistRoot = '';
  let recordedRuntimeProof: { token: string; entry: string } | null = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(caseFolder, 'meta.json'), 'utf8')) as {
      distRoot?: unknown;
      runtimeProof?: { token?: unknown; entry?: unknown };
    };
    if (typeof meta.distRoot === 'string') recordedDistRoot = meta.distRoot;
    if (typeof meta.runtimeProof?.token === 'string' && typeof meta.runtimeProof.entry === 'string') {
      recordedRuntimeProof = { token: meta.runtimeProof.token, entry: meta.runtimeProof.entry };
    }
  } catch { /* pre-fingerprint run */ }
  const env = buildCaseEnv(config, caseFolder, recordedDistRoot, target);
  if (recordedRuntimeProof) {
    env[RUNTIME_PROOF_FILE_ENV] = path.join(caseFolder, 'runtime-proof.json');
    env[RUNTIME_PROOF_TOKEN_ENV] = recordedRuntimeProof.token;
    env[RUNTIME_PROOF_ENTRY_ENV] = recordedRuntimeProof.entry;
  }
  const effectiveHostResult = target === 'pure-node'
    ? hostResult
    : {
      ...hostResult,
      hostCapability: currentHostCapabilityReport(projectDir, target),
    };
  const results = await runAssertions(
    testCase,
    target,
    projectDir,
    env,
    effectiveHostResult,
    assertions,
    config,
    assertionSpecsForRun(testCase, target),
  );
  return {
    caseId: testCase.id,
    category: testCase.category,
    layer: testCase.layer,
    host: target,
    runFolder: caseFolder,
    hostResult: effectiveHostResult,
    assertions: results,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

// Runtime fingerprinting is a harness invariant, not an opt-in case assertion.
// This makes every selected Cursor filter prove its live pointer and also catches
// stale/missing plugin loads on the scripted marketplace hosts.
export function assertionSpecsForRun(
  testCase: Case,
  target: HostId | 'pure-node',
): AssertionSpec[] {
  const specs = [...testCase.assertions];
  if (
    target !== 'pure-node'
    && testCase.layer === 'host-e2e'
    && !specs.some((spec) => spec.id === 'plugin-runtime-fingerprint')
  ) {
    specs.push({ id: 'plugin-runtime-fingerprint' });
  }
  return specs;
}

export function resolveCasePrompt(
  testCase: Case,
  target: HostId | 'pure-node',
  config: RootTestConfig,
): string {
  let prompt = '';
  if (testCase.prompt) prompt = testCase.prompt;
  if (testCase.promptFile) {
    const file = path.resolve(__dirname, '..', 'config', 'cases', testCase.promptFile);
    if (!prompt && fs.existsSync(file)) prompt = fs.readFileSync(file, 'utf8');
  }
  if (!prompt) prompt = 'Proceed with the task described in this project.';
  if (target === 'pure-node') return prompt;
  const catalog = config.hosts[target].testModelByTier;
  return prompt
    .replaceAll('{TEST_MODEL_HIGHEST}', catalog?.highest ?? '')
    .replaceAll('{TEST_MODEL_BALANCED}', catalog?.balanced ?? '')
    .replaceAll('{TEST_MODEL_CHEAPEST}', catalog?.cheapest ?? '');
}

// Async-aware env wrapper: applies env, awaits fn, restores. Safe at the default
// concurrency of 1 (serial).
async function withCaseEnvAsync<T>(env: CaseEnv, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) { saved.set(key, process.env[key]); process.env[key] = env[key]; }
  try {
    return await fn();
  } finally {
    for (const [key, prev] of saved) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}
