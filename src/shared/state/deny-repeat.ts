// src/shared/state/deny-repeat.ts
// How many times THIS run has refused THIS write for THIS reason.
//
// Gates are pure functions of on-disk state, so an identical retry draws an
// identical deny forever: nothing counts, nothing backs off, nothing escalates.
// Measured in 17cl: 25 denies, 15 of them repeats of four (file, reason) pairs —
// one of them refused SEVEN times over 25 minutes on the same file, ending in a
// full replan for a one-line fix the deny text had already named. Every retry is
// a whole agent turn.
//
// The counter deliberately does NOT block. A hard cap here would strand runs
// whose next attempt was about to succeed, and the honest failure path already
// exists: report BLOCKED, or hand the finding to the role that owns the path.
// What was missing is the agent ever being TOLD it is looping.
//
// Consulted at the CHOKEPOINT — core/pipeline.ts's deny exits, the one place
// every refusal from every gate passes through — and nowhere else. It used to be
// wired into a single call site (plan-guard's plan-write aggregator) with the
// chokepoint uninstrumented, so ~120 other gates could draw an identical
// refusal forever in silence, which is the same failure the counter exists to
// name, one level up. This is the reasoning that already put the consent fence
// in fsjson.ts and the write log in state-write-log.ts: a per-call-site rule is
// one every future gate author has to remember, and forgetting it is silent.

import * as path from 'path';

import { isEscalatableDenyId } from '../../config/deny-ids';
import { readJson, writeJson } from '../fsjson';
import { isNonProjectRoot } from '../authoring-root';
import { safePathSegment } from './run-agent/run-paths';

/** Identical refusals before the deny starts saying so. */
export const DENY_REPEAT_ESCALATE_AT = 3;

// Bounded so a pathological run cannot grow this without limit; the tail is what
// matters and old keys are not worth carrying.
const MAX_TRACKED_KEYS = 64;

type Counts = Record<string, number>;

// `safePathSegment`, like every other `runs/<id>/` path this codebase builds
// (run-agent/run-paths.ts's runDir, decision-log.ts's log dir). This one used the
// run id RAW, and the id is read back off `.traffic-one/.one.json` — a file a
// cloned repo ships — so a `currentRunId` carrying `../..` addressed a path
// outside the state dir entirely, where the write fence (which resolves the
// project root from the FIRST `.traffic-one` segment) no longer recognises it as
// project state and lets it through.
function repeatsPath(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', safePathSegment(runId), 'debug', 'deny-repeats.json');
}

/**
 * A stable identity for "the same refusal" — the WHOLE message, byte for byte.
 *
 * Deliberately the strictest possible reading, arrived at by discarding two
 * looser ones that live evidence killed:
 *
 * An 80-char prefix (the first attempt) cannot see the subject. `filePath` is
 * the file being WRITTEN — for a completion gate that is the digest, the same
 * string on every attempt — while the file the deny is ABOUT appears inside the
 * message, and the collapse gate's prose does not reach it until char 77. Two
 * different collapsed files signed identically.
 *
 * Normalizing digits (the second attempt) cannot see position. Observed 16co:
 * `LessonPage.tsx:57` then `LessonPage.tsx:76` — one agent clearing collapse a
 * line at a time, which is progress on a real defect, and normalization merged
 * them into one count. Escalation exists to break loops; firing it at an agent
 * that is converging is worse than never firing it at all.
 *
 * So: a refusal is "the same" only when it is textually identical. That is
 * precisely 17cl's shape — seven byte-identical refusals of one file over 25
 * minutes. The cost is that a deny embedding a genuinely volatile detail (a
 * scanned-file count) may never escalate, and that is the right trade: a missed
 * escalation costs a replan the run was already heading for, while a false one
 * tells a working agent to report BLOCKED.
 *
 * Sorted so two gates firing in either order are one signature.
 */
export function denySignature(filePath: string, violations: readonly string[]): string {
  const reasons = [...violations]
    .map((violation) => violation.replace(/\s+/g, ' ').trim())
    .sort()
    .join('|');
  return `${filePath || '(shell)'}::${reasons}`;
}

/**
 * Record one refusal and return how many times it has now happened in this run.
 * Best-effort: a diagnostic that throws must never change a gate's verdict.
 *
 * The counter file is `runs/<id>/debug/deny-repeats.json` — the sibling of the
 * decision log — so writeJson's consent fence refuses it while the use-plugin
 * question is unanswered. The count then stays at 1, which is below
 * DENY_REPEAT_ESCALATE_AT: pre-consent denies read exactly as they did before
 * this counter existed, and the project stays byte-identical.
 *
 * The count also becomes the decision log's `repeatCount`. It is RETURNED for
 * that rather than announced through a module-level slot, which is what this
 * used to do: the count was computed deep inside one gate's call stack, so it
 * had to reach core/pipeline.ts out of band. With the counter running AT the
 * pipeline's deny exit, the site that computes the number is the site that
 * builds the record, and the slot had no sender left — see this file's header
 * and the parameter core/pipeline.ts's recordDecision now takes.
 */
export function recordDenyRepeat(
  cwd: string,
  runId: string | null | undefined,
  signature: string,
): number {
  return countDenyRepeat(cwd, runId, signature);
}

function countDenyRepeat(
  cwd: string,
  runId: string | null | undefined,
  signature: string,
): number {
  if (!runId || isNonProjectRoot(cwd)) return 1;
  const file = repeatsPath(cwd, runId);
  try {
    const counts = readJson<Counts>(file, {} as Counts) || {};
    const next = (typeof counts[signature] === 'number' ? counts[signature] : 0) + 1;
    counts[signature] = next;
    const keys = Object.keys(counts);
    if (keys.length > MAX_TRACKED_KEYS) {
      // Drop the coldest half; the loop we care about is always among the hottest.
      const ranked = keys.sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
      const kept: Counts = {};
      for (const key of ranked.slice(0, MAX_TRACKED_KEYS / 2)) kept[key] = counts[key] as number;
      kept[signature] = next;
      return writeJson(file, kept) ? next : 1;
    }
    // A count that did not PERSIST is not a count, and the number it would
    // otherwise report is not ours: the base comes from reading the file, reads
    // follow symlinks (deliberately), and this number decides whether the agent is
    // told to STOP RETRYING and report BLOCKED. A `deny-repeats.json` shipped as a
    // link to a file claiming 9999 escalates the first deny of the run — against
    // an agent that is working correctly — while the write that would have made
    // the count ours is refused. So escalate only on a count we actually wrote.
    //
    // `1` is also exactly what a pre-consent deny reported before this counter
    // existed, and it is below DENY_REPEAT_ESCALATE_AT, so that deny reads as it
    // always did. (With the fence closed nothing persists AND nothing reads back,
    // so both spellings return 1 there — this branch earns its keep on the
    // partially-persisted and planted-file cases, not on that one.)
    //
    // Asking projectStateWritable() FIRST is what this used to do, so that a
    // refused write was never described as a successful one; writeJson reporting
    // its own outcome — to the caller here, and to the decision log from inside
    // the chokepoint — replaces both halves of that, and unlike the pre-check it
    // also covers a refusal the fence itself did not make.
    return writeJson(file, counts) ? next : 1;
  } catch {
    // The write's own failure is already recorded by the chokepoint, with the
    // real errno; a diagnostic counter must never throw into a gate's verdict.
    return 1;
  }
}

/**
 * The paragraph appended to a deny that has now fired `count` times unchanged.
 * Empty below the threshold, so an ordinary first or second attempt reads exactly
 * as it does today.
 */
export function denyRepeatEscalation(count: number, filePath: string): string {
  if (count < DENY_REPEAT_ESCALATE_AT) return '';
  const target = filePath || 'this target';
  return `\n\nSTOP RETRYING — this run has now refused \`${target}\` ${count} times for the same reason, and each attempt costs a full turn. Re-issuing it again will produce this identical message. Do exactly one of: (a) apply the remedy above literally, in full, and only then re-issue; (b) if the remedy names a path or file your work unit does not own, report it in your digest and let the orchestrator route it to the role that owns it; (c) if you cannot satisfy it at all, write your digest with verdict \`BLOCKED <one-line reason>\` naming this refusal. A repeated identical attempt is not one of the options.`;
}

// ── the chokepoint entry point ───────────────────────────────────────────────

/** The fields of a stamped deny this counter reads. Deliberately structural
 *  rather than `HookResult`: shared/ does not depend on core/ for a shape this
 *  small, and it keeps the counter callable from a test without a pipeline. */
export interface DenyRepeatInput {
  readonly reason: string;
  readonly denyTarget?: string;
  readonly denyId?: string;
  readonly askUser?: boolean;
}

export interface DenyRepeat {
  /** How many times this refusal has now fired, or null when it is not tracked
   *  at all (see denyRepeatCounted). Null, not 0 or 1: "no count exists" and
   *  "the count is 1" are different facts to an operator reading the decision
   *  log, and only the first one means "this id is excluded by policy". */
  readonly count: number | null;
  /** Appended to the deny's reason. '' below the threshold and for anything
   *  untracked, so those refusals stay byte-identical to today's text. */
  readonly suffix: string;
}

const UNTRACKED: DenyRepeat = { count: null, suffix: '' };

/**
 * Is this refusal one an agent could break out of by ACTING? Only those are
 * counted — see NEVER_ESCALATED_DENY_IDS (config/deny-ids.ts) for the rule and
 * for why it is not the never-overridable list.
 *
 * Excluded refusals are not counted at ALL, not merely left un-escalated. The
 * counter tracks at most MAX_TRACKED_KEYS signatures and evicts the coldest
 * half when it overflows, so a run that spends forty turns waiting on a human
 * would otherwise fill the table with the one refusal that is behaving
 * correctly and evict the loop this exists to catch. It also keeps a waiting
 * project free of a write per turn.
 */
export function denyRepeatCounted(deny: DenyRepeatInput): boolean {
  // Both spellings of an approval prompt, exactly as core/pipeline.ts's
  // stampDeny already treats it: the id names the prompt class, `askUser` is the
  // structural signal, and core/result.ts sets them together.
  if (deny.askUser) return false;
  return isEscalatableDenyId(deny.denyId);
}

/**
 * Count one refusal at the chokepoint and hand back the paragraph it earns.
 *
 * The signature is the deny's own RENDERED reason, byte for byte — the same
 * strictest-possible reading denySignature was built for, now reading the whole
 * message instead of the violation list one gate happened to assemble. That is
 * strictly MORE discriminating than the per-gate key it replaces (the violations
 * are inside the reason, and `denyTarget` carries the subject the reason may not
 * name), and it adds nothing volatile: `gateId`/`denyId` are deliberately NOT in
 * the key, because both are coarser than the message and can only SPLIT counts
 * that identical text says are one loop. Identical text is also all the agent
 * can see, and whose loop this is measures.
 *
 * MUST be called with the deny's reason BEFORE the pipeline stamps its suffixes
 * on it. The correlation ref carries a hook sequence number and a pid, so
 * signing a stamped reason would make every refusal unique and nothing would
 * ever reach 2 — and this function's own escalation is part of that same suffix
 * chain, so signing it would reset the count at exactly the attempt that
 * escalated.
 */
export function denyRepeat(
  cwd: string,
  runId: string | null | undefined,
  deny: DenyRepeatInput,
): DenyRepeat {
  if (!denyRepeatCounted(deny)) return UNTRACKED;
  const target = deny.denyTarget || '';
  const count = recordDenyRepeat(cwd, runId, denySignature(target, [deny.reason]));
  return { count, suffix: denyRepeatEscalation(count, target) };
}
