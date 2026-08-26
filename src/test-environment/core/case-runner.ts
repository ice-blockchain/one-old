// src/test-environment/core/case-runner.ts
// Runs ONE case for ONE target (a host id, or 'pure-node'): isolated temp project
// → seed/onboard → optional host run → assertions → artifact capture → cleanup.

import * as fs from 'fs';
import * as path from 'path';

import { isInsidePluginAuthoringRoot } from '../../shared/authoring-root';
import { writeState } from '../../shared/state/normalize';
import { modelForRoleHost } from '../../shared/performance';
import type {
  Assertion, AssertionContext, AssertionResult, AssertionSpec, Case, CaseMemberContext, CaseRunResult,
  HostId, HostRunResult, RootTestConfig,
} from './types';
import { buildCaseEnv, memberCaseEnv, withCaseEnv, type CaseEnv } from './env';
import {
  RUNTIME_PROOF_ENTRY_ENV,
  RUNTIME_PROOF_FILE_ENV,
  RUNTIME_PROOF_TOKEN_ENV,
} from './current-dist';
import { caseConsent, establishCaseConsent, type ConsentFact } from './consent';
import { runDeclineProbe } from './decline-sim';
import { isWorkspaceFixture, materializeCaseFixture } from './fixtures';
import { preseed } from './preseed';
import { driveOnboarding } from './onboarding-sim';
import { runSimulatedRun } from './run-sim';
import type { RunSimTranscript } from './run-sim/types';
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
  const project = materializeCaseFixture(projectDir, testCase.fixture);
  const tmpDir = project.root;

  const env: CaseEnv = buildCaseEnv(config, caseFolder, distRoot, target);

  // Each member is an ordinary project with its own root and its own environment
  // — including its own preferences bucket (core/env.ts memberCaseEnv). Built
  // before any seeding, because consent is recorded per project root and a
  // member whose answer landed in a shared file would be seeding through the
  // wrong fence.
  const members: CaseMemberContext[] = project.members.map((m) => ({
    id: m.id,
    cwd: m.root,
    fixture: m.fixture,
    probeDir: m.probeDir,
    probeFile: m.probeFile,
    env: memberCaseEnv(env, caseFolder, { id: m.id, root: m.root }),
  }));
  // Persisted so `--reassert` rebuilds the same member list instead of
  // re-deriving it from a fixture the config may have changed since.
  if (members.length > 0) {
    fs.writeFileSync(path.join(caseFolder, 'members.json'), JSON.stringify(members, null, 2));
  }

  // A workspace whose container is a bare directory has no root PROJECT: seeding
  // it would mint a `.traffic-one/` into a container that is meant to own
  // nothing, which is the exact shape every workspace assertion measures.
  const rootIsProject = !isWorkspaceFixture(testCase.fixture) || Boolean(testCase.fixture.container);

  const consent = caseConsent(testCase.consent);

  // --- seed / onboard / simulate (in-process, isolated) ---
  // Consent comes FIRST and unconditionally. The write fence is default-closed
  // (shared/state/plugin-use.ts), so without a recorded answer writeState below
  // is refused at the fsjson chokepoint, `.one.json` never exists, and every
  // assertion in the case fails on the same missing step — 104 red assertions
  // for one un-answered question, measured. See core/consent.ts.
  const seeded = withCaseEnv(env, (): { blocker: string; seedRefusal: string; consentFact: ConsentFact | null } => {
    let blocker = '';
    if (target === 'codex') {
      try {
        seedCodexE2eModelCatalog(config.hosts.codex, env);
      } catch (error) {
        blocker = `blocked-environment: could not seed the isolated Codex E2E model catalog: ${String(error)}`;
      }
    }
    // The decline direction owns its whole sequence (residue → answer →
    // observation) and must NOT be seeded: "nothing was written" is the claim.
    if (consent === 'decline') return { blocker, seedRefusal: '', consentFact: null };

    // The container of a bare workspace is nobody's project. Consent is an answer
    // about a PROJECT, and `establishCaseConsent` proves the fence by writing a
    // probe under `<root>/.traffic-one/` — so answering for the container would
    // leave the very directory a workspace row asserts is unowned carrying a
    // state directory. The members answer for themselves below.
    if (!rootIsProject) return { blocker, seedRefusal: '', consentFact: null };

    const consentFact = establishCaseConsent(tmpDir, consent, caseFolder, env);
    if (testCase.scriptedAnswers && testCase.scriptedAnswers.length > 0) {
      // Flow-sim: start from an incomplete state carrying only the mode, then
      // drive the real wizard to completion. The seed IS the wizard's starting
      // point, so a refusal here means the harness could not build the world the
      // case describes — reported as such below instead of letting driveOnboarding
      // produce a sim of a project that has no state and every assertion fail on
      // the same missing step (104 red assertions for one cause, measured).
      //
      // Kept separate from `blocker`: that one reaches a verdict only through the
      // host-run branch, which a pure-node case never enters — and both flow-sim
      // cases in the corpus are layer 'pure-node'.
      if (!writeState(tmpDir, { mode: testCase.preSeed.mode })) {
        return {
          blocker,
          seedRefusal: `blocked-environment: the state write fence refused the flow-sim seed \`${path.join(tmpDir, '.traffic-one', '.one.json')}\`, `
            + 'so the wizard was never given its starting mode and this case measured nothing',
          consentFact,
        };
      }
      const sim = driveOnboarding(tmpDir, testCase.scriptedAnswers);
      fs.writeFileSync(path.join(caseFolder, 'onboarding-sim.json'), JSON.stringify(sim, null, 2));
      return { blocker, seedRefusal: '', consentFact };
    }
    // The twin of the flow-sim seed above, and reported the same way: this is the
    // "onboarding pre-completed" world every non-flow-sim case is measured
    // against, so a refused seed leaves a project with no onboarding state and
    // every assertion red on that one step instead of on what the case names.
    if (!preseed(tmpDir, testCase.preSeed)) {
      return {
        blocker,
        seedRefusal: `blocked-environment: the state write fence refused the pre-seed \`${path.join(tmpDir, '.traffic-one', '.one.json')}\`, `
          + 'so this case was measured against a project with no onboarding state',
        consentFact,
      };
    }
    return { blocker, seedRefusal: '', consentFact };
  });
  const modelCatalogBlocker = seeded.blocker || seeded.seedRefusal;
  if (seeded.consentFact) {
    fs.writeFileSync(path.join(caseFolder, 'consent.json'), JSON.stringify(seeded.consentFact, null, 2));
  }

  const memberRefusal = seedWorkspaceMembers(testCase, members, caseFolder, consent);

  if (consent === 'decline') {
    const probe = await withCaseEnvAsync(env, () => runDeclineProbe(tmpDir, caseFolder, env));
    fs.writeFileSync(path.join(caseFolder, 'decline-probe.json'), JSON.stringify(probe, null, 2));
    fs.writeFileSync(path.join(caseFolder, 'consent.json'), JSON.stringify(probe.consent, null, 2));
  }

  // Run-sim: onboarding is pre-completed above, then the whole post-onboarding
  // chain runs with scripted role writes against the real gates. Separate from
  // the sync seeding block because the QA phase awaits the real evidence runner.
  let runSim: RunSimTranscript | null = null;
  if (testCase.layer === 'run-sim' && testCase.runSim) {
    runSim = await withCaseEnvAsync(env, () => runSimulatedRun(tmpDir, testCase, caseFolder));
    fs.writeFileSync(path.join(caseFolder, 'run-sim.json'), JSON.stringify(runSim, null, 2));
  }

  // The proof file must be created by the selected host runtime, never by a
  // previous attempt or by the in-process seed/materialization phase.
  const runtimeProofFile = env[RUNTIME_PROOF_FILE_ENV];
  if (runtimeProofFile) fs.rmSync(runtimeProofFile, { force: true });

  // --- optional host run ---
  // A run-sim case really executed work, so it reports COMPLETED/ERROR rather
  // than NOT_RUN. This is not a fiction dressed up as a host run: the target
  // stays 'pure-node', so no hostCapability sidecar is attached below and no
  // synthetic prevention certification can reach the release report. Leaving it
  // NOT_RUN would make every hostProducedWork-gated assertion SKIP, which
  // result-policy turns into a strict-mode failure.
  let hostResult: HostRunResult = runSim
    ? {
      status: runSim.ok ? 'COMPLETED' : 'ERROR',
      exitCode: runSim.ok ? 0 : 1,
      durationMs: runSim.durationMs,
      stdoutPath: path.join(caseFolder, 'run-sim.json'),
      ...(runSim.failure ? { skippedReason: runSim.failure } : {}),
    }
    : { status: 'NOT_RUN', exitCode: null, durationMs: 0 };
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
  // A refused seed is not something to measure the product against: the project
  // the case names was never built, so every spec would be evaluated against a
  // stateless directory and report the same false failure. INCONCLUSIVE is what
  // this harness already reports for a spec it cannot evaluate (runAssertions
  // below) and the contract for an environment it could not construct — not a
  // pass, and not a verdict on the code.
  const specs = assertionSpecsForRun(testCase, target);
  const seedRefusal = seeded.seedRefusal || memberRefusal;
  const results = seedRefusal
    ? specs.map((spec): AssertionResult => ({
      id: spec.id,
      title: assertions.get(spec.id)?.title ?? spec.id,
      status: 'INCONCLUSIVE',
      detail: seedRefusal,
    }))
    : await runAssertions(
      testCase,
      target,
      tmpDir,
      caseFolder,
      env,
      hostResult,
      assertions,
      config,
      specs,
      members,
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

/**
 * Record consent and pre-complete onboarding for every member of a workspace
 * case, each inside its OWN environment. Returns the refusal text, or '' when
 * every member was built.
 *
 * The per-member `withCaseEnv` is the whole point: `preseed` and the consent
 * handlers reach `process.env` through the real source writers, so a member
 * seeded under the case's env would land its `.one.json` in its own directory
 * (that one takes a cwd) while its preferences went to the case-wide file (that
 * one does not). Half-isolated is the shape that looks correct and certifies
 * nothing.
 *
 * A refusal is reported exactly like the single-project seed refusal three
 * functions up, and for the same measured reason: the world the case names was
 * never built, so every assertion would report a product failure for one missing
 * harness step.
 */
function seedWorkspaceMembers(
  testCase: Case,
  members: readonly CaseMemberContext[],
  caseFolder: string,
  consent: ReturnType<typeof caseConsent>,
): string {
  if (members.length === 0) return '';
  if (consent === 'decline') {
    // Not a silent skip: the decline direction's claim is that NOTHING was
    // written, and proving it per member needs a per-member decline probe that
    // does not exist yet. Saying so is what stops a workspace case from being
    // written with `consent: 'decline'` and quietly measuring the container.
    return 'blocked-environment: a workspace case cannot yet express the DECLINE direction — '
      + 'runDeclineProbe answers for one project root, and a workspace needs one probe per member';
  }
  const fixture = testCase.fixture;
  const memberSpecs = isWorkspaceFixture(fixture) ? fixture.members : [];
  for (const member of members) {
    const spec = memberSpecs.find((candidate) => candidate.id === member.id);
    const preSeed = spec?.preSeed ?? testCase.preSeed;
    const refusal = withCaseEnv(member.env, (): string => {
      const fact = establishCaseConsent(member.cwd, consent, caseFolder, member.env);
      const dir = path.join(caseFolder, 'members', member.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'consent.json'), JSON.stringify(fact, null, 2));
      if (!preseed(member.cwd, preSeed)) {
        return `blocked-environment: the state write fence refused the pre-seed for workspace member \`${member.id}\` `
          + `at \`${path.join(member.cwd, '.traffic-one', '.one.json')}\`, so this case was measured against a `
          + 'workspace whose members carry no onboarding state';
      }
      return '';
    });
    if (refusal) return refusal;
  }
  return '';
}

/** The member list a prior run persisted, for `--reassert`. */
function readPersistedMembers(caseFolder: string): CaseMemberContext[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(caseFolder, 'members.json'), 'utf8')) as unknown;
    return Array.isArray(raw) ? raw as CaseMemberContext[] : [];
  } catch {
    return []; // a single-project run, or a run from before workspace cases existed
  }
}

// Run a case's assertions against an already-prepared project dir + host result.
// Shared by a live run and by reassertCase (re-evaluating a persisted run).
async function runAssertions(
  testCase: Case,
  target: HostId | 'pure-node',
  cwd: string,
  caseFolder: string,
  env: CaseEnv,
  hostResult: HostRunResult,
  assertions: Map<string, Assertion>,
  config: RootTestConfig,
  specs: AssertionSpec[],
  members: readonly CaseMemberContext[],
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
      caseFolder,
      env,
      members,
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
    caseFolder,
    env,
    effectiveHostResult,
    assertions,
    config,
    assertionSpecsForRun(testCase, target),
    readPersistedMembers(caseFolder),
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
  // Consent is the same class of thing: an invariant of every run, not something
  // a case opts into. It is injected rather than listed per case because when the
  // fence went default-closed EVERY case broke, and a per-case opt-in would have
  // let the next case author omit the one assertion that names why.
  const consentSpec = caseConsent(testCase.consent) === 'decline'
    ? 'consent-decline-fence'
    : 'consent-fence';
  if (!specs.some((spec) => spec.id === consentSpec)) specs.push({ id: consentSpec });
  // First-attempt Briefing-class rate is the product KPI. Injected on every
  // run-sim case for the same reason consent is: a per-case opt-in would let
  // the next case author omit the assertion that names why a fully-briefed
  // scripted run still paid a briefing deny.
  if (
    testCase.layer === 'run-sim'
    && !specs.some((spec) => spec.id === 'run-sim-briefing-ratchet')
  ) {
    specs.push({ id: 'run-sim-briefing-ratchet' });
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
