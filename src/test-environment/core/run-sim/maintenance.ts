// src/test-environment/core/run-sim/maintenance.ts
// The maintenance side of the phase machine: the phase-2 follow-up run and the
// triage LEGS. Everything routes through the production functions — the
// prompt-boundary composition (unresolvedRunDirective || maintenanceTriageDirective),
// the real rotation (beginFreshMaintenanceRun inside the directive), the real
// bounded-WorkUnit publisher (ensureRunBootstrap), and the real plan-write gate
// for every worker write — so what the transcript records is what a user's
// follow-up message would actually have experienced.

import * as path from 'path';
import * as fs from 'fs';

import {
  readCompiledArchitecture,
  readRuntimeAssignments,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import {
  beginFreshMaintenanceRun,
  maintenanceTriageDirective,
  unresolvedRunDirective,
} from '../../../modules/session/triage-directive';
import { isRuntimeControlPrompt } from '../../../shared/detection';
import type { Rec } from '../../../shared/obj';
import {
  ensureRunBootstrap,
  quickFixDigestPath,
} from '../../../shared/run-bootstrap-policy';
import { readRunModelPolicy } from '../../../shared/run-model-policy';
import { readRunSettlement } from '../../../shared/run-settlement';
import { readEffectiveState } from '../../../shared/state';
import {
  runVerificationState,
  settleTerminalRunLedger,
} from '../../../shared/state/run-agent';
import { classifyPromptComplexity } from '../../../shared/triage/classify';
import {
  readVerificationContract,
  type VerificationContractV2,
} from '../../../shared/verification-contract';
import type { Case, MaintenanceTriageLeg, RunSimSpec } from '../types';

import { buildImplementContext } from './assignments';
import { buildDirFor, writeBuildOutput } from './build-output';
import { digestBody } from './content';
import { runBrowserEvidence, runStackEvidence } from './qa';
import { sourceFor } from './sources';
import type { MaintenanceLegFact, RunSimTranscript, ScriptedWrite } from './types';
import { applyAll, applyScriptedWrite, bindRole } from './write';

// The parent session id every leg's prompt rides in on. Deliberately NOT a
// subagent shape: routing must see the main thread.
const PARENT_RAW = { session_id: 'run-sim-parent' };

interface OpenRun {
  runId: string;
  architecture: CompiledArchitectureV1;
  verification: VerificationContractV2;
}

function currentRunId(cwd: string): string {
  const state = readEffectiveState(cwd) as Rec;
  return typeof state.currentRunId === 'string' ? state.currentRunId : '';
}

function modelPolicyFrozen(cwd: string, runId: string): boolean {
  return Boolean(runId) && readRunModelPolicy(cwd, runId) !== null;
}

// Rotate + plan + implement, leaving the run wherever the caller wants it. The
// REAL rotation is beginFreshMaintenanceRun; the REAL transaction is the
// architect's PLAN_READY digest write.
function startMaintenanceRun(
  cwd: string,
  label: string,
  brief: string,
  architecture: unknown,
  transcript: RunSimTranscript,
): { failure: string } | { runId: string; architecture: CompiledArchitectureV1; verification: VerificationContractV2 } {
  const state = readEffectiveState(cwd) as Rec;
  beginFreshMaintenanceRun(cwd, state, 'claude');
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : '';
  if (!runId) return { failure: `${label} the maintenance rotation minted no run id` };

  if (!bindRole(cwd, 'senior-architect')) return { failure: `${label} could not bind the architect` };
  const planned = applyAll(cwd, `${label}:architect`, 'senior-architect', [
    {
      path: `.traffic-one/runs/${runId}/architecture-input-v1.json`,
      content: `${JSON.stringify(architecture, null, 2)}\n`,
    },
    {
      path: `.traffic-one/digests/${runId}/architect.md`,
      content: digestBody({
        role: 'senior-architect',
        runId,
        verdict: 'PLAN_READY',
        summary: `Maintenance plan: ${brief}`,
      }),
    },
  ], transcript);
  if (planned) return { failure: `${label} PLAN_READY denied: ${planned.reason}` };

  const compiled = readCompiledArchitecture(cwd, runId);
  const verification = readVerificationContract(cwd, runId);
  const assignments = readRuntimeAssignments(cwd, runId);
  if (!compiled || !verification || !assignments) {
    return { failure: `${label} the maintenance contract triple did not read back` };
  }

  const implement = buildImplementContext(runId, compiled, assignments, cwd);
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
    if (!bindRole(cwd, role)) return { failure: `${label} could not bind ${role}` };
    const denied = applyAll(cwd, `${label}:implement:${role}`, role, writes, transcript);
    if (denied) return { failure: `${label} ${role} denied on ${denied.path}: ${denied.reason}` };
  }
  for (const role of implementers) {
    const denied = applyAll(cwd, `${label}:digest:${role}`, role, [{
      path: `.traffic-one/digests/${runId}/${role.replace(/^senior-/, '')}.md`,
      content: digestBody({
        role,
        runId,
        verdict: 'IMPLEMENTED',
        summary: `Delivered the maintenance work unit for ${role}.`,
        touched: authored.get(role) ?? [],
      }),
    }], transcript);
    if (denied) return { failure: `${label} ${role} IMPLEMENTED denied: ${denied.reason}` };
  }
  return { runId, architecture: compiled, verification };
}

// QA evidence + green verdicts + ledger settlement for a run whose
// implementation already landed.
async function verifyAndSettleMaintenanceRun(
  cwd: string,
  label: string,
  run: OpenRun,
  transcript: RunSimTranscript,
): Promise<string | null> {
  const { runId } = run;
  if (run.verification.browserRequired) {
    const buildDir = buildDirFor(run.architecture);
    writeBuildOutput(cwd, buildDir);
    const evidence = await runBrowserEvidence(cwd, runId, buildDir, run.verification);
    if (evidence.code !== 0) return `${label} browser evidence failed (exit ${evidence.code}): ${evidence.detail}`;
  } else {
    const evidence = await runStackEvidence(cwd, runId);
    if (evidence.code !== 0) return `${label} stack evidence failed (exit ${evidence.code}): ${evidence.detail}`;
  }
  // The newest run with published-and-validated QA evidence. Later legs
  // legitimately move the tree, so post-hoc validation belongs to THIS run
  // and drift caused by leg-authored writes is expected, not fabricated.
  transcript.facts.lastQaRunId = runId;
  transcript.facts.lastQaSource = label;

  for (const [role, verdict] of [
    ['senior-reviewer', 'APPROVED'],
    ['senior-tester', 'TESTS_GREEN'],
  ] as const) {
    if (!bindRole(cwd, role)) return `${label} could not bind ${role}`;
    const denied = applyAll(cwd, `${label}:digest:${role}`, role, [{
      path: `.traffic-one/digests/${runId}/${role.replace(/^senior-/, '')}.md`,
      content: digestBody({
        role,
        runId,
        verdict,
        summary: `Verified the maintenance delta for run ${runId}.`,
      }),
    }], transcript);
    if (denied) return `${label} ${verdict} denied: ${denied.reason}`;
  }

  const settled = settleTerminalRunLedger(cwd, runId, 'verified');
  if (!settled) return `${label} the maintenance run could not be settled`;
  return null;
}

// One follow-up run (phase 2): rotate the run id the way triage does, re-plan,
// implement the delta, and settle again. Returns a failure string or null.
export async function runMaintenancePass(
  cwd: string,
  phase2: NonNullable<RunSimSpec['phase2']>,
  transcript: RunSimTranscript,
): Promise<string | null> {
  const started = startMaintenanceRun(cwd, 'phase-7', phase2.brief, phase2.architecture, transcript);
  if ('failure' in started) return started.failure;
  transcript.facts.phase2RunId = started.runId;
  transcript.facts.phase2UiImpact = started.verification.uiImpact;
  transcript.facts.phase2ChangedRoutes = started.verification.changedRoutes;

  const failure = await verifyAndSettleMaintenanceRun(cwd, 'phase-7', started, transcript);
  transcript.facts.phase2Settlement = readRunSettlement(cwd, started.runId)?.status;
  transcript.facts.phase2State = runVerificationState(cwd, started.runId);
  return failure;
}

// ── The triage legs ─────────────────────────────────────────────────────────

// The prompt-boundary composition, verbatim from prompt-submit.ts: runtime
// control short-circuits, the unresolved-run directive wins over triage, and
// only an empty unresolved result lets maintenanceTriageDirective run (which,
// in subagents mode, is where the run id rotates).
function routePrompt(cwd: string, promptText: string): {
  routing: 'triage' | 'unresolved' | 'none';
  directive: string;
} {
  const state = readEffectiveState(cwd) as Rec;
  const runtimeControl = isRuntimeControlPrompt(promptText);
  const unresolved = runtimeControl ? '' : unresolvedRunDirective(cwd, state, promptText, PARENT_RAW);
  const triage = unresolved || maintenanceTriageDirective(cwd, state, promptText, PARENT_RAW, 'claude');
  if (unresolved) return { routing: 'unresolved', directive: unresolved };
  return triage
    ? { routing: 'triage', directive: triage }
    : { routing: 'none', directive: '' };
}

// The quick-fix worker flow the trivial tier routes to, driven end to end:
// parent publishes the bounded WorkUnit, the unattributed parent probe and the
// out-of-scope probe are DENIED by the maintenance fail-closed branches, the
// bound worker's in-scope writes land, and the IMPLEMENTED digest closes it.
function runQuickFixLeg(
  cwd: string,
  label: string,
  quickFix: NonNullable<Extract<MaintenanceTriageLeg, { kind: 'prompt' }>['quickFix']>,
  transcript: RunSimTranscript,
): string | null {
  const runId = currentRunId(cwd);
  if (!runId) return `${label} no current run id after triage rotation`;
  const policy = readRunModelPolicy(cwd, runId);
  if (!policy) return `${label} the rotated run has no frozen model policy`;
  const firstFile = quickFix.files[0];
  if (!firstFile) return `${label} quickFix declared no bounded files`;

  // The unattributed parent probe comes FIRST: it must be denied regardless of
  // whether a bounded contract exists yet.
  const parentProbe = applyScriptedWrite(cwd, `${label}:parent-probe`, null, {
    path: firstFile.path,
    content: '// parent must not write feature source in maintenance\n',
    expectDeny: true,
    denyMatch: 'maintenance writes fail closed',
  }, transcript);
  if (!parentProbe.denied) {
    return `${label} an unattributed parent write to ${parentProbe.path} was ALLOWED in maintenance`;
  }

  const envelope = ensureRunBootstrap(cwd, runId, 'quick-fix', readEffectiveState(cwd), {
    host: 'claude',
    hostAgentType: 'quick-fix',
    modelPolicyId: policy.policyId,
    boundedOutputs: quickFix.files.map((file) => file.path),
  });
  if (!envelope) return `${label} ensureRunBootstrap refused the bounded quick-fix WorkUnit`;

  if (!bindRole(cwd, 'quick-fix')) return `${label} could not bind the quick-fix claim`;

  const rows: ScriptedWrite[] = quickFix.files.map((file) => ({ path: file.path, content: file.content }));
  if (quickFix.outOfScope) {
    // The envelope EXISTS here, so an uncovered target gets the scope-REGRANT
    // deny (names the exact path + widening recipe), not the missing-contract
    // refusal — that one still fires when no envelope was published at all.
    rows.push({
      path: quickFix.outOfScope.path,
      content: quickFix.outOfScope.content,
      expectDeny: true,
      denyMatch: `does not cover: ${quickFix.outOfScope.path}`,
    });
  }
  rows.push({
    path: quickFixDigestPath(runId),
    content: digestBody({
      role: 'quick-fix',
      runId,
      verdict: 'IMPLEMENTED',
      summary: 'Bounded maintenance edit delivered and verified.',
      touched: quickFix.files.map((file) => file.path),
    }),
  });
  const denied = applyAll(cwd, `${label}:quick-fix`, 'quick-fix', rows, transcript);
  if (denied) {
    return denied.expected
      ? `${label} expected deny did not happen for ${denied.path}`
      : `${label} quick-fix denied on ${denied.path}: ${denied.reason}`;
  }
  return null;
}

// The small tier's directly-owning role: parent publishes the
// `<role>:bounded-maintenance` WorkUnit, the bound role writes inside it. The
// write MUST be allowed — deny here means the small tier (and the paid
// OpenCode-fallback worker, which uses the same write path) is dead on an
// existing codebase.
function runBoundedRoleLeg(
  cwd: string,
  label: string,
  bounded: NonNullable<Extract<MaintenanceTriageLeg, { kind: 'prompt' }>['boundedRole']>,
  transcript: RunSimTranscript,
): string | null {
  const runId = currentRunId(cwd);
  if (!runId) return `${label} no current run id after triage rotation`;
  const policy = readRunModelPolicy(cwd, runId);
  if (!policy) return `${label} the rotated run has no frozen model policy`;

  const envelope = ensureRunBootstrap(cwd, runId, bounded.role, readEffectiveState(cwd), {
    host: 'claude',
    hostAgentType: bounded.role,
    modelPolicyId: policy.policyId,
    boundedOutputs: bounded.files.map((file) => file.path),
  });
  if (!envelope) return `${label} ensureRunBootstrap refused the bounded ${bounded.role} WorkUnit`;
  if (envelope.workUnit.unitId !== `${bounded.role}:bounded-maintenance`) {
    return `${label} expected a ${bounded.role}:bounded-maintenance unit, got ${envelope.workUnit.unitId}`;
  }

  if (!bindRole(cwd, bounded.role)) return `${label} could not bind ${bounded.role}`;
  const denied = applyAll(
    cwd,
    `${label}:bounded:${bounded.role}`,
    bounded.role,
    bounded.files.map((file) => ({ path: file.path, content: file.content })),
    transcript,
  );
  if (denied) {
    return `${label} bounded ${bounded.role} maintenance write denied on ${denied.path}: ${denied.reason} `
      + '— the small tier / paid-fallback write path does not honor <role>:bounded-maintenance WorkUnits';
  }
  const digestDenied = applyAll(cwd, `${label}:bounded-digest`, bounded.role, [{
    path: `.traffic-one/digests/${runId}/${bounded.role.replace(/^senior-/, '')}.md`,
    content: digestBody({
      role: bounded.role,
      runId,
      verdict: 'IMPLEMENTED',
      summary: 'Bounded small-tier maintenance edit delivered.',
      touched: bounded.files.map((file) => file.path),
    }),
  }], transcript);
  if (digestDenied) {
    return `${label} bounded ${bounded.role} digest denied: ${digestDenied.reason}`;
  }
  return null;
}

export async function runMaintenanceLegs(
  cwd: string,
  testCase: Case,
  transcript: RunSimTranscript,
): Promise<string | null> {
  const legs = testCase.runSim?.maintenance ?? [];
  if (legs.length === 0) return null;
  const facts: MaintenanceLegFact[] = [];
  transcript.facts.maintenanceLegs = facts;
  let openRun: OpenRun | null = null;

  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index]!;
    const label = `leg-${index + 1}`;
    const runIdBefore = currentRunId(cwd);

    if (leg.kind === 'open-run') {
      const started = startMaintenanceRun(cwd, label, leg.brief, leg.architecture, transcript);
      if ('failure' in started) return started.failure;
      // The reviewer records findings: verification has STARTED and is
      // nonterminal, which is the unresolved-run regime.
      if (!bindRole(cwd, 'senior-reviewer')) return `${label} could not bind the reviewer`;
      const finding = applyAll(cwd, `${label}:reviewer`, 'senior-reviewer', [{
        path: `.traffic-one/digests/${started.runId}/reviewer.md`,
        content: digestBody({
          role: 'senior-reviewer',
          runId: started.runId,
          verdict: 'CHANGES_REQUESTED',
          summary: '1. Tighten the new section before approval.',
        }),
      }], transcript);
      if (finding) return `${label} CHANGES_REQUESTED denied: ${finding.reason}`;
      openRun = started;
      facts.push({
        ordinal: index + 1,
        kind: leg.kind,
        runIdBefore,
        runIdAfter: started.runId,
        rotated: started.runId !== runIdBefore,
        modelPolicyFrozen: modelPolicyFrozen(cwd, started.runId),
      });
      if (started.runId === runIdBefore) {
        return `${label} open-run did not rotate away from ${runIdBefore}`;
      }
      continue;
    }

    if (leg.kind === 'resolve-run') {
      if (!openRun) return `${label} resolve-run without a preceding open-run`;
      const failure = await verifyAndSettleMaintenanceRun(cwd, label, openRun, transcript);
      if (failure) return failure;
      const settlement = readRunSettlement(cwd, openRun.runId)?.status;
      facts.push({
        ordinal: index + 1,
        kind: leg.kind,
        runIdBefore,
        runIdAfter: currentRunId(cwd),
        rotated: false,
        settlementStatus: settlement,
      });
      openRun = null;
      continue;
    }

    // kind === 'prompt'
    const hint = classifyPromptComplexity(leg.prompt);
    const routed = routePrompt(cwd, leg.prompt);
    const runIdAfter = currentRunId(cwd);
    const fact: MaintenanceLegFact = {
      ordinal: index + 1,
      kind: leg.kind,
      prompt: leg.prompt,
      expectedRouting: leg.expectRouting,
      routing: routed.routing,
      ...(leg.expectTier ? { expectedTier: leg.expectTier } : {}),
      tier: hint.tier,
      confidence: hint.confidence,
      signals: hint.signals,
      runIdBefore,
      runIdAfter,
      rotated: runIdAfter !== runIdBefore,
      modelPolicyFrozen: modelPolicyFrozen(cwd, runIdAfter),
    };
    facts.push(fact);

    if (routed.routing !== leg.expectRouting) {
      return `${label} "${leg.prompt}" routed as '${routed.routing}', expected '${leg.expectRouting}'`;
    }
    if (leg.expectTier && hint.tier !== leg.expectTier) {
      return `${label} classifier hinted '${hint.tier}' (${hint.signals.join(', ') || 'no signals'}), expected '${leg.expectTier}'`;
    }
    // Rotation semantics: a triage-routed prompt in subagents mode mints a
    // fresh run; the unresolved directive and a no-directive prompt never do.
    if (routed.routing === 'triage' && !fact.rotated) {
      return `${label} triage routed but the run id did not rotate (still ${runIdAfter})`;
    }
    if (routed.routing !== 'triage' && fact.rotated) {
      return `${label} run id rotated on a '${routed.routing}' prompt — only triage may rotate`;
    }

    if (leg.quickFix) {
      if (routed.routing !== 'triage') return `${label} quickFix declared on a non-triage leg`;
      const failure = runQuickFixLeg(cwd, label, leg.quickFix, transcript);
      if (failure) return failure;
    }
    if (leg.boundedRole) {
      if (routed.routing !== 'triage') return `${label} boundedRole declared on a non-triage leg`;
      const failure = runBoundedRoleLeg(cwd, label, leg.boundedRole, transcript);
      if (failure) return failure;
    }
  }

  // The digest the last quick-fix leg wrote must exist with its verdict — the
  // worker's report contract, checked once on disk rather than inferred.
  const quickFixLegs = legs.filter((leg) => leg.kind === 'prompt' && leg.quickFix);
  if (quickFixLegs.length > 0) {
    const lastRun = facts
      .filter((fact) => fact.kind === 'prompt' && fact.routing === 'triage')
      .map((fact) => fact.runIdAfter)
      .pop();
    if (lastRun) {
      const digest = path.join(cwd, quickFixDigestPath(lastRun));
      if (fs.existsSync(digest) && !/verdict: IMPLEMENTED/.test(fs.readFileSync(digest, 'utf8'))) {
        return 'the quick-fix digest exists but does not carry verdict: IMPLEMENTED';
      }
    }
  }
  return null;
}
