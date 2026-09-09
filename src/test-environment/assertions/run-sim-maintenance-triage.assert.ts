// run-sim-maintenance-triage: post-build follow-ups route correctly.
//
// The maintenance phase is where an existing codebase lives its whole life, and
// its routing is a COMPOSITION: prompt classification, the unresolved-run
// directive, claim suppression, per-prompt run rotation, the frozen model
// policy, and the bounded WorkUnit write path all have to agree. Each is unit
// tested; this asserts the recorded evidence of the real chain — the driver
// already fails hard on a mismatch, so this re-validates the transcript facts
// (defense against the driver itself going quiet) and pins the deny prose of
// the fail-closed rows the way run-sim-negative-gates does for build gates.

import * as fs from 'fs';
import * as path from 'path';

import type { Assertion } from '../core/types';
import { readRunSimTranscript, rec, result, runSimIncomplete, str } from './util';

interface LegRow {
  ordinal?: unknown;
  kind?: unknown;
  prompt?: unknown;
  expectedRouting?: unknown;
  routing?: unknown;
  expectedTier?: unknown;
  tier?: unknown;
  runIdBefore?: unknown;
  runIdAfter?: unknown;
  rotated?: unknown;
  modelPolicyFrozen?: unknown;
  settlementStatus?: unknown;
}

export const assertion: Assertion = {
  id: 'run-sim-maintenance-triage',
  title: 'Maintenance triage routes every follow-up shape correctly',
  appliesTo: (c) => c.layer === 'run-sim' && (c.runSim?.maintenance ?? []).length > 0,
  run: (ctx) => {
    const transcript = readRunSimTranscript(ctx);
    if (!transcript) return result(ctx, 'FAIL', 'No run-sim transcript was persisted.');
    // The legs run last of all, so a toolchain block in the main QA phase means
    // they never happened — nothing to judge either way.
    if (transcript.ok !== true) {
      return runSimIncomplete(ctx, transcript, 'The simulated run did not complete');
    }

    const declared = ctx.testCase.runSim?.maintenance ?? [];
    const facts = rec(transcript.facts);
    const legs = Array.isArray(facts.maintenanceLegs) ? (facts.maintenanceLegs as LegRow[]) : [];
    if (legs.length !== declared.length) {
      return result(ctx, 'FAIL', `The case declares ${declared.length} maintenance leg(s) but the transcript recorded ${legs.length} — the driver skipped legs, so nothing past the gap was proven.`, {
        expected: declared.length,
        actual: legs.length,
      });
    }

    // 1 — routing, classifier hint, and rotation invariants per prompt leg.
    for (const leg of legs) {
      if (leg.kind !== 'prompt') continue;
      const name = `leg ${String(leg.ordinal)} ("${str(leg.prompt) ?? ''}")`;
      if (leg.routing !== leg.expectedRouting) {
        return result(ctx, 'FAIL', `${name} routed as '${String(leg.routing)}', expected '${String(leg.expectedRouting)}'.`, {
          expected: leg.expectedRouting,
          actual: leg.routing,
        });
      }
      if (leg.expectedTier && leg.tier !== leg.expectedTier) {
        return result(ctx, 'FAIL', `${name} classifier hinted '${String(leg.tier)}', expected '${String(leg.expectedTier)}'.`, {
          expected: leg.expectedTier,
          actual: leg.tier,
        });
      }
      const rotated = leg.rotated === true;
      if (leg.routing === 'triage' && !rotated) {
        return result(ctx, 'FAIL', `${name} was triage-routed but did not rotate the run id — per-prompt maintenance runs regressed.`);
      }
      if (leg.routing !== 'triage' && rotated) {
        return result(ctx, 'FAIL', `${name} rotated the run id on a '${String(leg.routing)}' prompt — only triage may rotate.`);
      }
      if (leg.routing === 'triage' && leg.modelPolicyFrozen !== true) {
        return result(ctx, 'FAIL', `${name} rotated to run ${String(leg.runIdAfter)} without a frozen model policy — the first followup to a retained thread would be denied (the 11c regression).`);
      }
      if (leg.routing === 'unresolved' && leg.runIdBefore !== leg.runIdAfter) {
        return result(ctx, 'FAIL', `${name} was unresolved-routed but currentRunId moved ${String(leg.runIdBefore)} → ${String(leg.runIdAfter)} — the nonterminal run was not preserved.`);
      }
    }

    // 2 — the fail-closed rows actually pinned their gates. applyAll now
    // rejects crash-denies and unnamed handlers; the PROSE match still lives
    // here, exactly like run-sim-negative-gates (which does not run for cases
    // without negativeGates), scoped to the leg phases.
    const writes = (Array.isArray(transcript.writes) ? transcript.writes : []).map((row) => rec(row));
    const legRows = writes.filter((row) => String(row.phase ?? '').startsWith('leg-'));
    if (legRows.length === 0 && declared.some((leg) => leg.kind !== 'prompt' || leg.quickFix || leg.boundedRole)) {
      return result(ctx, 'FAIL', 'The maintenance legs recorded no gate-checked writes, so the bounded write path was never exercised.');
    }
    const expectedDenies = legRows.filter((row) => row.expected === true);
    for (const row of expectedDenies) {
      if (row.denied !== true) {
        return result(ctx, 'FAIL', `Fail-closed probe ${String(row.path)} was ALLOWED — the maintenance write protection went quiet.`, {
          expected: 'denied',
          actual: String(row.path),
        });
      }
      if (str(row.denyId) === 'pipeline-handler-crashed') {
        return result(ctx, 'FAIL', `Fail-closed probe ${String(row.path)} was refused by pipeline-handler-crashed (handler ${str(row.gateId) || 'unnamed'}) — a runtime crash must not read as correct enforcement.`, {
          expected: 'named handler deny, not pipeline-handler-crashed',
          actual: str(row.denyId),
        });
      }
      if (!str(row.gateId)) {
        return result(ctx, 'FAIL', `Fail-closed probe ${String(row.path)} was denied without naming the producing handler.`, {
          expected: 'gateId',
          actual: str(row.gateId),
        });
      }
      const expectedHandler = str(row.expectHandler);
      if (expectedHandler && str(row.gateId) !== expectedHandler) {
        return result(ctx, 'FAIL', `Fail-closed probe ${String(row.path)} was refused by ${str(row.gateId)}, not the handler this row names (${expectedHandler}).`, {
          expected: expectedHandler,
          actual: str(row.gateId),
        });
      }
      const needle = str(row.denyMatch);
      if (needle && !String(row.reason ?? '').includes(needle)) {
        return result(ctx, 'FAIL', `A different gate refused ${String(row.path)} than the one this probe covers. Expected the deny to mention "${needle}"; it said:\n\n${String(row.reason ?? '').slice(0, 400)}`, {
          expected: needle,
          actual: String(row.reason ?? '').slice(0, 200),
        });
      }
    }

    // 3 — the worker report contract: every triage leg that drove a quick-fix
    // left its digest with an unambiguous IMPLEMENTED verdict in ITS run.
    const quickFixLegOrdinals = declared
      .map((leg, index) => (leg.kind === 'prompt' && leg.quickFix ? index + 1 : null))
      .filter((ordinal): ordinal is number => ordinal !== null);
    for (const ordinal of quickFixLegOrdinals) {
      const leg = legs[ordinal - 1];
      const runId = leg ? str(leg.runIdAfter) : null;
      if (!runId) return result(ctx, 'FAIL', `Quick-fix leg ${ordinal} recorded no run id.`);
      const digest = path.join(ctx.cwd, '.traffic-one', 'digests', runId, 'quick-fix.md');
      if (!fs.existsSync(digest)) {
        return result(ctx, 'FAIL', `Quick-fix leg ${ordinal} left no digest at .traffic-one/digests/${runId}/quick-fix.md — the worker's report contract was not honored.`);
      }
      if (!/verdict: IMPLEMENTED/.test(fs.readFileSync(digest, 'utf8'))) {
        return result(ctx, 'FAIL', `The quick-fix digest for run ${runId} does not carry 'verdict: IMPLEMENTED'.`);
      }
    }

    // 4 — a resolved open run settled for real.
    for (const leg of legs) {
      if (leg.kind !== 'resolve-run') continue;
      if (leg.settlementStatus !== 'verified') {
        return result(ctx, 'FAIL', `The resolve-run leg settled as '${String(leg.settlementStatus)}', expected 'verified'.`, {
          expected: 'verified',
          actual: leg.settlementStatus,
        });
      }
    }

    const promptLegs = legs.filter((leg) => leg.kind === 'prompt').length;
    const denies = expectedDenies.length;
    return result(ctx, 'PASS', `${legs.length} maintenance leg(s) (${promptLegs} prompts) routed exactly as declared — rotation, classifier hints, unresolved-run preservation, and frozen model policies all held; ${denies} fail-closed probe(s) refused by the gate that owns each; quick-fix digests carry IMPLEMENTED.`);
  },
};
