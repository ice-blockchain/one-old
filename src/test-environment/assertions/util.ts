// src/test-environment/assertions/util.ts
// Small shared helpers for assertions: authentic effective-state reads (reusing
// the real source merge) and strict-safe accessors over unknown JSON.

import * as fs from 'fs';
import * as path from 'path';

import { obj, type Rec } from '../../shared/obj';
import { readEffectiveState } from '../../shared/state/local-prefs';
import type { AssertionContext, AssertionResult, AssertionStatus, HostRunStatus } from '../core/types';

// A host run "produced work" if it ran the agent at all — COMPLETED, or TIMEOUT
// (killed mid-flight but the partial project/state is real evidence). ERROR
// (e.g. 401), SKIPPED, and NOT_RUN produced nothing to inspect.
export function hostProducedWork(status: HostRunStatus): boolean {
  return status === 'COMPLETED' || status === 'TIMEOUT';
}

const IGNORE_DIRS = new Set(['node_modules', '.git', '.traffic-one']);

// True if `rel` exists at the project root, OR a file with the same basename
// exists anywhere in the tree (so an `src/App.tsx` expectation matches the
// plugin's `apps/web/src/App.tsx` monorepo layout). Bounded walk.
export function projectHasFile(root: string, rel: string): boolean {
  if (fs.existsSync(path.join(root, rel))) return true;
  const target = path.basename(rel);
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 7) return false;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        if (walk(path.join(dir, e.name), depth + 1)) return true;
      } else if (e.name === target) {
        return true;
      }
    }
    return false;
  };
  return walk(root, 0);
}

export function effState(ctx: AssertionContext): Rec {
  return readEffectiveState(ctx.cwd, ctx.env);
}

// The run-sim transcript for this case, or null for any other layer. Read from
// ctx.caseFolder rather than resolved off cwd so `--reassert` works identically.
export function readRunSimTranscript(ctx: AssertionContext): Rec | null {
  if (ctx.testCase.layer !== 'run-sim') return null;
  return readJsonFile(path.join(ctx.caseFolder, 'run-sim.json'));
}

// The consent sidecars the case runner persisted (core/consent.ts,
// core/decline-sim.ts). Read from ctx.caseFolder, like the run-sim transcript, so
// `--reassert` re-evaluates the same recorded facts instead of re-deriving them.
export function readCaseConsent(ctx: AssertionContext): Rec | null {
  return readJsonFile(path.join(ctx.caseFolder, 'consent.json'));
}

/**
 * The consent sidecar for ONE member of a workspace case.
 *
 * Kept per member rather than folded into the case-wide one because consent is
 * an answer about a PROJECT: production's write fence
 * (shared/state/plugin-use.ts) is default-closed per project root, so three
 * members are three questions and three answers. A single record would let two
 * members ride on a third's yes.
 */
export function readMemberConsent(ctx: AssertionContext, memberId: string): Rec | null {
  return readJsonFile(path.join(ctx.caseFolder, 'members', memberId, 'consent.json'));
}

export function readDeclineProbe(ctx: AssertionContext): Rec | null {
  return readJsonFile(path.join(ctx.caseFolder, 'decline-probe.json'));
}

/**
 * The blocker text when a run stopped because a TOOLCHAIN was missing, or null
 * when it stopped for any other reason.
 *
 * AGENTS.md has always said `test:env --strict` reports a missing toolchain as
 * INCONCLUSIVE rather than passing, and the browser half never did: with no
 * project-local Playwright the QA runner correctly published
 * `status: "blocked-environment"`, the phase machine recorded that as a run
 * failure, and 48 assertions reported a PRODUCT failure for a browser this
 * machine does not have. The harness could not tell "the answer is no" from
 * "I could not look".
 *
 * Keyed off `environmentBlock`, which the phase machine sets only from the
 * product's OWN `blocked-environment` verdict — never from a heuristic on the
 * failure text — so a real red check can never be laundered into a gap.
 */
export function runSimEnvironmentBlock(transcript: Rec | null): string | null {
  if (!transcript || transcript.ok === true) return null;
  const blocker = str(transcript.environmentBlock);
  return blocker && blocker.trim() ? blocker : null;
}

/**
 * The verdict for "the simulated run did not complete": INCONCLUSIVE when a
 * missing toolchain stopped it, FAIL for every other cause.
 *
 * Called at the END of each run-sim assertion's own checks, never at the start,
 * so a genuine product failure the assertion can still see — a false deny, a gate
 * that went quiet — is reported as FAIL even in a toolchain-blocked run. Nothing
 * is laundered: INCONCLUSIVE is not a pass, and result-policy keeps `--strict`
 * failing the release verdict on it.
 */
export function runSimIncomplete(
  ctx: AssertionContext,
  transcript: Rec | null,
  lead: string,
): AssertionResult {
  const blocker = runSimEnvironmentBlock(transcript);
  const failure = str(transcript?.failure) || 'unknown failure';
  if (blocker) {
    return result(ctx, 'INCONCLUSIVE', `${lead}, because a required toolchain is unavailable on this machine: ${blocker}. This is an environment gap, not a product verdict — install the toolchain and re-run to get a real answer.`);
  }
  return result(ctx, 'FAIL', `${lead}: ${failure}`);
}

export function runSimPhaseDone(transcript: Rec | null, phase: string): boolean {
  const phases = transcript && Array.isArray(transcript.phasesCompleted) ? transcript.phasesCompleted : [];
  return phases.some((entry) => String(entry) === phase);
}

/**
 * The early-exit verdict for an assertion whose run did not complete, or null
 * when the assertion should carry on and judge its subject for real.
 *
 * `needs` names the phase this assertion's evidence comes from. A toolchain block
 * in a LATER phase leaves that evidence complete and readable, and answering
 * INCONCLUSIVE about something already on disk would be the same inversion in
 * reverse — claiming "I could not look" at evidence that is right there. So the
 * assertion continues in exactly that case, and only in it:
 *   - failed for any non-environment reason  → FAIL, unchanged;
 *   - toolchain-blocked, `needs` not reached → INCONCLUSIVE;
 *   - toolchain-blocked, `needs` reached     → judge it.
 */
export function runSimStop(
  ctx: AssertionContext,
  transcript: Rec | null,
  lead: string,
  needs?: string,
): AssertionResult | null {
  if (transcript?.ok === true) return null;
  const blocker = runSimEnvironmentBlock(transcript);
  if (blocker && needs && runSimPhaseDone(transcript, needs)) return null;
  return runSimIncomplete(ctx, transcript, lead);
}

// A case "produced work" if a host ran the agent, OR if a run-sim executed. The
// run-sim arm matters because its target is 'pure-node' and its hostResult is
// synthesized — without this, every hostProducedWork-gated assertion would SKIP,
// which result-policy escalates to a strict-mode failure.
export function producedWork(ctx: AssertionContext): boolean {
  if (ctx.testCase.layer === 'run-sim') return Boolean(readRunSimTranscript(ctx));
  return hostProducedWork(ctx.hostResult.status);
}

export function rec(value: unknown): Rec {
  return obj(value) ?? {};
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function result(
  ctx: AssertionContext,
  status: AssertionStatus,
  detail: string,
  extra?: { expected?: unknown; actual?: unknown },
): AssertionResult {
  return {
    id: ctx.spec.id,
    title: '', // filled by case-runner from the Assertion definition
    status,
    detail,
    expected: extra?.expected,
    actual: extra?.actual,
  };
}

export function readJsonFile(file: string): Rec | null {
  try {
    if (!fs.existsSync(file)) return null;
    return obj(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

// Newest run id from .traffic-one/runs + /digests (or state.currentRunId).
export function latestRunId(cwd: string, state: Rec): string | null {
  const explicit = str(state.currentRunId);
  if (explicit) return explicit;
  const candidates = new Set<string>();
  for (const sub of ['runs', 'digests']) {
    const dir = path.join(cwd, '.traffic-one', sub);
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/^\d+$/.test(name)) candidates.add(name);
      }
    } catch { /* dir absent */ }
  }
  const sorted = [...candidates].sort((a, b) => Number(b) - Number(a));
  return sorted[0] ?? null;
}
