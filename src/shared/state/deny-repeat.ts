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

import * as fs from 'fs';
import * as path from 'path';

import { readJson, writeJson } from '../fsjson';
import { isNonProjectRoot } from '../authoring-root';

/** Identical refusals before the deny starts saying so. */
export const DENY_REPEAT_ESCALATE_AT = 3;

// Bounded so a pathological run cannot grow this without limit; the tail is what
// matters and old keys are not worth carrying.
const MAX_TRACKED_KEYS = 64;

type Counts = Record<string, number>;

function repeatsPath(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, 'debug', 'deny-repeats.json');
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
 */
export function recordDenyRepeat(
  cwd: string,
  runId: string | null | undefined,
  signature: string,
): number {
  if (!runId || isNonProjectRoot(cwd)) return 1;
  try {
    const file = repeatsPath(cwd, runId);
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
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJson(file, kept);
      return next;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, counts);
    return next;
  } catch {
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
