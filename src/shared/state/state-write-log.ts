// src/shared/state/state-write-log.ts
// A tiny per-hook-invocation collector so a state mutation deep inside a
// gate's own call stack can announce its outcome to the decision log
// (decision-log.ts) without threading a parameter through every write path.
//
// One hook invocation is one Node process running exactly one
// `runPipeline()` call (see core/pipeline.ts), so a module-level buffer is
// safe: the pipeline drains it — ONCE, at the very end of every
// `runPipeline()` call, whichever exit path it takes — and the next
// invocation (a fresh process, or the next call within one long-lived test
// process) starts with an empty buffer. The drain therefore has to sit OUTSIDE
// anything conditional: it lived inside the decision-log record builder once,
// which `runPipeline` calls only when logging is on, so a T1_DECISION_LOG=false
// install never emptied it and one invocation's writes stayed visible to the
// next. It is `settle()` in core/pipeline.ts now, on every exit path.
//
// Wired in at the CHOKEPOINT and nowhere else: shared/fsjson.ts's guarded
// primitives, which nearly all of shared/state/** and every materialization
// write through. It used to be wired into two call sites instead
// (deny-repeat.ts, claim-capture.ts) with the chokepoint uninstrumented, which
// left every consent-fence refusal — precisely the event `stateWrites` exists to
// explain — unrecorded. Those two now say nothing of their own: the chokepoint
// reports the same path with the same outcome, so a second record only ever
// meant one write described twice. Instrumenting here rather than per call site
// is the same reasoning that put the fence here — a per-call-site rule is one
// every future writer has to remember, and forgetting it is silent.

export interface StateWriteRecord {
  readonly path: string;
  readonly op: string;
  readonly ok: boolean;
  /** Symbolic, never numeric: a real failure carries the fs `.code` (ENOENT,
   *  EACCES, ELOOP, …), a refusal carries fsjson.ts's reason (`consent-fence`,
   *  `symlink`, `escapes-state-dir`). */
  readonly errno?: string;
}

// Bounded so a pathological handler (a write loop within one hook call)
// cannot make the eventual decision record unbounded. appendDecision (in
// decision-log.ts) applies its own independent bound too, defensively.
const MAX_BUFFERED_WRITES = 64;

let buffer: StateWriteRecord[] = [];

/**
 * Record never throws: a collector failure must never surface as a gate failure.
 *
 * A FULL buffer still accepts a failure, by evicting the oldest success. Once
 * the chokepoint is instrumented the bound is genuinely reachable — one
 * materialization is ~190 state writes in a single hook call — and a plain
 * "drop everything past 64" filled it with successes and threw away the
 * refusals, which is the exact opposite of what this collector is for. A run's
 * successful writes are also evident from the tree it produced; a refusal is
 * evident nowhere else.
 */
export function recordStateWrite(entry: StateWriteRecord): void {
  try {
    if (buffer.length >= MAX_BUFFERED_WRITES) {
      if (entry.ok) return;
      const oldestSuccess = buffer.findIndex((record) => record.ok);
      if (oldestSuccess < 0) return; // nothing but failures already — keep the earliest
      buffer.splice(oldestSuccess, 1);
    }
    buffer.push(entry);
  } catch {
    // never let telemetry break the write it is describing
  }
}

/** Return and clear everything recorded since the last drain. */
export function drainStateWrites(): StateWriteRecord[] {
  const out = buffer;
  buffer = [];
  return out;
}

// This module used to carry a SECOND channel beside the write buffer: a
// module-level single slot holding the deny-repeat count, because that number was
// computed deep inside one gate's call stack and had no other way to reach the
// decision log. It is gone. The counter now runs at core/pipeline.ts's deny exit
// (see deny-repeat.ts), which is also where the record is built, so the value
// travels as a parameter — and a parameter cannot outlive its invocation, which a
// single slot could: it was drained only inside recordDecision, called only
// `if (logging)`, so a T1_DECISION_LOG=false install never cleared it and the
// next invocation in the same long-lived process would have inherited the
// previous refusal's count.
//
// The buffer above keeps the slot's shape because its sender genuinely IS deep in
// a call stack — fsjson.ts's chokepoint, ~190 writes in one materialization — and
// so it has to be drained unconditionally instead (see the header).

// Node's fs errors carry a symbolic `.code` (ENOENT, EACCES, EPERM, …) — far
// more diagnostic than the numeric `.errno` the field name in the plan
// echoes, and it is the same extraction core/pipeline.ts's crash-deny path
// already does inline for its own fail-closed message.
export function errnoOf(error: unknown): string | undefined {
  const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' ? code : undefined;
}
