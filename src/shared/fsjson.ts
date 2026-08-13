// src/shared/fsjson.ts
// The ONE JSON/text IO layer (legacy reimplemented readJson/parseJsonText/
// writeJson per runner). Implements the FsJson service consumed via Ctx.
//
// ── The consent write fence ──────────────────────────────────────────────────
// Every WRITE here refuses paths under a project's `.traffic-one/` while that
// project's "do you want to use Traffic One here?" question is unanswered or
// was answered no (state/plugin-use.ts's projectStateWriteAllowed). Reads are
// never fenced.
//
// This is the layer that gets the fence because it is the layer this file's own
// name already claims: making a per-writer fence the rule means every future
// writer has to remember it, which is precisely the failure that has now
// happened three times. Here the default is closed — a writer that uses the
// codebase's IO helpers is fenced whether or not it knows consent exists, and
// bypassing takes a deliberate reach past these helpers into raw `fs`.
//
// The guarded write/append/mkdir/remove primitives below exist so that reach is
// never NECESSARY: there is a fenced equivalent for every raw `fs` mutation a
// caller might want to make under the state dir. They return `false` rather
// than throwing — a refused write is a normal outcome of a legitimate product
// state, not an error, and a hook must never fail a tool call over one.
//
// ── The symlink fence ────────────────────────────────────────────────────────
// The consent fence answers "may Traffic One write here?". It says nothing about
// whether the path still MEANS what it says, and every primitive below used to
// resolve symlinks like any other `fs` call — so a repo that ships
// `.traffic-one/runs/x/debug/decisions.jsonl` (or any ancestor of it) as a
// symlink got the first hook's write delivered to the link's target, anywhere on
// the filesystem, on clone.
//
// Two rules, deliberately different in scope, because their costs are:
//
//   - NEVER WRITE THROUGH A LINK, everywhere. O_NOFOLLOW on every open below,
//     whatever the path. Refusing to overwrite whatever a link happens to point
//     at costs nothing anywhere — a caller that means to write a file wants the
//     file — and it covers the root `AGENTS.md`/`CLAUDE.md` pair too, where a
//     DANGLING link is the shape plain `writeFileSync` does not merely follow but
//     CREATES the target of. It does NOT touch the deliberate `CLAUDE.md` ->
//     `AGENTS.md` link materialize/render-agents.ts creates: that is a
//     `symlinkSync` call, not a write through one, and its writeTextIfChanged
//     fallback runs on a path with no link at it.
//
//   - STAY INSIDE `<project>/.traffic-one/` — the containment invariant, checked
//     against resolved real paths, and the only thing that can catch an
//     INTERMEDIATE symlink (no open flag refuses those). Necessarily scoped to
//     state paths: a root file or a host config has no state dir to be contained
//     in, and the per-user machine dir's carve-out entries (plugin-use.ts's
//     allowlist, where the consent answer itself lives) are deliberately not
//     project state at all.
//
// Reads are never touched by either: the materialize fixtures resolve the
// plugin's `rules/` and `skills-catalog/` THROUGH symlinks, which is legitimate.

import * as fs from 'fs';
import * as path from 'path';

import { STATE_DIR } from '../config/paths';
import type { FsJson } from '../core/types';
import { readRegularFileResult } from './bounded-read';
import {
  O_NOFOLLOW,
  appendAll,
  createFileNoFollow,
  isSymlink,
  realPathWithMissingTail,
  writeAll,
  writeFileNoFollow,
} from './fs-nofollow';
// A pure leaf (no imports of its own), so unlike plugin-use below this one
// cannot close a cycle and needs no lazy require.
import { errnoOf, recordStateWrite } from './state/state-write-log';

/**
 * The two directory opens below are an FSYNC OF A DIRECTORY, not a file read —
 * the census's allowlist has said so for two rounds and the reason was true.
 * It was also an ARGUMENT, and the point of this round is that an argument is
 * not an instrument: it rested on the `mkdirSync(dir, {recursive:true})` above
 * throwing EEXIST for a non-directory, which is a property of a DIFFERENT line.
 *
 * Said in flags instead, where the kernel enforces it: O_DIRECTORY refuses
 * anything that is not a directory at the open, and O_NONBLOCK means no shape
 * can make the open wait. Both fold to 0 on Windows, which has neither the flag
 * nor the directory-fsync this is guarding — and the `catch` below already
 * treats a refused directory fsync as the ordinary outcome there.
 */
const DIR_SYNC_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_DIRECTORY || 0);

// Lazy require, not an import: state/plugin-use.ts reads the per-user prefs
// through readJson below, so a static import would close a cycle. Same
// documented escape state/local-prefs/index.ts already uses for the
// normalize ↔ local-prefs cycle. Resolved on first write and cached — by then
// this module is fully initialized, so the partial-exports hazard of a static
// cycle cannot apply.
let fence: typeof import('./state/plugin-use') | null = null;

function pluginUse(): typeof import('./state/plugin-use') {
  if (!fence) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fence = require('./state/plugin-use') as typeof import('./state/plugin-use');
  }
  return fence;
}

export function projectStateWritable(target: string): boolean {
  return pluginUse().projectStateWriteAllowed(target);
}

export function parseJson<T = unknown>(text: string, fallback: T): T {
  try {
    const value = JSON.parse(String(text ?? '').trim() || 'null');
    return value == null ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

/**
 * BOUNDED (shared/bounded-read.ts), and the bare `readFileSync` this replaces is
 * why. `open(O_RDONLY)` on a FIFO waits for a writer forever and a character
 * device answers a read as long as anybody keeps asking, so a planted object at
 * any path this reads made a HOOK never return — driven at `.traffic-one/.one.json`
 * (.tmp/fsjson-bounded): SIGKILL at 12 011 ms here, 12 014 ms through
 * `readJsonResult`, 20 151 ms for a symlink to `/dev/zero`, against a 0 ms
 * control. An unbounded loop cannot even be reported, which is the one outcome
 * this codebase ranks below failing closed.
 *
 * The `null` is unchanged and still folds every failure, which is all this
 * caller's shape can express: `readText`'s consumers ask a question OF THE TEXT.
 * A shape that is not a regular file joins the fold where a DIRECTORY already
 * was, so nothing reachable today moves; only the two shapes that had no
 * behaviour to preserve do.
 */
export function readText(filePath: string): string | null {
  const read = readRegularFileResult(filePath);
  return read.kind === 'text' ? read.text : null;
}

/**
 * What a JSON read actually FOUND — the one thing `readJson` below structurally
 * cannot say.
 *
 * `readJson` answers an absent file and an unparseable one with the same
 * caller-supplied fallback, so "I could not read it" arrives as a confident
 * "here is the answer". That is harmless for a consumer that only asks a
 * question of the value, and destructive for a read-modify-write one: it reads a
 * torn `.one.json`, gets `{}`, merges its one field into `{}`, writes the
 * result, and a file that was merely UNPARSEABLE is now genuinely gone.
 *
 * Four kinds, not the obvious three, because `readText`'s catch-all collapses a
 * distinction that matters at exactly the moment it is load-bearing: ENOENT
 * means nothing is there and writing is safe, while EACCES/EISDIR/EIO mean
 * something IS there and we cannot see it — the one case where overwriting is
 * least defensible and today's fallback is least distinguishable from `absent`.
 *
 * `corrupt` carries the bytes so a caller can preserve them before it replaces
 * the file; `unreadable` cannot and says so with the errno instead.
 *
 * A file whose JSON value is `null` — including an EMPTY file, the literal
 * signature of an `O_TRUNC` open that never got its write — is `corrupt`, not
 * `ok`. That is the same verdict `parseJson` already reaches (it returns the
 * fallback for a null value), so the wrapper below stays behaviour-identical.
 *
 * A NON-REGULAR FILE is `unreadable` with a named errno — `EISDIR` for a
 * directory (where it already landed, via the read's own errno), and
 * `not-a-regular-file` for a FIFO, a device or a socket. Neither of the other two
 * arms would be safe for it, which is the trap the bounded reader exists to
 * close rather than an ordering preference: `absent` says nothing is there and
 * licenses a write, and `corrupt` carries the bytes and licenses a REPLACEMENT
 * of a file whose emptiness is an artefact of how we opened it.
 */
export type JsonRead<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'absent' }
  | { readonly kind: 'corrupt'; readonly text: string }
  | { readonly kind: 'unreadable'; readonly errno: string };

export function readJsonResult<T = unknown>(filePath: string): JsonRead<T> {
  // BOUNDED, and the classification is the reason the reader is a shared leaf
  // rather than a try/catch here: a non-regular file must reach `unreadable`
  // with a named errno, and BOTH of the other arms are fail-open for it. As
  // `absent` it would license a write over something that is there; as `corrupt`
  // it would license a REPLACEMENT, because an O_NONBLOCK FIFO reads as EOF and
  // `JSON.parse('')` throws straight into the arm that carries the bytes. See
  // bounded-read.ts's FSTAT-DROP paragraph for the measurement.
  const read = readRegularFileResult(filePath);
  if (read.kind === 'absent') return { kind: 'absent' };
  if (read.kind === 'unreadable') return { kind: 'unreadable', errno: read.errno };
  const text = read.text;
  let value: unknown;
  try {
    value = JSON.parse(String(text ?? '').trim() || 'null');
  } catch {
    return { kind: 'corrupt', text };
  }
  return value == null ? { kind: 'corrupt', text } : { kind: 'ok', value: value as T };
}

/**
 * Unchanged, deliberately: 102 non-test call sites bind to this signature and a
 * mechanical rewrite of them is what has twice made a site invisible rather than
 * fixed. It is now expressed as the convenience wrapper over the reader above —
 * every non-`ok` kind maps to the fallback, which is precisely the three
 * outcomes `readText`+`parseJson` already folded together. Behaviour-identical
 * by construction, and pinned that way by the differential test in
 * __tests__/read-json-result.test.ts rather than by this claim.
 */
export function readJson<T = unknown>(filePath: string, fallback: T): T {
  const read = readJsonResult<T>(filePath);
  return read.kind === 'ok' ? read.value : fallback;
}

// ── The guard every mutation below passes through ────────────────────────────
// 'plain'   — not project state: neither fence applies, and nothing is recorded
//             (`stateWrites` in the decision log means STATE writes; the
//             generator emitting `dist/**` through these helpers is not one).
// 'state'   — under some project's `.traffic-one/`, and permitted. The outcome
//             gets reported to the decision log's per-invocation collector.
// 'refused' — already recorded, with the reason; the caller returns false.
type Guard = 'plain' | 'state' | 'refused';

// Symbolic reasons, in the same `errno` field a real `fs` failure's `.code`
// lands in (see state-write-log.ts: that field always carried symbolic strings,
// never numbers). A refusal is not an errno, so these are spelled as prose no
// kernel produces — an operator reading a decision record can tell "we declined"
// from "the filesystem declined" without a second field.
type RefusalReason = 'consent-fence' | 'symlink' | 'escapes-state-dir' | 'unresolvable-path';

function refuse(target: string, op: string, reason: RefusalReason): 'refused' {
  recordStateWrite({ path: target, op, ok: false, errno: reason });
  return 'refused';
}

/**
 * `child` is `parent` or lives under it, compared case-INSENSITIVELY and segment
 * by segment for exactly the reasons state/plugin-use.ts's own path comparison
 * documents (macOS and Windows fold case, and an index taken from a lowercased
 * copy can slice a path in the wrong place). Reused from there rather than
 * restated, so the fence and the containment rule cannot disagree about whether
 * two spellings are one file.
 */
function within(parent: string, child: string): boolean {
  return pluginUse().pathWithin(parent, child);
}

/**
 * `child` is `parent` or lives under it, compared EXACTLY — the other half of the
 * containment check below, and the half `within` cannot be.
 *
 * THE COMPARISON BELOW IS ASYMMETRIC, which is why it needs two predicates. One
 * side is `path.join(realRoot, STATE_DIR)` — a CONSTANT this file supplies — and
 * the other is caller text that `fs.realpathSync` re-emits verbatim (the JS
 * resolver preserves the caller's spelling for every component that is not a
 * symlink; measured, and it is `.native` that canonicalises). So the two sides can
 * differ in case for two entirely different reasons:
 *
 *   the PROJECT ROOT prefix caller spelling on both sides, descending from the
 *                           same string. Folding here widens what counts as
 *                           CONTAINED, which SUPPRESSES a refusal — and on a
 *                           case-sensitive filesystem a folded prefix does not
 *                           stay inside the project at all. MEASURED on a real
 *                           case-sensitive APFS volume, project `Proj` with
 *                           `.traffic-one -> ../proj/.traffic-one` and a distinct
 *                           sibling checkout `proj`:
 *
 *                             folding  permitted=true  wrote=true
 *                                      the SIBLING's state file: overwritten
 *                             exact    permitted=false wrote=false
 *                                      the SIBLING's state file: untouched
 *
 *                           …while the sibling's OWN state dir, the same real
 *                           directory addressed as its own project, stays
 *                           permitted. Not a blanket refusal: the crossing is
 *                           what is refused.
 *   the STATE_DIR segment   caller spelling versus our constant, and the fold
 *                           there does NOT widen a refusal. A previous version of
 *                           this docblock said it did — transplanted verbatim from
 *                           plugin-use.ts, where it is true of a DIFFERENT
 *                           function. What counts as STATE is decided UPSTREAM, at
 *                           classifyStateWrite's first line:
 *                           projectRootForStatePath matches STATE_DIR with a
 *                           case-INSENSITIVE regex, so `.Traffic-One` and
 *                           `.TRAFFIC-ONE` are already this project's state and
 *                           already inside the consent fence (MEASURED, both
 *                           volume kinds: the classifier returns the project root
 *                           for all three spellings). At the comparison itself
 *                           folding makes `permitted` true and the write LAND,
 *                           where an exact compare returns `escapes-state-dir` —
 *                           so there it SUPPRESSES a refusal too.
 *
 * That is the same sibling-checkout escape materialize/plan-migration.ts's
 * `containedIn` docblock records, on the WRITE path, and it was reasoned to be
 * narrower ("a folded prefix still lands inside the project root") — measured, it
 * is not narrower in kind.
 *
 * THE FOLD ON THE SEGMENT STAYS ANYWAY, decided against its cost rather than
 * against the inherited justification above. What it permits, MEASURED on the
 * case-sensitive volume: `<project>/.Traffic-One/x.json` is permitted, the write
 * lands, and it lands in a SECOND directory — `.Traffic-One` and `.traffic-one`
 * both present in the project, distinct inodes, the canonical one without the
 * file. Nothing reads that directory, and plugin-use.ts's
 * removeDeclinedProjectArtifacts joins the canonical STATE_DIR, so a decline does
 * not reclaim it either. BOUNDED, and worth saying plainly rather than inflating:
 * the exact half above still confines the target to the project root, so the worst
 * case is a stray in-project directory and never a boundary crossing.
 *
 * Refusing instead costs more than that. The recorded reason would be FALSE where
 * it matters most — on macOS and Windows `.Traffic-One` IS the state dir, one
 * directory, and `escapes-state-dir` for a path that escapes nothing is a record
 * an operator cannot act on — and it would put this comparison in contradiction
 * with the classifier two calls earlier, which treats that path as this project's
 * state on purpose. The place to refuse a spelling outright is where state-ness is
 * decided, and that decision must keep folding or the spelling leaves the consent
 * fence altogether (plugin-use.ts's own measurement: `root=null, allowed=true`
 * under an exact compare). No plugin code produces a non-canonical spelling, so
 * both directions are latent; what would move this decision is a production writer
 * that can be handed one, or the decline sweep learning the case-variant names.
 *
 * STILL DUPLICATED in materialize/plan-migration.ts's `containedIn`, and not for
 * the reason that used to be given here. "That module imports this one, so
 * importing it back is a cycle" ruled out the one direction nobody needed:
 * plan-migration.ts ALREADY imports this module, so exporting from here is acyclic,
 * and sharing was the first thing tried. What stops it is one file away and
 * MEASURED rather than reasoned about — `tests/refusal-contract.test.ts` censuses
 * every FUNCTION this module exports and reds on any it cannot classify:
 *
 *   fsjson.ts exports a function neither list names. Add it to FSJSON_WRITERS if
 *   its false (or its union) can mean REFUSED, or to FSJSON_NON_WRITERS with the
 *   reason it cannot.
 *
 * So sharing needs one entry in FSJSON_NON_WRITERS — a pure path comparison opens
 * nothing and can refuse nothing — in a file this change does not own. A
 * coordination cost, not a design objection: whoever lands the sharing adds that
 * line and deletes the copy.
 *
 * What two copies cost is drift, and that is now covered rather than hoped about.
 * The root-segment hole below was in BOTH and had to be fixed twice, which is the
 * cost arriving; each copy now has a row that reds when only its own side is
 * reverted (the volume-root row in fsjson-symlink-fence.test.ts here, the predicate
 * row in plan-migration-fold-safety.test.ts there). `pathWithin` in plugin-use.ts
 * is deliberately not one of the copies: it folds, for the consent fence and its
 * other callers.
 */
function withinExactly(parent: string, child: string): boolean {
  const parentSegments = parent.split(path.sep);
  // A parent that IS a filesystem root splits with a trailing EMPTY segment
  // (`'/'` → `['', '']`, `'C:\\'` → `['C:', '']`) that no real child segment can
  // ever equal, so without this the check can never pass for a project rooted at
  // the volume root — a shape projectRootForStatePath deliberately supports
  // (`abs.slice(0, at) || path.sep`). MEASURED, decision only, on both volume
  // kinds: `stateWritePermitted('/.traffic-one/x.json')` is false with the
  // root-prefix check and true without it, so adding that check regressed every
  // state write for that shape. `pathWithin` has the identical hole, which is how
  // we know exactness is not the cause — comparing the root prefix at all is.
  // That hole is in the FUNCTION and not reachable from the product: all three
  // callers hand it a parent one segment below a root at least — `path.join(root,
  // STATE_DIR)` here and in removeDeclinedProjectArtifacts, `machineStateDir(env)`
  // (via globalTrafficOneDir, which always appends) in machineOwnedStatePath — so
  // it is left alone deliberately rather than pending a fix.
  if (parentSegments.length > 1 && parentSegments[parentSegments.length - 1] === '') parentSegments.pop();
  const childSegments = child.split(path.sep);
  if (childSegments.length < parentSegments.length) return false;
  return parentSegments.every((segment, i) => childSegments[i] === segment);
}

/**
 * The decision itself, with NO side effect — separated from `stateWriteGuard` so
 * the same rules can be asked as a question (`stateWritePermitted`) without
 * recording a refusal that never happened. Returns the reason when it refuses;
 * the recording wrapper turns that into the reported outcome.
 */
function classifyStateWrite(target: string): 'plain' | 'state' | RefusalReason {
  const root = pluginUse().projectRootForStatePath(target);
  // Not project state — an ordinary source file, a host config, or one of the
  // per-user machine dir's own entries (plugin-use.ts's deliberate allowlist,
  // where the consent answer itself lives).
  if (root === null) return 'plain';
  if (!pluginUse().projectStateWriteAllowed(target)) return 'consent-fence';
  // The LINK-ness is refused, not the destination, same rule as the
  // `.gitignore` writer: a link pointing back inside the state dir is refused
  // too, so nothing here has to reason about where it goes. On the platforms
  // where O_NOFOLLOW exists this is a fast pre-check the kernel repeats
  // atomically; on Windows, where it degrades to 0, it is the whole
  // final-component protection — and for `mkdir`/`rename`/`rm`, which have no
  // no-follow flag on any platform, it is the whole protection everywhere.
  if (isSymlink(target)) return 'symlink';
  // …and the containment half, which is what catches an INTERMEDIATE symlink:
  // no open flag can refuse those (measured), so the only way to see one is to
  // ask where the path really lands. The base is the state dir joined onto the
  // project root's REAL path — never the state dir's own realpath, which would
  // resolve `.traffic-one` itself when that is the planted link and declare the
  // link's target contained in itself.
  const realRoot = realPathWithMissingTail(root);
  const real = realPathWithMissingTail(target);
  if (realRoot === null || real === null) return 'unresolvable-path';
  // TWO PREDICATES, and the project root is required EXACTLY because folding it
  // reaches a sibling checkout on a case-sensitive filesystem (measured). The
  // STATE_DIR segment keeps the folding compare; `withinExactly` carries what that
  // costs and why it is still the better trade — it is NOT that folding there
  // widens this refusal, which is what a previous version of this comment claimed.
  if (!withinExactly(realRoot, real)) return 'escapes-state-dir';
  if (!within(path.join(realRoot, STATE_DIR), real)) return 'escapes-state-dir';
  return 'state';
}

function stateWriteGuard(target: string, op: string): Guard {
  const verdict = classifyStateWrite(target);
  return verdict === 'plain' || verdict === 'state' ? verdict : refuse(target, op, verdict);
}

/**
 * Would mutating `target` be permitted — the same question the primitives below
 * answer for themselves, asked WITHOUT performing or recording anything.
 *
 * For callers that must do work before they can write, where doing that work on a
 * path that will be refused is itself the problem. The decision log's trim is the
 * one: it reads the destination, derives the trimmed content, and only then
 * replaces the file, so without this it read THROUGH a planted link and left up
 * to a megabyte of the link target's bytes in a project temp file before the
 * final move was refused. Everything that simply writes must NOT use this —
 * checking here and writing later is a TOCTOU window, and the primitives already
 * decide atomically.
 */
export function stateWritePermitted(target: string): boolean {
  const verdict = classifyStateWrite(target);
  return verdict === 'plain' || verdict === 'state';
}

/**
 * Run the mutation and report what happened.
 *
 * ELOOP is turned into the same reported refusal the pre-open check produces:
 * it means the path became a symlink inside the check→open window, which is a
 * refusal the kernel made on our behalf and not a failure the caller did
 * anything about. Every other error still propagates exactly as it did before —
 * EACCES, ENOSPC and EISDIR are the caller's problem, and swallowing them here
 * would turn a full disk into a silent no-op.
 */
function act(target: string, op: string, guard: Guard, body: () => void): boolean {
  if (guard === 'refused') return false;
  try {
    body();
  } catch (error) {
    const errno = errnoOf(error);
    if (guard === 'state') recordStateWrite({ path: target, op, ok: false, errno });
    if (errno === 'ELOOP') return false;
    throw error;
  }
  if (guard === 'state') recordStateWrite({ path: target, op, ok: true });
  return true;
}

// Atomic write (temp + rename): parallel hook processes read/write the same
// state files (.one.json, manifests), so a plain writeFileSync can be torn —
// a concurrent reader then sees invalid JSON, falls back to {}, and may
// rewrite freshly-detected state over the real one.
//
// ATOMIC, NOT DURABLE — no fsync, deliberately. `writeJsonDurable` below is the
// fsync-fd -> rename -> fsync-dir sibling; its docblock carries the measured
// cost (+8.8 ms a call, and +47 ms / 17x on a floor-case hook invocation, which
// makes FIVE calls to this function) and THE RULE for which of the two a new
// writer wants. This is the default; reach for the other one only when that
// rule says the artifact qualifies.
//
// Returns whether it wrote, like all five of its siblings below. It used to
// return `void`, which made its refusal UNDETECTABLE: decision-log.ts's
// nextHookSeq persisted a counter through here and could not tell a refused
// write from a durable one, so it re-minted the same sequence number on the
// next call and two hook invocations claimed one correlation id in the log an
// operator was reading to tell them apart.
export function writeJson(filePath: string, value: unknown): boolean {
  const guard = stateWriteGuard(filePath, 'write-json');
  // The temp file is a sibling of the destination, so the destination's
  // containment check already covers every directory component it has; only its
  // own final component can be a planted link, and O_NOFOLLOW refuses that.
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  return act(filePath, 'write-json', guard, () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      writeFileNoFollow(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'truncate');
      fs.renameSync(tmpPath, filePath);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    }
  });
}

/**
 * writeJson's DURABLE sibling: the same fence, the same symlink refusal, the
 * same boolean, plus an `fsync` before the rename.
 *
 * AS DURABLE AS NODE CAN BE ON macOS, which is not the same as power-loss safe:
 * Darwin's `fsync(2)` empties the kernel cache but does not force the drive to
 * flush its own, and the call that does — `fcntl(F_FULLFSYNC)` — has no Node
 * binding (nor does `F_BARRIERFSYNC`), so closing the gap would need a native
 * addon the dependency-free hook runtime rules out. Read every "durable" below
 * as "survives a process crash, a host kill and a racing writer" — the failures
 * this codebase observes — and not as "survives a power cut". The rule that
 * follows is unaffected: a retracted commitment is just as bad from a crash.
 *
 * ── why a sibling and not durability in writeJson ────────────────────────────
 * Measured on this machine (APFS, 400 writes after 50 warm, payload size made no
 * difference across 120B/900B/8000B — the cost is the journal barrier, not the
 * data): tmp+rename 0.13-0.33 ms; +fsync(file) 4.0 ms; +fsync(dir) 8.0 ms. A
 * directory fsync with nothing pending is 0.02 ms, so the ~4 ms it adds here IS
 * the pending rename's transaction.
 *
 * Re-measured independently since, same machine, same method, at three payload
 * sizes an order of magnitude apart (84 B / 1.3 KB / 40 KB, 400 writes after 50
 * warm at each, three separate runs): writeJson p50 0.16-0.29 ms,
 * writeJsonDurable p50 7.9-9.1 ms. The delta is ~8.8 ms and it does not move
 * with the payload — a 478x size increase moves it by less than the run-to-run
 * spread — so the figure is the barrier and it has not drifted.
 *
 * Then the denominator, measured over 133 real `runPipeline` invocations (the
 * replay corpus plus the materializing session/converge suites): a PreToolUse
 * invocation performs a median of 5 `writeJson` calls and 12 at p95. Durability
 * in writeJson for every caller therefore costs 44 ms median and 106 ms p95 —
 * most of it spent on run-ledger and agent-registry churn that is rebuilt from
 * scratch on the next hook anyway. That is not affordable, so the property goes
 * where it is load-bearing instead: the canonical `.one.json` publish
 * (state/normalize.ts), 3 writes median / 4 at p95 per PreToolUse.
 *
 * The re-measurement makes the same case in the shape that is harder to argue
 * with, because it does not need the corpus. Driven against the THINNEST project
 * a gate will still run on — materialized, no run team, no claims, no registry —
 * one denying PreToolUse invocation performs TEN state writes, FIVE of them
 * `writeJson`, and takes 2.94 ms p50 end to end (400 samples after 30 warm,
 * three runs, p50 2.93/2.94/2.94). Routing those five through here is +47 ms:
 * 50 ms p50, 17x slower, on the floor case, before any of the churn the corpus
 * measures. That is not a derivation — it is a DIRECT A/B between two trees, the
 * shipped one and a copy whose `writeJson` body is this function, driven by the
 * same fixture on the same machine, because a same-process A/B is not available
 * here: reassigning the module's export does NOT reroute a consumer under this
 * loader, and a measurement that patches it silently compares A against A.
 *
 * The two figures are not the same arithmetic and neither is a derivation of
 * the other: 5 x 8.8 ms is +44 ms, and +47 ms is what the end-to-end A/B
 * MEASURED. The per-call model is a floor rather than an identity — three
 * milliseconds of it are not accounted for by the five calls — so quote the
 * measured number and say it is measured.
 *
 * TWO EARLIER FIGURES WERE WRONG, both by undercounting the same thing, so the
 * next reader does not re-derive either. "3 state writes, 1 of them writeJson,
 * +7.9 ms" and "3 state writes, +24 ms, 7.6x" both come from
 * `drainStateWrites()` called AFTER the invocation returns — but core/pipeline.ts
 * drains that buffer at settle and writes it into the decision record, so a
 * post-run drain sees only the 3 writes that happen after the drain, of which 1
 * is a `writeJson`. __tests__/durable-writer-rule.test.ts pins the count from
 * the union of exactly those two production surfaces, so the multiplier this
 * paragraph rests on cannot silently move again.
 *
 * That union is the whole population OF THE FLOOR CASE, not structurally, and
 * the two gaps both point the same way. A write to a PLAIN path — anything
 * outside a project's `.traffic-one/` — is recorded by neither surface, because
 * `recordStateWrite` is only reached for `state` writes; and both surfaces are
 * bounded (state-write-log.ts's MAX_BUFFERED_WRITES is 64, and appendDecision
 * bounds again), so an invocation that writes more than that is truncated. A
 * materializing invocation hits both. Both errors UNDERCOUNT, which weakens
 * this paragraph's own argument rather than inflating it: the real multiplier
 * is at least five, so durability-for-everyone costs at least +44 ms.
 *
 * session-updates-surface's 15 ms marker budget says NOTHING about this writer
 * and is not evidence either way: that path writes its markers with
 * `writeTextFile` (shared/once.ts) and performs no `writeJson` at all, so making
 * `writeJson` durable cannot move it. A previous version of this docblock
 * offered it as the tightest constraint; it was the wrong writer. A version
 * after that reached for hook-timing's 150 ms Write budget instead and claimed
 * the corpus p95 breached it; that was the wrong arithmetic — it multiplied a
 * PreToolUse write count against a SessionStart p95, and against the row the
 * count belongs to the sum is comfortably inside the budget. Deleted rather
 * than repaired: the floor-case A/B above already carries the argument, and a
 * breach claim a careful reader can dismantle only undermines the part that is
 * solid.
 *
 * ── THE RULE, so the next writer does not have to re-derive it ───────────────
 * Use `writeJsonDurable` when the artifact records a fact that was MINTED ONCE
 * and has already been OBSERVED OFF THIS MACHINE — where a power loss does not
 * lose work, it silently retracts a commitment somebody else has already acted
 * on. Two families qualify today and they are the entire durable set:
 *
 *   - the canonical `.one.json` (state/normalize.ts), which carries the project
 *     uid and the one-mcp report id — both minted once, both quoted outside;
 *   - the one-mcp report status and payload (runners/one-mcp-report/**), which
 *     name the report id a reporter has been handed.
 *
 * Everything else uses `writeJson`, and that is the same property stated the
 * other way rather than laxity: a run ledger, an agent registry, a claims store,
 * a compiled contract, a decision log's sequence counter and a QA artifact are
 * each re-derived or re-minted by the next hook invocation, so a rollback of the
 * last few seconds is invisible to every reader. Nothing in the non-durable set
 * is the only record of a promise. `writeJsonSet` matches `writeJson` for the
 * separate reason its own docblock gives.
 *
 * ENFORCED, because an unenforced convention is how the writer half of "one
 * durable writer" went missing in the first place: __tests__/durable-writer-
 * rule.test.ts pins the caller allowlist above AND drives the real `writeState`
 * to assert the op recorded at this chokepoint is `write-json-durable`. It
 * bounds the durable set and catches its two members being quietly demoted; it
 * cannot classify a NEW artifact, which is what the rule is for.
 *
 * ── why the recipe is lifted, not designed ───────────────────────────────────
 * Body taken from runners/one-mcp-report/lib.ts's private writeJson, which
 * already had it: exclusive temp open, write, fsync the fd, close, rename, then
 * fsync the DIRECTORY inside a try/catch. That writer WAS unfenced and returned
 * `void` — durability outside the chokepoint, while the chokepoint had fencing
 * without durability, and no writer had both. It has since been retired onto
 * this function (it was publishing the canonical `.one.json`, and a planted
 * directory link at `.traffic-one` sent both its files outside the project),
 * so the split this paragraph describes is history rather than a live state of
 * the tree — kept because it is why the recipe is lifted rather than designed.
 *
 * ONE deliberate deviation: the lifted version creates a new file 0o600. Here a
 * new file gets whatever `writeJson` would have given it, and only an EXISTING
 * destination's mode is preserved — `.one.json` is a committed, shared file and
 * 30-odd writeState callers must not silently start narrowing its permissions.
 *
 * The temp name carries pid+time+random like the lifted original rather than
 * writeJson's pid-only name: the open is O_EXCL (which is also what refuses a
 * planted link at the temp path on every platform, O_NOFOLLOW or not), so a
 * stale temp from a recycled pid would be an EEXIST — and act() rethrows
 * everything but ELOOP, which would surface as a fail-closed
 * `pipeline-handler-crashed` deny.
 */
export function writeJsonDurable(filePath: string, value: unknown): boolean {
  const guard = stateWriteGuard(filePath, 'write-json-durable');
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  return act(filePath, 'write-json-durable', guard, () => {
    fs.mkdirSync(dir, { recursive: true });
    try {
      let mode: number | undefined;
      try { mode = fs.statSync(filePath).mode & 0o777; } catch { /* new file: writeJson's default */ }
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;
      const fd = mode === undefined ? fs.openSync(tmpPath, flags) : fs.openSync(tmpPath, flags, mode);
      try {
        writeAll(fd, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, filePath);
      // The file is durable before rename; persist the directory entry when the
      // platform supports directory fsync as well.
      let dirFd: number | null = null;
      try {
        dirFd = fs.openSync(dir, DIR_SYNC_FLAGS);
        fs.fsyncSync(dirFd);
      } catch {
        // Some filesystems reject directory fsync. Atomic rename still applies.
      } finally {
        if (dirFd !== null) try { fs.closeSync(dirFd); } catch { /* best-effort */ }
      }
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    }
  });
}

/** One member of a write set: where it goes and what goes there. */
export interface JsonWrite {
  readonly path: string;
  readonly value: unknown;
}

/**
 * Publish several JSON artifacts as ONE update, so a REFUSAL cannot land part
 * of it.
 *
 * ── the defect this exists for ───────────────────────────────────────────────
 * Not a lost write: TWO ARTIFACTS ON DISK THAT DISAGREE, each writer
 * individually looking fine. `writeJson(a, …); writeJson(b, …)` with both
 * booleans carrying the same derived fact is the shape — refuse either one and
 * the survivor describes a state the other has never heard of. Ordering the
 * pair and consuming the first boolean (`if (!writeJson(a, …)) return;`) closes
 * ONE direction only; the second write's refusal still leaves `a` advanced and
 * `b` behind. tests/refusal-contract.test.ts's rule 4 reports the pairs a parse
 * can see and says outright that it cannot make them atomic.
 *
 * ── THE GUARANTEE, STATED AS A BOUND RATHER THAN AS ATOMICITY ────────────────
 * Read this before relying on it. It is NOT all-or-nothing against a crash, and
 * a primitive that claimed otherwise would be worse than none.
 *
 *   ALL-OR-NOTHING against REFUSAL, exactly. Every path is classified before
 *   anything is staged, so a consent-fenced, symlinked, escaping or
 *   unresolvable member declines the WHOLE set with nothing written. This is
 *   the entire failure class above: every divergence found in this codebase was
 *   a refusal landing on one path and not the other.
 *
 *   ALL-OR-NOTHING against a STAGING errno too. The payloads are written to
 *   temp siblings first, so ENOSPC or EACCES on the third member throws with
 *   the first two still only staged — where the sequential shape would have
 *   landed them.
 *
 *   BOUNDED, NOT CLOSED, against a crash or a rename-time errno. Committing N
 *   paths is N `rename` syscalls and POSIX has no multi-path commit; a journal
 *   is the only thing that would, and this layer has none. The window is the
 *   commit loop: N-1 renames with no I/O and no allocation between them, every
 *   payload already staged and every fence decision already made. A SIGKILL or
 *   a rename failure inside it leaves a PREFIX of the set landed.
 *
 * So order the set by descending authority — the artifact every reader consults
 * first — and a prefix landing degrades to exactly the ordered-writes behaviour
 * this replaces, never to something worse.
 *
 * Durability matches `writeJson`, not `writeJsonDurable`: an fsync per member
 * would cost 4 ms each (see writeJsonDurable's measurement) and buy no
 * atomicity, because the residual window above is the rename loop rather than
 * the data.
 *
 * An EMPTY set is `true`. Nothing was declined, because nothing was asked.
 */
export function writeJsonSet(entries: readonly JsonWrite[]): boolean {
  if (entries.length === 0) return true;
  // ── decide the WHOLE set before touching anything ──────────────────────────
  // classifyStateWrite has no side effect, which is what makes an up-front pass
  // over every member possible — and the reason `stateWritePermitted`'s TOCTOU
  // warning does not apply here. That warning is about checking and then
  // writing THROUGH an unguarded path; these members are still committed with
  // O_NOFOLLOW staging, so the kernel re-decides the final component anyway.
  const verdicts = entries.map((entry) => classifyStateWrite(entry.path));
  if (verdicts.some((verdict) => verdict !== 'plain' && verdict !== 'state')) {
    // Every member is reported, not just the refused one: the operator reading
    // `stateWrites` needs to see that an UPDATE was declined, and a log naming
    // only the fenced path reads as "one write failed" — which is the
    // misdiagnosis this whole primitive exists to prevent.
    entries.forEach((entry, index) => {
      const verdict = verdicts[index]!;
      recordStateWrite({
        path: entry.path,
        op: 'write-json-set',
        ok: false,
        errno: verdict === 'plain' || verdict === 'state' ? 'write-set-refused' : verdict,
      });
    });
    return false;
  }

  const staged = entries.map((entry, index) => ({
    entry,
    // Unique per member as well as per process: two members of one set are
    // siblings in the same directory often enough (run.json + maintenance.json)
    // that a pid-only name would collide inside a single call.
    temp: `${entry.path}.${process.pid}.${index}.set.tmp`,
    state: verdicts[index] === 'state',
  }));
  const discard = (): void => {
    for (const { temp } of staged) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  };

  try {
    for (const { entry, temp } of staged) {
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      writeFileNoFollow(temp, `${JSON.stringify(entry.value, null, 2)}\n`, 'truncate');
    }
  } catch (error) {
    discard();
    const errno = errnoOf(error);
    for (const { entry, state } of staged) {
      if (state) recordStateWrite({ path: entry.path, op: 'write-json-set', ok: false, errno });
    }
    // Same split as `act`: ELOOP is the kernel making the refusal the pre-check
    // would have made, everything else is the caller's problem and must not
    // become a silent no-op.
    if (errno === 'ELOOP') return false;
    throw error;
  }

  // ── the bounded window ─────────────────────────────────────────────────────
  try {
    for (const { entry, temp } of staged) fs.renameSync(temp, entry.path);
  } catch (error) {
    discard();
    const errno = errnoOf(error);
    for (const { entry, state } of staged) {
      if (state) recordStateWrite({ path: entry.path, op: 'write-json-set', ok: false, errno });
    }
    // NOT converted to `false`, even for ELOOP: unlike every other refusal here
    // a failure at this point may have landed a prefix, and reporting that as a
    // clean refusal is the lie the docblock's bound exists to avoid. It escapes
    // as the loud fail-closed deny the pipeline makes of any errno.
    throw error;
  }
  discard();
  for (const { entry, state } of staged) {
    if (state) recordStateWrite({ path: entry.path, op: 'write-json-set', ok: true });
  }
  return true;
}

/**
 * What an exclusive create did. Three values, because "it already existed" is a
 * NORMAL and load-bearing answer here — it is the losing side of a
 * compare-and-swap — and must not be confused with the fence declining us.
 */
export type ExclusiveCreate = 'created' | 'exists' | 'refused';

/**
 * Create `filePath` with `value` ONLY if nothing is there. The fenced,
 * symlink-safe equivalent of `writeFileSync(…, { flag: 'wx' })`.
 *
 * This exists because writeJson above cannot express exclusivity: it renames
 * over the destination, which is what makes it atomic and also what makes it
 * unable to be a compare-and-swap. A caller that needs "exactly one of us wins
 * this filename" (state/run-agent/claims-store.ts's role-keyed pending claim)
 * gets it here instead of reaching past these helpers into raw `fs` — which is
 * the whole reason this module has a fenced equivalent for every mutation.
 *
 * `exists` never distinguishes a rival's file from a planted symlink at the
 * path (O_EXCL reports both as EEXIST), so the link case is separated after the
 * fact and reported as `refused`. Asking afterwards is sound rather than a
 * TOCTOU window: on EEXIST nothing was written under either reading, and the
 * question being answered is only "what should we tell the caller".
 */
export function createJsonExclusive(filePath: string, value: unknown): ExclusiveCreate {
  const guard = stateWriteGuard(filePath, 'create-json');
  if (guard === 'refused') return 'refused';
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    createFileNoFollow(filePath, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    const errno = errnoOf(error);
    if (guard === 'state') recordStateWrite({ path: filePath, op: 'create-json', ok: false, errno });
    // EEXIST is the CAS losing, not a failure — unless what is there is a
    // symlink, in which case we declined to write through it and the caller must
    // not read that as "a rival holds this slot".
    if (errno === 'EEXIST') return isSymlink(filePath) ? 'refused' : 'exists';
    if (errno === 'ELOOP') return 'refused';
    throw error;
  }
  if (guard === 'state') recordStateWrite({ path: filePath, op: 'create-json', ok: true });
  return 'created';
}

// ── Guarded raw-file primitives ──────────────────────────────────────────────
// The fenced equivalents of fs.writeFileSync / appendFileSync / mkdirSync /
// rmSync for callers whose payload is not JSON. Each returns whether it acted,
// so a caller that needs to know (a once-marker deciding "did I claim this?")
// can branch instead of assuming success.

export function writeTextFile(filePath: string, text: string): boolean {
  const guard = stateWriteGuard(filePath, 'write-text');
  return act(filePath, 'write-text', guard, () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileNoFollow(filePath, text, 'truncate');
  });
}

export function appendTextFile(filePath: string, text: string): boolean {
  const guard = stateWriteGuard(filePath, 'append-text');
  return act(filePath, 'append-text', guard, () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileNoFollow(filePath, text, 'append');
  });
}

/**
 * `appendTextFile`'s DURABLE sibling: the same fence, the same no-follow open,
 * the same boolean, plus the two barriers an append needs.
 *
 * Both barriers carry the macOS ceiling `writeJsonDurable` states: `fsync(2)`
 * without `F_FULLFSYNC` does not flush the drive's own cache, so an append that
 * has returned can still be lost to a power cut while surviving every crash.
 *
 * TWO fsyncs, because an append has two commits and syncing one is the classic
 * half-fix:
 *
 *   - the FD, which is what makes the appended LINE durable;
 *   - the PARENT DIRECTORY, which is what makes a NEWLY CREATED file durable.
 *     An unsynced directory entry loses the whole file, not just the last line,
 *     so "we just fsynced the data" does not cover it.
 *
 * The directory fsync is UNCONDITIONAL rather than gated on "did this call
 * create the file". The gate is available — stat before the open — and it is a
 * race this primitive would lose silently in the one direction that costs the
 * whole file: two appenders arriving together both see the file absent, or both
 * see it present, and the one that actually created it can be the one that
 * decided not to sync the directory.
 *
 * What the gate would buy is the no-op case, and that case is MEASURED: a
 * directory fsync with nothing pending costs 0.02 ms on this machine (APFS, 400
 * calls after 50 warm — the same run that produced `writeJsonDurable`'s figures
 * above, where the same call costs 4.0 ms when a rename IS pending, which is
 * how we know 0.02 is the empty barrier and not a mis-timed one). Two
 * hundredths of a millisecond is not worth a silent hole, so the gate is not
 * taken.
 *
 * `O_APPEND` is what makes the write land at EOF ATOMICALLY under concurrency —
 * `appendAll` therefore writes at the fd's own offset, never at an explicit
 * position, which would silently become a `pwrite` at byte 0 (see
 * fs-nofollow.ts's note; the decision log lost a record to exactly that).
 *
 * WHO SHOULD USE THIS: the same rule as `writeJsonDurable` — an artifact
 * recording a fact MINTED ONCE and already OBSERVED OFF THIS MACHINE, where a
 * power loss does not lose work but silently retracts a commitment somebody
 * else has already acted on. An append-only LEDGER of such facts is the shape
 * `writeJsonDurable` cannot serve, because that writer renames a whole document
 * over the destination and an append-only log has no whole document to publish.
 * Its caller set is bounded by the SAME allowlist
 * (__tests__/durable-writer-rule.test.ts), which scans for both primitives: this
 * one has NO production caller yet, and that emptiness is asserted rather than
 * argued in prose. It used to be exempted here on the grounds that the allowlist
 * only scanned for `writeJsonDurable(` — which is how a bound becomes a
 * convention nobody checks. The rule in `writeJsonDurable`'s docblock governs
 * both.
 */
export function appendTextFileDurable(filePath: string, text: string): boolean {
  const guard = stateWriteGuard(filePath, 'append-text-durable');
  const dir = path.dirname(filePath);
  return act(filePath, 'append-text-durable', guard, () => {
    fs.mkdirSync(dir, { recursive: true });
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | O_NOFOLLOW;
    const fd = fs.openSync(filePath, flags);
    try {
      appendAll(fd, Buffer.from(text, 'utf8'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    let dirFd: number | null = null;
    try {
      dirFd = fs.openSync(dir, DIR_SYNC_FLAGS);
      fs.fsyncSync(dirFd);
    } catch {
      // Some filesystems reject directory fsync. The line itself is durable.
    } finally {
      if (dirFd !== null) try { fs.closeSync(dirFd); } catch { /* best-effort */ }
    }
  });
}

// Creating a directory is a write too. The writers above all mkdir their own
// parent, so nothing here needs a bare fenced mkdir; this exists for the callers
// whose mkdir is the WHOLE mutation — a lock directory, a run directory created
// ahead of the file that will live in it. On a PRISTINE project with the question
// unanswered those were the entire remaining residue: three empty directories,
// no files, from state/project-state-lock.ts (`.traffic-one/` itself),
// state/run-agent/locks.ts and state/run-agent/ledger.ts (`runs/<id>/`). All
// three now route through here and each turns the `false` into its own domain's
// failure — an unacquired lock, a rejected ledger transition — because a refusal
// they swallowed would be worse than the directory it removed.
//
// `mkdir` has no O_NOFOLLOW: a recursive mkdir walks THROUGH an intermediate
// symlink and creates the subtree inside its target (measured), and there is no
// flag on any platform that refuses that. So here the containment check is not
// a pre-check for something the kernel repeats — it is the entire protection,
// with a window between it and the mkdir that cannot be closed from userland.
// What bounds the residual risk is that a directory created in the wrong place
// destroys nothing, and every FILE that would then be written into it comes back
// through the guarded writers above and is refused on its own containment check.
export function ensureDir(dirPath: string): boolean {
  const guard = stateWriteGuard(dirPath, 'mkdir');
  return act(dirPath, 'mkdir', guard, () => {
    fs.mkdirSync(dirPath, { recursive: true });
  });
}

// A move is a write at the destination AND a delete at the source, so BOTH ends
// are checked and either refusal refuses the whole move. Doing half of one is
// how data disappears: materialize's preserveManualRootContext deleted a
// hand-written root AGENTS.md after the fence had already refused the copy that
// was supposed to preserve it, so the content was not overwritten but destroyed.
// Callers migrating a legacy file into `.traffic-one/` (materialize/cleanup.ts)
// get that guarantee from here instead of re-deriving it. Byte-preserving on
// purpose — `renameSync`, never a read/write round-trip, which would corrupt any
// file that is not valid UTF-8.
//
// Both ends get the symlink fence too, and for the same reason they both get the
// consent one: an intermediate symlink on either side relocates a file into, or
// out of, somewhere that is not this project's state (measured: `rename` follows
// intermediate components; only the two FINAL components it leaves alone, moving
// the link itself rather than what it points at). A root file being migrated
// INTO the state dir has a source that is not state at all, so that end keeps
// today's behaviour — including the deliberate `CLAUDE.md` -> `AGENTS.md` link.
export function movePath(fromPath: string, toPath: string): boolean {
  const toGuard = stateWriteGuard(toPath, 'move-to');
  if (toGuard === 'refused') return false;
  const fromGuard = stateWriteGuard(fromPath, 'move-from');
  if (fromGuard === 'refused') return false;
  return act(toPath, 'move', toGuard === 'state' || fromGuard === 'state' ? 'state' : 'plain', () => {
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.renameSync(fromPath, toPath);
  });
}

// Deleting is a write. The product contract's pending half is byte-identity,
// and a sweep that reclaims 70 paths from a project that never consented is
// the irreversible half of breaking it.
//
// The symlink fence matters MOST here and differently: `rm` on a link removes
// the link (measured — the target survives), but an intermediate link makes a
// recursive delete land on someone else's tree, and unlike a misplaced write
// that one is not recoverable. A planted link under the state dir is therefore
// refused rather than reclaimed: leaving it is inert (nothing writes through it
// any more), and "provably non-destructive" is the posture this codebase already
// takes for a path it cannot vouch for.
export function removePath(target: string): boolean {
  const guard = stateWriteGuard(target, 'remove');
  return act(target, 'remove', guard, () => {
    fs.rmSync(target, { recursive: true, force: true });
  });
}

export const fsjson: FsJson = { readText, readJson, writeJson };
