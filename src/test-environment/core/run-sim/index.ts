// src/test-environment/core/run-sim/index.ts
// The phase machine. It drives a full post-onboarding run with scripted role
// writes: real writers for everything runtime owns, and the real plan-write gate
// for everything a role would author.
//
// The load-bearing idea: writing `.traffic-one/digests/<runId>/architect.md`
// with `PLAN_READY` is not a bookkeeping step — it IS the runtime transaction
// (plan-readiness/index.ts:275-408: compile -> verification -> assignments ->
// rollback barrier -> persist -> ensureScaffoldContent -> publish x2 ->
// settlement -> bootstraps). One allowed write exercises the whole chain, and
// nothing reaches disk unless every check passes. That composition is precisely
// what no unit test covers.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  readCompiledArchitecture,
  readRuntimeAssignments,
} from '../../../shared/architecture-contract';
import { readActiveRunBootstrap } from '../../../shared/run-bootstrap-policy';
import { ensureRunHostCapability } from '../../../shared/host/capabilities';
import type { Rec } from '../../../shared/obj';
import { readRunSettlement } from '../../../shared/run-settlement';
import { ensureRunModelPolicy } from '../../../shared/run-model-policy';
import { materializeProjectFromState } from '../../../shared/materialize';
import { readEffectiveState } from '../../../shared/state';
import { listClaimedAgents, nextSpawnIndex } from '../../../shared/state/run-agent/claims-store';
import { maybeFlipToMaintenance } from '../../../modules/materialize/build-complete';
import { obj } from '../../../shared/obj';
import {
  ensureCurrentRunId,
  releaseRunClaims,
  runVerificationState,
  settleTerminalRunLedger,
} from '../../../shared/state/run-agent';
import { readVerificationContract } from '../../../shared/verification-contract';
import type { Case } from '../types';

import {
  AGENTIGNORE_BODY,
  MEMORY_FILES,
  adrBody,
  backendDocBody,
  digestBody,
  hasOwnedBackend,
  memoryBody,
  planBody,
} from './content';
import { buildImplementContext, type ImplementContext } from './assignments';
import { buildDirFor, writeBuildOutput } from './build-output';
import { runMaintenanceLegs, runMaintenancePass } from './maintenance';
import { runBrowserEvidence, runBrowserProbe, runStackEvidence } from './qa';
import { sourceFor } from './sources';
import type { RunSimTranscript, ScriptedWrite } from './types';
import { applyAll, bindRole } from './write';

const GIT_ENV = ['-c', 'user.email=run-sim@traffic.one', '-c', 'user.name=run-sim'];

// A real repository, not the empty `.git` marker fixtures write for path
// resolution. Without a real HEAD, captureArchitectureBaseline falls back to
// `file-manifest`, changedHunkEvidence is unavailable, and deriveUiImpact
// conservatively raises everything — which would make every impact assertion in
// this tier meaningless. Same recipe as
// src/shared/__tests__/verification-contract.test.ts:777-782.
function initRepo(cwd: string): void {
  const gitDir = path.join(cwd, '.git');
  // Fixtures may have left a bare marker directory; a real init needs it gone.
  if (fs.existsSync(gitDir) && !fs.existsSync(path.join(gitDir, 'HEAD'))) {
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
  execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
  // `--allow-empty`: an existing-codebase fixture may already be committed, and
  // a baseline step that throws when there is nothing to commit would fail the
  // run for a non-product reason.
  execFileSync('git', [...GIT_ENV, 'commit', '-q', '--allow-empty', '-m', 'run-sim baseline'], { cwd, stdio: 'ignore' });
}

function architectWrites(runId: string, brief: string, state: Rec): ScriptedWrite[] {
  const writes: ScriptedWrite[] = [];
  for (const file of MEMORY_FILES) {
    writes.push({ path: `.traffic-one/${file}`, content: memoryBody(file, brief, state) });
  }
  writes.push({ path: '.traffic-one/.agentignore', content: AGENTIGNORE_BODY });
  for (const file of ['api.md', 'database.md', 'schema.sql']) {
    writes.push({ path: `.traffic-one/${file}`, content: backendDocBody(file, state) });
  }
  // hasDecisionRecordWhenNeeded (architect.ts:62-78) requires an ADR for any
  // non-default choice. Writing one unconditionally would be harmless, but
  // matching the gate's own condition keeps the default shape's file set honest.
  const mobile = state.mobile as Rec | undefined;
  const nonDefault = state.stack !== 'default'
    || state.frontend !== 'react-vite'
    || state.backend !== 'supabase'
    || Boolean(mobile?.enabled);
  if (nonDefault) {
    writes.push({
      path: `.traffic-one/decisions/${runId}-stack.md`,
      content: adrBody(state, brief),
    });
  }
  writes.push({ path: '.traffic-one/plan.md', content: planBody(brief, state) });
  return writes;
}


// The on-disk facts that distinguish a REUSED agent from a respawned one:
// nextSpawnIndex (max of the state counter and the claim count on disk) and the
// identity of the claims themselves.
function claimSnapshot(cwd: string, runId: string, role: string): {
  spawnIndex: number;
  claimIds: string[];
} {
  const state = readEffectiveState(cwd);
  const claims = listClaimedAgents(cwd, runId)
    .filter((claim: Rec) => claim.role === role)
    .map((claim: Rec) => String(claim.claimId ?? claim.sessionId ?? ''))
    .filter(Boolean)
    .sort();
  return { spawnIndex: nextSpawnIndex(cwd, state, runId, role), claimIds: claims };
}


// A dependency-free stand-in for the project's formatter.
//
// It is NOT prettier and does not pretend to be: it verifies two properties the
// authored sim sources genuinely hold — no trailing whitespace on any line, and
// a final newline — over the same tree `prettier --check .` would walk. That is
// enough to prove the thing this tier must prove about `stack-format`: that the
// check is required, executed for real, its result reaches report-v2.json, and a
// red format:check fails QA validation. Proving prettier's own correctness is
// prettier's job, not this tier's.
function installSimFormatter(cwd: string): void {
  const binDir = path.join(cwd, 'node_modules', '.bin');
  const bin = path.join(binDir, 'prettier');
  if (fs.existsSync(bin)) return;
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(bin, [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', '.next', '.turbo', '.vite', '.traffic-one', '.git']);",
    "const CHECKABLE = /\\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|json|md|ya?ml)$/i;",
    'const offenders = [];',
    'function walk(dir) {',
    '  let entries = [];',
    '  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }',
    '  for (const entry of entries) {',
    '    const full = path.join(dir, entry.name);',
    '    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(full); continue; }',
    '    if (!entry.isFile() || !CHECKABLE.test(entry.name)) continue;',
    '    let text = "";',
    '    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }',
    '    if (!text) continue;',
    '    const trailing = text.split("\\n").some((line) => /[ \\t]+$/.test(line));',
    '    if (trailing || !text.endsWith("\\n")) offenders.push(path.relative(process.cwd(), full));',
    '  }',
    '}',
    "walk(process.cwd());",
    'if (offenders.length > 0) {',
    '  process.stdout.write("[warn] Code style issues found in:\\n" + offenders.join("\\n") + "\\n");',
    '  process.exit(1);',
    '}',
    'process.stdout.write("All matched files use Prettier code style!\\n");',
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(bin, 0o755);
}

// --- negative rows ---------------------------------------------------------
// The suite proves gates ACCEPT correct work across every shape. These prove
// they still REJECT the specific defects they exist for. Without them a gate
// that quietly turned permissive would keep the whole suite green — the failure
// mode we agreed a run-sim tier must not have.
//
// Every row runs AFTER settlement, so a row that wrongly succeeds cannot
// corrupt the verified run it is checking. `denyMatch` pins WHICH gate refused:
// "something denied it" is not evidence that the right thing did.
function negativeRows(cwd: string, runId: string, implement: ImplementContext): ScriptedWrite[] {
  const rows: ScriptedWrite[] = [];

  rows.push({
    path: `.traffic-one/runs/${runId}/assignments.json`,
    content: '{"schemaVersion":1,"assignments":[]}\n',
    expectDeny: true,
    denyMatch: 'generated atomically from CompiledArchitectureV1',
  });

  rows.push({
    path: `.traffic-one/runs/${runId}/verification-v2.json`,
    content: '{"schemaVersion":2}\n',
    expectDeny: true,
    denyMatch: 'is published by the runtime',
  });

  // A role reaching into another role's compiled output.
  const backendOutput = implement.outputsFor('senior-backend')
    .find((rel) => /\.(ts|go|py)$/.test(rel));
  if (backendOutput) {
    rows.push({
      path: backendOutput,
      content: '// not mine to write\n',
      expectDeny: true,
      denyMatch: 'Run-team enforcement gate',
    });
  }

  // Collapsed source into a legitimately OWNED frontend output. The gate must
  // deny on content alone: it used to wave this through whenever the project's
  // prettier happened to be reachable, which made the same bytes legal after
  // `npm install` and illegal before, and landed the unformatted original on
  // disk either way. Without a negative row the gate can go quiet and every
  // other assertion still passes.
  const frontendOutput = implement.outputsFor('senior-frontend')
    .find((rel) => /\.(tsx|jsx|vue)$/.test(rel));
  if (frontendOutput) {
    const packed = `export function Collapsed() { ${'const a = 1; const b = 2; const c = 3; '.repeat(6)}return null; }`;
    rows.push({
      path: frontendOutput,
      content: `${packed}\n`,
      expectDeny: true,
      denyMatch: 'STRUCT_COLLAPSED_LINE',
    });
  }

  // The architect may not choose output paths, roots or roles.
  rows.push({
    path: `.traffic-one/runs/${runId}/architecture-input-v1.json`,
    content: `${JSON.stringify({
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'x', name: 'X', kind: 'page', ownerRole: 'senior-frontend' }],
    })}\n`,
    expectDeny: true,
    denyMatch: 'may not choose output paths, roots, or roles',
  });

  return rows;
}

export async function runSimulatedRun(
  cwd: string,
  testCase: Case,
  _caseFolder: string,
): Promise<RunSimTranscript> {
  const started = Date.now();
  const spec = testCase.runSim!;
  const transcript: RunSimTranscript = {
    ok: false,
    caseId: testCase.id,
    runId: '',
    mode: testCase.preSeed.mode,
    durationMs: 0,
    phasesCompleted: [],
    writes: [],
    spawns: [],
    facts: {},
  };
  const finish = (failure?: string): RunSimTranscript => {
    transcript.durationMs = Date.now() - started;
    transcript.ok = !failure;
    if (failure) transcript.failure = failure;
    return transcript;
  };
  // Stop for a reason that is NOT the product's fault: a required toolchain is
  // absent here. The run still did not finish, so `failure` is set as usual, but
  // `environmentBlock` tells the assertions to say INCONCLUSIVE instead of FAIL.
  const finishBlocked = (phase: string, blocker: string): RunSimTranscript => {
    transcript.environmentBlock = `${phase}: ${blocker}`;
    return finish(`${phase} blocked-environment: ${blocker}`);
  };

  // --- Phase 0: bootstrap, all real writers -------------------------------
  const materialized = materializeProjectFromState(cwd, { trigger: 'run-sim' });
  transcript.facts.materialization = {
    status: materialized.status,
    rules: materialized.result?.rules ?? 0,
    skills: materialized.result?.skills ?? 0,
  };
  if (!materialized.result || materialized.result.rules === 0) {
    // Almost always a missing/stale dist: materializeProjectAssets resolves
    // rules and skills from pluginRoot() with no src/ fallback and filters by
    // existsSync, so an unbuilt tree materializes nothing and says nothing.
    return finish(`phase-0 materialization produced no rules (status=${materialized.status}); is dist built?`);
  }

  try {
    initRepo(cwd);
  } catch (error) {
    return finish(`phase-0 git baseline failed: ${String(error)}`);
  }

  const runId = ensureCurrentRunId(cwd, readEffectiveState(cwd));
  if (!runId) return finish('phase-0 could not mint a run id');
  transcript.runId = runId;

  ensureRunHostCapability(cwd, runId, 'claude');
  const policy = ensureRunModelPolicy(cwd, runId, 'claude', readEffectiveState(cwd));
  transcript.facts.modelPolicy = Boolean(policy);
  const subagents = (readEffectiveState(cwd) as Rec).team as Rec | undefined;
  if (!policy && subagents?.mode === 'subagents') {
    // plan-readiness/index.ts:294 denies PLAN_READY outright without a policy,
    // so failing here names the real cause instead of surfacing as a deny later.
    return finish('phase-0 model policy could not be published for a subagents team');
  }
  transcript.phasesCompleted.push('bootstrap');

  // --- Phase 1: architect --------------------------------------------------
  if (!bindRole(cwd, 'senior-architect')) {
    return finish('phase-1 could not bind a run claim for senior-architect');
  }
  const state = readEffectiveState(cwd) as Rec;
  const denied = applyAll(
    cwd,
    'architect',
    'senior-architect',
    architectWrites(runId, spec.brief, state),
    transcript,
  );
  if (denied) return finish(`phase-1 unexpected deny on ${denied.path}: ${denied.reason}`);

  const inputWrite: ScriptedWrite = {
    path: `.traffic-one/runs/${runId}/architecture-input-v1.json`,
    content: `${JSON.stringify(spec.architecture, null, 2)}\n`,
  };
  const inputDenied = applyAll(cwd, 'architect', 'senior-architect', [inputWrite], transcript);
  if (inputDenied) {
    return finish(`phase-1 architecture input denied: ${inputDenied.reason}`);
  }

  // The transaction.
  const planReady: ScriptedWrite = {
    path: `.traffic-one/digests/${runId}/architect.md`,
    content: digestBody({
      role: 'senior-architect',
      runId,
      verdict: 'PLAN_READY',
      summary: `Semantic plan and ArchitectureInputV1 for: ${spec.brief}`,
      touched: ['.traffic-one/plan.md', `.traffic-one/runs/${runId}/architecture-input-v1.json`],
    }),
  };
  const planDenied = applyAll(cwd, 'plan-ready', 'senior-architect', [planReady], transcript);
  if (planDenied) return finish(`PLAN_READY denied: ${planDenied.reason}`);
  transcript.phasesCompleted.push('plan-ready');

  // --- Snapshot what the transaction published ----------------------------
  const architecture = readCompiledArchitecture(cwd, runId);
  const verification = readVerificationContract(cwd, runId);
  const assignments = readRuntimeAssignments(cwd, runId);
  const settlement = readRunSettlement(cwd, runId);
  transcript.facts.architectureHash = architecture?.contractHash;
  transcript.facts.verificationHash = verification?.contractHash;
  transcript.facts.assignmentsHash = assignments?.assignmentsHash;
  transcript.facts.settlementStatus = settlement?.status;
  transcript.facts.baselineKind = architecture?.baseline.kind;
  transcript.facts.uiImpact = verification?.uiImpact;
  transcript.facts.browserRequired = verification?.browserRequired;
  transcript.facts.requiredChecks = verification?.requiredChecks;
  transcript.facts.scaffoldOutputs = (architecture?.scaffoldOutputs || []).map((o) => o.path);
  transcript.facts.bootstrapRoles = (architecture?.profile.roles || [])
    .filter((role) => Boolean(readActiveRunBootstrap(cwd, runId, role)));

  if (!architecture || !verification || !assignments) {
    return finish('PLAN_READY was allowed but the contract triple did not read back');
  }

  // --- Phase 2: implementers ----------------------------------------------
  // Every path comes from the published assignments; nothing here is literal.
  const implement = buildImplementContext(runId, architecture, assignments, cwd);
  // Backend first: the frontend's IMPLEMENTED gate runs the COMPLETE structure
  // scan, which requires every planned module to exist — including the service
  // module the backend owns. A run where the frontend lands last is the normal
  // ordering anyway.
  const implementers = ['senior-backend', 'senior-frontend']
    .filter((role) => implement.outputsFor(role).length > 0);

  // Fail fast on a mis-addressed extra row: a role that owns no work unit
  // would silently skip its rows, and the case would prove nothing.
  for (const extra of spec.extraWrites ?? []) {
    if (!implementers.includes(extra.role) && extra.role !== 'senior-tester') {
      return finish(`phase-2 extraWrites name ${extra.role}, which owns no work unit in this run`);
    }
  }

  const authored = new Map<string, string[]>();
  for (const role of [...implementers, 'senior-tester']) {
    const writes: ScriptedWrite[] = [];
    for (const rel of implement.outputsFor(role)) {
      const content = sourceFor(rel, implement);
      if (content !== null) writes.push({ path: rel, content });
    }
    // Case-declared rows beyond the compiled outputs (an existing repo's own
    // conventions). Same gate path, same claim; applyAll fails the run on a
    // deny, so "allowed" is asserted, not hoped.
    for (const extra of spec.extraWrites ?? []) {
      if (extra.role === role) writes.push({ path: extra.path, content: extra.content });
    }
    authored.set(role, writes.map((write) => write.path));
    if (!bindRole(cwd, role)) return finish(`phase-2 could not bind a run claim for ${role}`);
    const roleDenied = applyAll(cwd, `implement:${role}`, role, writes, transcript);
    if (roleDenied) {
      return finish(`phase-2 ${role} denied on ${roleDenied.path}: ${roleDenied.reason}`);
    }
  }
  transcript.facts.sourceFileCount = countAuthored(authored);
  transcript.phasesCompleted.push('implement');

  // Digests last, in the same order: each IMPLEMENTED fires the completion
  // gates (collapse scan, emit config, format/typecheck/test toolchain parity,
  // crawl origin, full structure scan) against the finished tree.
  for (const role of implementers) {
    const suffix = role.replace(/^senior-/, '');
    const digestDenied = applyAll(cwd, `digest:${role}`, role, [{
      path: `.traffic-one/digests/${runId}/${suffix}.md`,
      content: digestBody({
        role,
        runId,
        verdict: 'IMPLEMENTED',
        summary: `Delivered the compiled work unit for ${role}.`,
        touched: authored.get(role) ?? [],
      }),
    }], transcript);
    if (digestDenied) {
      return finish(`phase-2 ${role} IMPLEMENTED denied: ${digestDenied.reason}`);
    }
  }
  transcript.phasesCompleted.push('implemented');

  // --- Phase 4: fix cycle --------------------------------------------------
  // A review round-trip must REUSE the live implementer, not respawn it. The
  // orchestrator prose says so (v1.0.14 made continuation the default and
  // respawn the fallback), but nothing verified the state that proves it. The
  // measurement: bind nothing new, re-write an owned file through the same
  // session id, and require spawnIndex and the claim set to be unchanged.
  if (spec.fixCycle) {
    const owner = implementers[implementers.length - 1];
    if (owner) {
      const before = claimSnapshot(cwd, runId, owner);
      const reviewerSession = bindRole(cwd, 'senior-reviewer');
      if (!reviewerSession) return finish('phase-4 could not bind the reviewer');
      const changes = applyAll(cwd, 'fix-cycle:review', 'senior-reviewer', [{
        path: `.traffic-one/digests/${runId}/reviewer.md`,
        content: digestBody({
          role: 'senior-reviewer',
          runId,
          verdict: 'CHANGES_REQUESTED',
          summary: '1. Tighten the catalogue listing before approval.',
        }),
      }], transcript);
      if (changes) return finish(`phase-4 CHANGES_REQUESTED denied: ${changes.reason}`);

      // The implementer continues in its EXISTING session: no bindRole here,
      // which is exactly what "reuse, do not respawn" means on disk.
      const owned = implement.outputsFor(owner)
        .find((rel) => sourceFor(rel, implement) !== null);
      if (owned) {
        const fixWrite = applyAll(cwd, 'fix-cycle:implement', owner, [{
          path: owned,
          content: `${sourceFor(owned, implement)!}\n`,
        }], transcript);
        if (fixWrite) return finish(`phase-4 fix write denied: ${fixWrite.reason}`);
      }
      const reFixed = applyAll(cwd, 'fix-cycle:digest', owner, [{
        path: `.traffic-one/digests/${runId}/${owner.replace(/^senior-/, '')}.md`,
        content: digestBody({
          role: owner,
          runId,
          verdict: 'IMPLEMENTED',
          summary: 'Addressed the reviewer findings in the owned work unit.',
          touched: owned ? [owned] : [],
        }),
      }], transcript);
      if (reFixed) return finish(`phase-4 re-IMPLEMENTED denied: ${reFixed.reason}`);

      const after = claimSnapshot(cwd, runId, owner);
      transcript.facts.fixCycle = { role: owner, before, after };
      transcript.phasesCompleted.push('fix-cycle');
    }
  }

  // --- Phase 3: verification ----------------------------------------------
  // QA evidence comes from the REAL runner. For a contract with no browser
  // surface that is the `stack` command, which spawns the project's own
  // build/test/lint. Nothing is fabricated: if the toolchain is missing, the
  // runner records `not-applicable` with the reason and the assertion reports
  // an environment gap rather than a pass.
  // `stack-format` is a required check on every impact level, and the seeded
  // manifest declares `format:check`. Without a resolvable formatter the runner
  // honestly reports "declared but its binary is absent" and this tier reports an
  // environment gap — correct, but it would mean the tier proves nothing about
  // the check it just started requiring. So give the simulated project a REAL
  // formatter: not prettier, but a genuine checker of two properties the authored
  // sources actually hold. The negative row plants a violation and requires red.
  installSimFormatter(cwd);
  if (spec.qa.mode === 'stack') {
    const qa = await runStackEvidence(cwd, runId);
    transcript.facts.qaExitCode = qa.code;
    transcript.facts.qaChecks = qa.checks;
    if (qa.blocked) return finishBlocked('phase-3 stack evidence', qa.blocked);
    if (qa.code !== 0) {
      return finish(`phase-3 stack evidence failed (exit ${qa.code}): ${qa.detail}`);
    }
    transcript.phasesCompleted.push('qa');
  } else {
    // Real Chromium against the scripted production build. The runner serves
    // the build dir itself, so no dev server and no bundler are involved.
    const buildDir = buildDirFor(architecture);
    const asset = writeBuildOutput(cwd, buildDir);
    transcript.facts.buildDir = buildDir;
    transcript.facts.buildAsset = asset;
    const qa = await runBrowserEvidence(cwd, runId, buildDir, verification);
    transcript.facts.qaExitCode = qa.code;
    transcript.facts.qaChecks = qa.checks;
    // The 48-red case: no project-local Playwright means no Chromium, which the
    // runner correctly publishes as blocked-environment. That is a gap in this
    // machine, not a defect in the product.
    if (qa.blocked) return finishBlocked('phase-3 browser evidence', qa.blocked);
    if (qa.code !== 0) {
      return finish(`phase-3 browser evidence failed (exit ${qa.code}): ${qa.detail}`);
    }
    transcript.phasesCompleted.push('qa');
  }
  transcript.facts.lastQaRunId = runId;
  transcript.facts.lastQaSource = 'main';

  // `browser` must exit 0 on a contract with no browser surface. Before the v1
  // batch it fell through to loadRun, failed on the missing build manifest, and
  // reported that instead of the real situation.
  transcript.facts.browserExitCode = await runBrowserProbe(cwd, runId);

  for (const [role, verdict] of [
    ['senior-reviewer', 'APPROVED'],
    ['senior-tester', 'TESTS_GREEN'],
  ] as const) {
    if (!bindRole(cwd, role)) return finish(`phase-3 could not bind a run claim for ${role}`);
    const suffix = role.replace(/^senior-/, '');
    const verdictDenied = applyAll(cwd, `digest:${role}`, role, [{
      path: `.traffic-one/digests/${runId}/${suffix}.md`,
      content: digestBody({
        role,
        runId,
        verdict,
        summary: `Reviewed the compiled work units and the published evidence for run ${runId}.`,
      }),
    }], transcript);
    if (verdictDenied) return finish(`phase-3 ${verdict} denied: ${verdictDenied.reason}`);
  }
  transcript.phasesCompleted.push('verified');

  // Lifecycle settlement: the real function the orchestrator calls once the
  // evidence is in. It re-checks reviewer APPROVED + tester TESTS_GREEN +
  // runHasQaEvidence itself and refuses if any is missing, so calling it here
  // asserts the whole chain rather than declaring victory — a run that reached
  // `terminal` but cannot be settled is exactly the silent stall that cost
  // cursor-16c and codex-10co their budgets.
  const settled = settleTerminalRunLedger(cwd, runId, 'verified');
  transcript.facts.ledgerSettled = Boolean(settled);
  transcript.facts.verificationState = runVerificationState(cwd, runId);
  transcript.facts.settlementStatusFinal = readRunSettlement(cwd, runId)?.status;
  if (!settled) {
    return finish('phase-3 settleTerminalRunLedger refused despite APPROVED + TESTS_GREEN + validated evidence');
  }
  transcript.phasesCompleted.push('settled');

  // --- Phase 5: maintenance flip -------------------------------------------
  // The real function the post-build boundary calls. A new project that has
  // been built and verified moves to `maintenance`, which is what routes the
  // NEXT request through post-build triage instead of a fresh architect run.
  // Existing codebases are already maintenance from detection, so the flip is
  // only meaningful — and only asserted — on a new project.
  const flipped = maybeFlipToMaintenance(cwd, readEffectiveState(cwd), {
    atPromptBoundary: true,
  });
  const lifecycle = obj((readEffectiveState(cwd) as Rec).lifecycle);
  transcript.facts.maintenanceFlipped = Boolean(flipped);
  transcript.facts.lifecyclePhase = typeof lifecycle?.phase === 'string' ? lifecycle.phase : null;
  transcript.facts.lifecycleSource = typeof lifecycle?.source === 'string' ? lifecycle.source : null;
  transcript.phasesCompleted.push('maintenance');

  // --- Phase 6: negative rows ----------------------------------------------
  if (spec.negativeGates) {
    // The reviewer session is a bound role that owns none of these paths, which
    // is the realistic actor for every row here.
    bindRole(cwd, 'senior-reviewer');
    const rows = negativeRows(cwd, runId, implement);
    const leaked = applyAll(cwd, 'negative', 'senior-reviewer', rows, transcript);
    if (leaked) {
      return finish(`phase-6 a gate that must deny allowed ${leaked.path}`);
    }
    // The reviewer bind above is sim scaffolding on an already-settled run —
    // production would hold no live claim here, and a leftover one would
    // suppress the maintenance-triage legs' routing below.
    releaseRunClaims(cwd, runId, 'run-sim-negative-rows-done');
    transcript.facts.negativeRows = rows.length;
    transcript.phasesCompleted.push('negative-gates');
  }

  // --- Phase 7: the maintenance run ----------------------------------------
  // A SECOND run in the SAME project, which is what the user's follow-up
  // messages actually are ("add a `ro` locale", "add a news section"). It is
  // the only leg that produces a real diff against a populated baseline, so it
  // is the only one where uiImpact is derived from changed code rather than
  // from "every planned module is missing" — the greenfield floor.
  if (spec.phase2) {
    const second = await runMaintenancePass(cwd, spec.phase2, transcript);
    if (second) return finish(second);
    transcript.phasesCompleted.push('phase2');
  }

  // --- Phase 8: maintenance triage legs -------------------------------------
  // The user's post-build follow-up messages, one leg per prompt, routed
  // through the REAL prompt-boundary machinery (see maintenance.ts).
  if ((spec.maintenance ?? []).length > 0) {
    const legsFailure = await runMaintenanceLegs(cwd, testCase, transcript);
    if (legsFailure) return finish(legsFailure);
    transcript.phasesCompleted.push('maintenance-legs');
  }

  return finish();
}

function countAuthored(authored: Map<string, string[]>): number {
  let total = 0;
  for (const files of authored.values()) total += files.length;
  return total;
}

export type { RunSimTranscript } from './types';
