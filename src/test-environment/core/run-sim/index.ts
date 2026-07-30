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
import { ensureCurrentRunId } from '../../../shared/state/run-agent';
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
import { buildImplementContext } from './assignments';
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
  execFileSync('git', [...GIT_ENV, 'commit', '-qm', 'run-sim baseline'], { cwd, stdio: 'ignore' });
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

export function runSimulatedRun(
  cwd: string,
  testCase: Case,
  _caseFolder: string,
): RunSimTranscript {
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
    facts: {},
  };
  const finish = (failure?: string): RunSimTranscript => {
    transcript.durationMs = Date.now() - started;
    transcript.ok = !failure;
    if (failure) transcript.failure = failure;
    return transcript;
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
  const implement = buildImplementContext(runId, architecture, assignments);
  // Backend first: the frontend's IMPLEMENTED gate runs the COMPLETE structure
  // scan, which requires every planned module to exist — including the service
  // module the backend owns. A run where the frontend lands last is the normal
  // ordering anyway.
  const implementers = ['senior-backend', 'senior-frontend']
    .filter((role) => implement.outputsFor(role).length > 0);

  const authored = new Map<string, string[]>();
  for (const role of [...implementers, 'senior-tester']) {
    const writes: ScriptedWrite[] = [];
    for (const rel of implement.outputsFor(role)) {
      const content = sourceFor(rel, implement);
      if (content !== null) writes.push({ path: rel, content });
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

  return finish();
}

function countAuthored(authored: Map<string, string[]>): number {
  let total = 0;
  for (const files of authored.values()) total += files.length;
  return total;
}

export type { RunSimTranscript } from './types';
