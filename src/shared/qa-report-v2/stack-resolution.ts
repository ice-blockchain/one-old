// src/shared/qa-report-v2/stack-resolution.ts
// What the RUNNER resolved, recorded where the report's author cannot reach.
//
// The exemption `validateQaReportV2` grants for a stack check with no command
// is the only route by which a run settles verified with zero test evidence, so
// the question "was a command declared?" is the highest-value fact in this
// system to be wrong about. Round 6 moved that fact out of the check's PROSE and
// into a `notApplicable` reason field, which fixed the producer's
// self-consistency — three arms writing one sentence for two incompatible
// reasons — and did not change who gets to assert it.
//
// `report-v2.json` lives at `.traffic-one/reports/qa/<runId>/report-v2.json`,
// which `artifactContract` attributes to the `senior-tester` role
// (plan-readiness/contracts.ts) and which no runtime-sidecar fence covers. The
// agent that authors that file therefore owns the field that grants the
// exemption. Driven end to end on a contract-compiled Node api-only project
// whose `npm test` exits 127: an honest run settles `failed /
// required-check-failed / failed`, and editing three fields of the sidecar by
// hand — `notApplicable` to `no-command-declared`, drop the persisted `gates`,
// `status` to `passed` — settles it green. Prose was author-writable; the field
// was author-writable; they sat in the same author-writable file.
//
// THIS FILE IS THE OTHER HALF: the runner writes what it resolved into
// `.traffic-one/runs/<runId>/`, which `runtimeOwnedRunSidecar` refuses to every
// agent, child and parent outright — the same fence that protects the machine
// evidence a browser contract's exemptions already rest on. The validator reads
// it and grants the exemption only when the runner AND the report agree. A
// forged reason now has to be accompanied by a file the forger cannot write.
//
// WHY NOT RE-DERIVE IN THE VALIDATOR, which is the obvious alternative and was
// the first thing tried. `resolveStackCommand` is pure filesystem inspection and
// the validator holds `projectRoot`, so re-running it there looks free. It is
// not sound: the producer resolves at `serverCwd` when one was passed
// (`stack.ts`'s `runStackCheck`, and `withExecutedStackChecks` on the browser
// path), `serverCwd` is a CLI argument that appears in neither the contract nor
// the report, and `resolveStackCommand` reads ONLY the cwd it is handed — it
// walks no ancestors. So a validator re-deriving at `projectRoot` would resolve
// the ROOT manifest's `scripts.test` for a run whose served package genuinely
// declares none, refuse an honest exemption, and make the ordinary monorepo
// unsettleable. Recovering the cwd from the report puts the answer back in the
// author's hands, which is the defect. Recording the OUTCOME at the moment of
// resolution needs no cwd reconstruction at all, and is the only form of this
// that is both sound and unforgeable.

import * as path from 'path';

import { readJson, writeJson } from '../fsjson';

import { isRecord } from './schema';

const QA_STACK_RESOLUTION_SCHEMA_VERSION = 1 as const;

/**
 * What the runner found when it asked the project for one command.
 *
 * Two values, deliberately, and neither of them is the reason enum: this file
 * answers the single question the exemption turns on — "was there anything to
 * run?" — and widening it to mirror `QA_NOT_APPLICABLE_REASONS` would make the
 * runner's record a second, independently-driftable copy of the report's
 * classification rather than the evidence underneath it.
 */
export type QaStackResolutionOutcome = 'no-command-declared' | 'declared';

export interface QaStackResolutionV1 {
  schemaVersion: typeof QA_STACK_RESOLUTION_SCHEMA_VERSION;
  runId: string;
  /** Check id -> what `resolveStackCommand` answered for it, in this run. */
  resolved: Record<string, QaStackResolutionOutcome>;
}

export function qaStackResolutionPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'runs', runId, 'qa-stack-resolution-v1.json');
}

function parse(value: unknown, runId: string): QaStackResolutionV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== QA_STACK_RESOLUTION_SCHEMA_VERSION
    || value.runId !== runId
    || !isRecord(value.resolved)) return null;
  const resolved: Record<string, QaStackResolutionOutcome> = {};
  for (const [id, outcome] of Object.entries(value.resolved)) {
    if (outcome !== 'no-command-declared' && outcome !== 'declared') return null;
    resolved[id] = outcome;
  }
  return { schemaVersion: QA_STACK_RESOLUTION_SCHEMA_VERSION, runId, resolved };
}

export function readStackResolution(projectRoot: string, runId: string): QaStackResolutionV1 | null {
  return parse(readJson<unknown>(qaStackResolutionPath(projectRoot, runId), null), runId);
}

/**
 * Record what this run resolved, MERGING with what it recorded earlier.
 *
 * Merged rather than replaced because two call sites contribute to one run: the
 * `stack` command resolves every required id in one pass, while the browser path
 * resolves only `SUBSTITUTED_STACK_CHECK_IDS` through `withExecutedStackChecks`.
 * A replace would have the second write erase the first's ids, and an erased id
 * reads exactly like a forged one — fail-closed, but on an honest run.
 *
 * The merge reads a file only this runtime can write, so it is not a trust
 * widening: the fence that keeps an agent out of `.traffic-one/runs/<runId>/`
 * is the same one for the read as for the write, and a payload that does not
 * parse is discarded rather than merged into.
 *
 * Returns whether the record is on disk. A refused write (an unanswered consent
 * question, a planted symlink) leaves no record, and the validator then refuses
 * every exemption for this run — the same fail-closed direction as an absent
 * file, and the runner reports it the same way it reports a refused report
 * write.
 */
export function recordStackResolution(
  projectRoot: string,
  runId: string,
  resolved: Readonly<Record<string, QaStackResolutionOutcome>>,
): boolean {
  const existing = readStackResolution(projectRoot, runId);
  const record: QaStackResolutionV1 = {
    schemaVersion: QA_STACK_RESOLUTION_SCHEMA_VERSION,
    runId,
    resolved: { ...(existing?.resolved || {}), ...resolved },
  };
  return writeJson(qaStackResolutionPath(projectRoot, runId), record);
}

/**
 * Did THE RUNNER find no command for this check, in this run?
 *
 * Absence is `false`, and that is the fail-closed direction with a cost worth
 * naming: a report published by a runner older than this file carries no record,
 * so a genuinely command-less project stops being exempt until it is re-run with
 * a current runner. That is a version-upgrade window, it is self-healing on the
 * next sweep, and the deny prose names the runner to invoke. The alternative —
 * treating an absent record as corroboration — would make the whole binding
 * optional to anyone who can delete a file, which is the property the fence
 * exists to deny.
 */
export function stackCommandUndeclared(
  projectRoot: string,
  runId: string,
  checkId: string,
): boolean {
  return readStackResolution(projectRoot, runId)?.resolved[checkId] === 'no-command-declared';
}
