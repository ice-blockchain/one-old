// src/shared/state/decision-log.ts
// The decision log: an append-only, bounded, on-by-default record of every
// verdict runPipeline() produced, so "why did this run wedge?" has evidence
// instead of nothing. core/pipeline.ts is the ONLY production writer (see its
// header); a later `doctor --run <id>` work item is the reader, via
// readDecisions() below — its field names are DICTATED and not free to change
// (see the DecisionRecord doc).
//
// ── Where it lives ──────────────────────────────────────────────────────────
// `.traffic-one/runs/<runId>/debug/decisions.jsonl` when the hook resolved a
// run id, `.traffic-one/debug/decisions.jsonl` otherwise (SessionStart before
// onboarding, a hook outside any run). Both are already covered by the
// generated `.gitignore` block (`TRAFFIC_ONE_RUN_STATE_ENTRIES` in
// architecture-contract/scaffold-content.ts carries both `runs/` and
// `debug/`) and by the existing retention sweep (retention.ts's `debugRoot`
// loop and its per-run `runDebug` loop both already walk exactly these two
// directories). Deliberately reuses that authority instead of inventing a
// third: a file this log writes on every hook call must never be the one
// path retention forgot.
//
// ── Liveness vs. the sweep ───────────────────────────────────────────────────
// retention.ts only removes a `runs/<id>/debug/*` or `debug/*` file once its
// OWN mtime is older than `orphanTtlDays` (default 3 days) — an actively
// written decisions.jsonl keeps refreshing its own mtime on every append, so
// a live run's log is never a sweep candidate. That is a property of the
// existing sweep's mtime-based staleness test, not a special case added for
// this file, so a later hardening of sweep liveness cannot un-protect it by
// accident and this file gains nothing by relying on the sweep being wrong.
//
// ── Bound and eviction ──────────────────────────────────────────────────────
// Bounded by BYTES per file (DECISION_LOG_MAX_BYTES), not by record count,
// because a byte check is one fs.statSync — cheap on the hot path — while a
// record-count check needs to read the whole file. On overflow the OLDEST
// lines are dropped and the NEWEST are kept: truncating the newest would
// erase the very evidence of the wedge this log exists to diagnose (the tail
// end of a stuck run), while truncating the oldest only loses how the run
// began — already captured durably elsewhere (the run ledger, the frozen
// architecture snapshot, the digests). A wedge diagnosis reads backward from
// "now"; an origin diagnosis has other sources. Trimming drops to HALF the
// bound rather than trimming to exactly the bound, so the next trim is not
// due again after a single further append — the same amortization
// deny-repeat.ts's MAX_TRACKED_KEYS halving uses.
//
// ── On/off ───────────────────────────────────────────────────────────────────
// On by default. Opt out with `T1_DECISION_LOG=off` (or `false`/`0`) — the
// same `T1_`-prefixed, boolean-ish, "unset/anything else = enabled" env
// convention as `T1_OC_CHILD_KEEPALIVE` (opencode-timeouts.ts) rather than a
// new one. Turning it off also suppresses the correlation-id suffix
// core/pipeline.ts appends to deny text (see stampDeny there): referencing a
// log that was told not to exist would be worse than saying nothing.
//
// ── Fail-open, not fail-silent ──────────────────────────────────────────────
// appendDecision() never throws and never changes a verdict — it is called
// AFTER the verdict is already decided. A write failure is still reported,
// just on a channel that cannot affect the tool call: a `[traffic-one]`
// stderr line, the same convention shared/logger.ts's `warn()` uses. This is
// deliberately NOT the same as core/pipeline.ts's ctx.log.warn, because this
// module has no Ctx (its two exported signatures are dictated and take only
// (projectRoot, record) / (projectRoot, runId) — see the work-item report for
// why) and duplicating the one-line logger here is cheaper than threading one
// through.
//
// ── stateWrites: what is captured ───────────────────────────────────────────
// Populated from state-write-log.ts's per-invocation collector, which is wired
// into shared/fsjson.ts's guarded primitives — the CHOKEPOINT nearly every state
// mutation in shared/state/** and every materialization write goes through — so
// each one reports its path, its operation, and whether it landed. Critically
// that includes the REFUSALS (the consent fence, and the symlink fence beside
// it), which is the event this field exists to explain and the one that is
// evident nowhere else: a run's successful writes can be read off the tree they
// produced, a refused one leaves nothing behind at all. It was previously wired
// into two call sites only (deny-repeat.ts, claim-capture.ts), with the whole
// chokepoint uninstrumented; those two remain, because each names WHICH counter
// or capture the write was for, which the chokepoint cannot know.
//
// Still not covered: a gate that reaches past fsjson into raw `fs` (some of
// src/modules/**). That is by design the same design the fence has — the way to
// be counted is to use the codebase's IO helpers.

import * as fs from 'fs';
import * as path from 'path';

import type { CanonicalEvent, HostId } from '../../core/types';
import { isNonProjectRoot } from '../authoring-root';
import { projectWritesPermitted } from './plugin-use';
import {
  appendTextFile, ensureDir, movePath, readJsonResult, readText, removePath,
  stateWritePermitted, writeJson, writeTextFile,
} from '../fsjson';
import { shrink } from './claim-capture';
import { withOwnedDirLock } from './run-agent/locks';
import { safePathSegment } from './run-agent/run-paths';
import type { StateWriteRecord } from './state-write-log';

export type DecisionKind = 'allow' | 'deny' | 'context' | 'noop';

export interface DecisionRecord {
  readonly ts: string;
  readonly correlationId: string;
  readonly runId: string | null;
  readonly hookSeq: number;
  readonly pid: number;
  readonly event: CanonicalEvent;
  readonly host: HostId;
  readonly decision: DecisionKind;
  readonly gateId?: string | null;
  readonly denyId?: string | null;
  readonly denyTarget?: string;
  readonly repeatCount?: number;
  readonly inputs: Record<string, unknown>;
  readonly stateWrites: StateWriteRecord[];
}

// ── on/off ───────────────────────────────────────────────────────────────────

export function decisionLoggingEnabled(): boolean {
  const raw = (process.env.T1_DECISION_LOG ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== 'off' && raw !== '0';
}

/**
 * Will a decision written for `projectRoot` right now actually land on disk?
 *
 * THE predicate for "is it honest to quote a correlation ref to the user?".
 * core/pipeline.ts appends `(traffic-one ref: …)` to deny text and must gate
 * that suffix on THIS, not on decisionLoggingEnabled() alone: the two answers
 * diverge exactly when the use-plugin question is unanswered, which is also
 * when a deny is most likely to be the first thing a user ever sees from
 * Traffic One. Quoting a ref that `doctor` will not find is worse than saying
 * nothing.
 *
 * It is the same expression appendDecision() checks, factored out rather than
 * restated, so the suffix condition and the write condition cannot drift the
 * way they already did once.
 */
// Ordered cheapest-first, and the order changed with the memo: an env read,
// then projectWritesPermitted (a Map hit after its first call in this process),
// then isNonProjectRoot LAST — that one walks up to 40 ancestors probing three
// paths per level, so on a cold process it is the most expensive of the three
// by orders of magnitude.
export function decisionsRecorded(projectRoot: string): boolean {
  return decisionLoggingEnabled()
    && projectWritesPermitted(projectRoot)
    && !isNonProjectRoot(projectRoot);
}

// ── paths ────────────────────────────────────────────────────────────────────

/**
 * The run id in its ON-DISK form — `safePathSegment`, the same sanitizer
 * run-agent/run-paths.ts's `runDir` applies to build every other `runs/<id>/`
 * path, so this log's directory name is the one the rest of the system uses.
 *
 * THE canonical form for this module, used for the directory AND for the
 * correlation ref, because the ref's whole job is to name a place an operator (or
 * `doctor --run <id>`) can go and look. It used to echo the raw value, so a run
 * id carrying a path separator or any character the sanitizer folds printed a ref
 * naming a directory that does not exist. `null` for a value that sanitizes away
 * to nothing (whitespace, or characters that are all stripped): that is not a run
 * id, and treating it as one produced `runs//debug` — the run-level bucket
 * collapsed onto the project-level one.
 */
function runSegment(runId: string | null): string | null {
  const segment = runId == null ? '' : safePathSegment(runId);
  return segment || null;
}

function decisionLogDir(projectRoot: string, runId: string | null): string {
  const segment = runSegment(runId);
  return segment
    ? path.join(projectRoot, '.traffic-one', 'runs', segment, 'debug')
    : path.join(projectRoot, '.traffic-one', 'debug');
}

function decisionLogFile(projectRoot: string, runId: string | null): string {
  return path.join(decisionLogDir(projectRoot, runId), 'decisions.jsonl');
}

function hookSeqFile(dir: string): string {
  return path.join(dir, 'decisions.seq.json');
}

function hookSeqLockDir(dir: string): string {
  return path.join(dir, '.decisions-seq.lock');
}

// ── correlation id ───────────────────────────────────────────────────────────

/** `<runId>:<hookSeq>:<pid>` — the identity a deny's echoed ref and a decision
 *  record share, so grepping one text for the other always works.
 *
 *  The no-run token is a word, not `null`: this string is appended verbatim to
 *  every deny the agent shows a user, and a rendered `null` there reads as a
 *  bug in the product rather than as "this hook ran outside a run". It also
 *  keeps the ref greppable — records with no run id land under
 *  `.traffic-one/debug/`, so the token has to identify that bucket, which an
 *  omitted segment could not do without changing the field count. */
const NO_RUN_TOKEN = 'no-run';

export function buildCorrelationId(runId: string | null, hookSeq: number, pid: number): string {
  return `${runSegment(runId) ?? NO_RUN_TOKEN}:${hookSeq}:${pid}`;
}

// ── hookSeq: monotonic within a run, across separate hook processes ─────────
// Every hook invocation is its own OS process, so "monotonic across
// processes" cannot be a counter kept in memory — it has to live on disk, and
// incrementing it has to be a single atomic read-increment-write, not three
// separate syscalls a sibling process could interleave with. withOwnedDirLock
// (run-agent/locks.ts) is the codebase's existing primitive for exactly that
// (agent registry, run ledger, run-agent claims all already serialize a tiny
// JSON read-modify-write behind it) — reused here rather than inventing a
// second locking scheme. The lock's own timeout/stale/retry knobs are tuned
// much shorter than its other callers' (300 ms / 5 s / 5 ms vs. 2 s / 15 s /
// 10 ms elsewhere): this runs on EVERY hook call, so a contended lock must
// give up and fall back fast rather than eat into the 150 ms pre-tool budget.
const HOOK_SEQ_LOCK_TIMEOUT_MS = 300;
const HOOK_SEQ_LOCK_STALE_MS = 5_000;
const HOOK_SEQ_LOCK_RETRY_MS = 5;
const HOOK_SEQ_WAIT = new Int32Array(new SharedArrayBuffer(4));

// In-process fallback ordinal: used only (a) inside the plugin's own repo,
// where no `.traffic-one` state is ever written (AGENTS.md stand-down), and
// (b) when the on-disk lock could not be acquired inside its short timeout.
// Monotonic within THIS process only — see the return below for what that
// means under real cross-process contention.
let inProcessFallbackSeq = 0;

/**
 * Mint the next hookSeq for (projectRoot, runId). Never throws, never blocks
 * beyond its own short lock timeout.
 *
 * Under concurrency: two hook processes racing this call serialize on the
 * owned-dir lock exactly like every other cross-process mutation in this
 * codebase — the loser waits up to HOOK_SEQ_LOCK_TIMEOUT_MS, then proceeds
 * with the freshly-persisted value once the winner releases. If the lock is
 * still contended past that timeout (or the lock directory itself could not
 * be created — read-only sandbox, full disk), this falls back to
 * `Date.now()` plus an in-process ordinal: still an integer, still
 * increasing within this process, but NOT guaranteed to sort after a sibling
 * process's concurrent value. That is the deliberate trade for this being a
 * hot-path call on every tool call: never block the tool over perfect
 * ordering of a diagnostic sequence number.
 *
 * The counter write is checked, not assumed. `writeJson` used to return `void`,
 * so a REFUSED persist (the consent fence, or now a symlink planted at the
 * counter file) was indistinguishable from a durable one: the next invocation
 * read the same base, minted the same number, and two hook calls claimed one
 * correlation id — in the log an operator is reading precisely to tell them
 * apart. A counter that did not persist is not a sequence, so it takes the
 * same fallback a contended lock does.
 */
export function nextHookSeq(projectRoot: string, runId: string | null): number {
  // Same two no-write cases: the plugin's own repo, and a project whose
  // use-plugin answer is still outstanding or was "no". Both take the
  // in-process ordinal, so a correlation id is still minted for the deny text
  // — the hook stays fully functional, it just leaves no file behind.
  // Cheapest first — see decisionsRecorded() for why projectWritesPermitted now
  // precedes the ancestor walk.
  if (!projectWritesPermitted(projectRoot) || isNonProjectRoot(projectRoot)) {
    inProcessFallbackSeq += 1;
    return inProcessFallbackSeq;
  }
  const dir = decisionLogDir(projectRoot, runId);
  let seq = 0;
  let persisted = false;
  let acquired = false;
  try {
    acquired = withOwnedDirLock(
      hookSeqLockDir(dir),
      HOOK_SEQ_LOCK_TIMEOUT_MS,
      HOOK_SEQ_LOCK_STALE_MS,
      HOOK_SEQ_LOCK_RETRY_MS,
      HOOK_SEQ_WAIT,
      () => {
        const file = hookSeqFile(dir);
        // The SAME incident as the refused write above, arriving through the
        // read: `readJson(file, {})` answered a counter file that is there and
        // unreadable with the same `{}` it answers an absent one with, so `base`
        // fell to 0, `seq` restarted at 1, and the persist HEALED the file to
        // `{"seq":1}` — so the whole earlier sequence was then replayed, number
        // for number, in the log an operator is reading precisely to tell two
        // invocations apart. A counter we cannot READ is no more a sequence than
        // one we could not WRITE, so it takes the identical fallback, and the
        // unparseable bytes are left in place rather than replaced by a `1`
        // that lies about how far the run has got.
        const read = readJsonResult<{ seq?: number }>(file);
        if (read.kind === 'corrupt' || read.kind === 'unreadable') return;
        const current = read.kind === 'ok' ? read.value : {};
        const base = typeof current.seq === 'number' && Number.isFinite(current.seq) && current.seq >= 0
          ? Math.floor(current.seq)
          : 0;
        seq = base + 1;
        ensureDir(dir);
        persisted = writeJson(file, { seq });
      },
    );
  } catch {
    acquired = false;
  }
  if (acquired && persisted && seq > 0) return seq;
  inProcessFallbackSeq += 1;
  return Date.now() + inProcessFallbackSeq;
}

// ── bounding helpers ─────────────────────────────────────────────────────────

// Byte bound per decisions.jsonl file — see the header for why this is a
// byte check (cheap: one stat) rather than a record-count check (needs a
// full read), and why overflow drops the OLDEST lines.
export const DECISION_LOG_MAX_BYTES = 2 * 1024 * 1024;
// Reusing shrink() (claim-capture.ts) to bound `inputs`: same truncation
// contract (keep every key, cap string length, cap depth/array length) this
// codebase already uses for the structurally similar claim-capture.jsonl.
const MAX_STATE_WRITES = 32;

// The rewrite goes through the chokepoint end to end — `writeTextFile` for the
// temp file and `movePath` for the swap, never fs.writeFileSync/renameSync. The
// two raw calls that used to be here bypassed BOTH fences: a trim is a write and
// a delete of the whole file, so on a project whose use-plugin question was
// unanswered it was the one decision-log mutation that could still land, and a
// `decisions.jsonl` that was a symlink got the trimmed content delivered through
// it. A refused trim leaves the oversized file exactly as it is, which is the
// non-destructive outcome; the caller then appends to it and tries again next time.
function trimToNewestHalf(file: string): void {
  // Asked BEFORE the read, not just before the write, because this is the one
  // mutation whose input is the destination itself: `readText` follows symlinks
  // (reads legitimately do — the plugin root's rules/ and skills-catalog/ are
  // symlinks in the materialize fixtures), so on a planted link the trim would
  // otherwise read the link TARGET and write ~1MB of it into a temp file inside
  // the project before the final move got refused. The refusal has to come first
  // or the leak has already happened. This is not a TOCTOU window: losing the
  // race here means writeTextFile/movePath refuse below, exactly as they do now.
  if (!stateWritePermitted(file)) return;
  const text = readText(file);
  if (text == null) return; // nothing to trim
  const lines = text.split('\n').filter((line) => line.length > 0);
  const target = Math.floor(DECISION_LOG_MAX_BYTES / 2);
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + lineBytes > target && kept.length > 0) break;
    kept.unshift(line);
    bytes += lineBytes;
  }
  const tmp = `${file}.${process.pid}.trim.tmp`;
  const payload = kept.length ? `${kept.join('\n')}\n` : '';
  if (!writeTextFile(tmp, payload)) return;
  if (!movePath(tmp, file)) removePath(tmp);
}

// Independent of state-write-log.ts's own bound, and failure-preserving for the
// same reason: with the fsjson chokepoint instrumented, one materialization is
// ~190 writes in a single hook call, so a plain "keep the first 31" filled the
// record with successes and dropped every refusal — the one thing in here that
// cannot be reconstructed from the tree on disk. Order is preserved among what
// is kept, so the sequence still reads chronologically.
function boundStateWrites(writes: readonly StateWriteRecord[]): StateWriteRecord[] {
  if (writes.length <= MAX_STATE_WRITES) return [...writes];
  const slots = MAX_STATE_WRITES - 1; // one is spent on the truncation marker
  // Indices, not the records themselves: two identical writes are two events, and
  // an identity Set would silently keep both while counting them once.
  const keep = new Set<number>();
  for (const [index, write] of writes.entries()) {
    if (!write.ok && keep.size < slots) keep.add(index);
  }
  for (let index = 0; index < writes.length && keep.size < slots; index += 1) keep.add(index);
  const kept = writes.filter((_, index) => keep.has(index));
  return [
    ...kept,
    { path: `(+${writes.length - kept.length} more state write(s) omitted)`, op: 'truncated', ok: true },
  ];
}

function logFailure(context: string, error: unknown): void {
  try {
    const detail = error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
    process.stderr.write(`[traffic-one] decision-log ${context} failed: ${detail}\n`);
  } catch {
    // stderr itself can fail in exotic hosts; there is nowhere left to report this.
  }
}

// ── writer ───────────────────────────────────────────────────────────────────

/**
 * Append one decision record. Never throws, never blocks a verdict — call
 * this AFTER the verdict is already final. A write failure is reported to
 * stderr (see the header's "fail-open, not fail-silent") rather than thrown.
 */
export function appendDecision(projectRoot: string, record: DecisionRecord): void {
  if (!decisionsRecorded(projectRoot)) return;
  const file = decisionLogFile(projectRoot, record.runId);
  try {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* absent — first write */ }
    if (size > DECISION_LOG_MAX_BYTES) trimToNewestHalf(file);
    const bounded: DecisionRecord = {
      ...record,
      // The same canonical form the file path and the correlation ref use, so a
      // record cannot name a run id that disagrees with the directory it is
      // sitting in — the reader (readDecisions, keyed by the same sanitizer)
      // would never find it under the raw spelling anyway.
      runId: runSegment(record.runId),
      inputs: shrink(record.inputs) as Record<string, unknown>,
      stateWrites: boundStateWrites(record.stateWrites),
    };
    // The REFUSED half of the same rule. `logFailure` above covers a THROWN
    // append; a refused one returns `false` and used to be indistinguishable
    // from a durable one, so the module that documents "fail-open, not
    // fail-silent" was silent for the one outcome it can actually produce here.
    // The consent fence is already excluded by `decisionsRecorded`, so what is
    // left is a planted symlink or a path escaping the state dir — anomalous by
    // construction, never a per-tool-call log line.
    if (!appendTextFile(file, `${JSON.stringify(bounded)}\n`)) {
      logFailure('append', 'the state-write fence refused the decision log append');
    }
  } catch (error) {
    logFailure('append', error);
  }
}

// ── reader ───────────────────────────────────────────────────────────────────

const VALID_DECISIONS: ReadonlySet<string> = new Set(['allow', 'deny', 'context', 'noop']);

function asDecisionRecord(value: unknown): DecisionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.correlationId !== 'string' || !rec.correlationId) return null;
  if (typeof rec.decision !== 'string' || !VALID_DECISIONS.has(rec.decision)) return null;
  if (typeof rec.hookSeq !== 'number' || typeof rec.pid !== 'number') return null;
  if (typeof rec.ts !== 'string' || typeof rec.event !== 'string' || typeof rec.host !== 'string') return null;
  return {
    ts: rec.ts,
    correlationId: rec.correlationId,
    runId: typeof rec.runId === 'string' ? rec.runId : null,
    hookSeq: rec.hookSeq,
    pid: rec.pid,
    event: rec.event as CanonicalEvent,
    host: rec.host as HostId,
    decision: rec.decision as DecisionKind,
    gateId: typeof rec.gateId === 'string' ? rec.gateId : null,
    denyId: typeof rec.denyId === 'string' ? rec.denyId : null,
    ...(typeof rec.denyTarget === 'string' ? { denyTarget: rec.denyTarget } : {}),
    ...(typeof rec.repeatCount === 'number' ? { repeatCount: rec.repeatCount } : {}),
    inputs: rec.inputs && typeof rec.inputs === 'object' && !Array.isArray(rec.inputs)
      ? rec.inputs as Record<string, unknown>
      : {},
    stateWrites: Array.isArray(rec.stateWrites) ? rec.stateWrites as StateWriteRecord[] : [],
  };
}

/**
 * Read every well-formed decision record for one run. Tolerant by design: a
 * missing file yields `[]`, and a truncated or unparseable trailing line (or
 * any other corrupt line) is skipped rather than aborting the read — a
 * diagnostic that throws on the exact input a wedge produces is useless
 * precisely when it is needed.
 */
export function readDecisions(projectRoot: string, runId: string): DecisionRecord[] {
  const text = readText(decisionLogFile(projectRoot, runId));
  if (text == null) return [];
  const out: DecisionRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // truncated/corrupt line — keep reading the rest of the file
    }
    const record = asDecisionRecord(parsed);
    if (record) out.push(record);
  }
  return out;
}
