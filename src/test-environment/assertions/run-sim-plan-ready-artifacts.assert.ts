// run-sim-plan-ready-artifacts: the PLAN_READY transaction published a COMPLETE
// and internally consistent contract set.
//
// Every read below goes through the real hash-validating reader, not a raw JSON
// parse. readRuntimeAssignments re-derives contractHash and demands byte-equality
// with buildRuntimeAssignments, so a hand-written or drifted manifest cannot
// satisfy this — which is the whole point: the assertion proves the RUNTIME
// published these, not that some files exist with the right names.

import {
  readCompiledArchitecture,
  readRuntimeAssignments,
} from '../../shared/architecture-contract';
import { readActiveRunBootstrap } from '../../shared/run-bootstrap-policy';
import { readRunSettlement } from '../../shared/run-settlement';
import { readVerificationContract } from '../../shared/verification-contract';
import type { Assertion } from '../core/types';
import { effState, latestRunId, readRunSimTranscript, result, str } from './util';

export const assertion: Assertion = {
  id: 'run-sim-plan-ready-artifacts',
  title: 'PLAN_READY published a hash-valid contract set',
  appliesTo: (c) => c.layer === 'run-sim',
  run: (ctx) => {
    const transcript = readRunSimTranscript(ctx);
    if (!transcript) {
      return result(ctx, 'FAIL', 'No run-sim transcript was persisted — the simulated run never started.');
    }
    if (transcript.ok !== true) {
      return result(ctx, 'FAIL', `Simulated run did not complete: ${str(transcript.failure) || 'unknown failure'}`);
    }

    const runId = str(transcript.runId) || latestRunId(ctx.cwd, effState(ctx));
    if (!runId) return result(ctx, 'FAIL', 'The simulated run recorded no run id.');

    const architecture = readCompiledArchitecture(ctx.cwd, runId);
    const verification = readVerificationContract(ctx.cwd, runId);
    const assignments = readRuntimeAssignments(ctx.cwd, runId);
    const settlement = readRunSettlement(ctx.cwd, runId);

    const missing: string[] = [];
    if (!architecture) missing.push('architecture-v1.json');
    if (!verification) missing.push('verification-v2.json');
    if (!assignments) missing.push('assignments.json (hash-valid)');
    if (!settlement) missing.push('settlement-v2.json');
    if (missing.length > 0 || !architecture || !verification || !assignments || !settlement) {
      return result(ctx, 'FAIL', `PLAN_READY was allowed but these artifacts did not read back through their real readers: ${missing.join(', ')}.`);
    }

    // Cross-links. Each sidecar names the hash of the contract it was compiled
    // against; a mismatch means one of them was republished independently, which
    // is exactly the drift the runtime's own preflight is meant to make impossible.
    const mismatches: string[] = [];
    if (assignments.architectureHash !== architecture.contractHash) {
      mismatches.push(`assignments.architectureHash=${assignments.architectureHash} vs architecture.contractHash=${architecture.contractHash}`);
    }
    if (assignments.verificationHash !== verification.contractHash) {
      mismatches.push(`assignments.verificationHash=${assignments.verificationHash} vs verification.contractHash=${verification.contractHash}`);
    }
    if (mismatches.length > 0) {
      return result(ctx, 'FAIL', `The published contract set is internally inconsistent: ${mismatches.join('; ')}.`);
    }

    if (settlement.status !== 'active') {
      return result(ctx, 'FAIL', `Run settlement is \`${settlement.status}\`; PLAN_READY must leave the run \`active\`.`, {
        expected: 'active',
        actual: settlement.status,
      });
    }

    // Every eligible role must have a resolvable bootstrap envelope: an
    // implementer that cannot read its work unit cannot legally write anything,
    // and that failure otherwise only surfaces much later as a confusing deny.
    const roles = architecture.profile.roles;
    const withoutBootstrap = roles.filter((role) => !readActiveRunBootstrap(ctx.cwd, runId, role));
    if (withoutBootstrap.length > 0) {
      return result(ctx, 'FAIL', `No active bootstrap envelope for [${withoutBootstrap.join(', ')}] (roles in the compiled profile: [${roles.join(', ')}]).`, {
        expected: roles,
        actual: roles.filter((role) => !withoutBootstrap.includes(role)),
      });
    }

    // A run-sim case must exercise real diff evidence. A `file-manifest`
    // baseline silently degrades impact classification (deriveUiImpact raises
    // everything conservatively), so every downstream impact assertion in this
    // tier would be measuring nothing.
    if (architecture.baseline.kind !== 'git-head') {
      return result(ctx, 'FAIL', `Architecture baseline is \`${architecture.baseline.kind}\`; run-sim requires a real git baseline for hunk-level evidence.`, {
        expected: 'git-head',
        actual: architecture.baseline.kind,
      });
    }

    // The case's declared QA mode must match what the contract actually asks
    // for. This is the fence that stops a shape from quietly sliding onto the
    // cheap `stack` path if a compiler change lowers its impact.
    const declared = ctx.testCase.runSim?.qa.mode;
    const expectedMode = verification.browserRequired ? 'browser' : 'stack';
    if (declared && declared !== expectedMode) {
      return result(ctx, 'FAIL', `The case declares qa.mode=\`${declared}\` but the published contract has uiImpact=\`${verification.uiImpact}\` / browserRequired=${verification.browserRequired}, which needs \`${expectedMode}\`.`, {
        expected: expectedMode,
        actual: declared,
      });
    }

    return result(ctx, 'PASS', `Run ${runId}: architecture=${architecture.contractHash.slice(0, 12)} verification=${verification.contractHash.slice(0, 12)} assignments=${assignments.assignmentsHash.slice(0, 12)}, settlement=active, bootstraps=[${roles.join(', ')}], baseline=git-head, uiImpact=${verification.uiImpact}, requiredChecks=[${verification.requiredChecks.join(', ')}].`);
  },
};
