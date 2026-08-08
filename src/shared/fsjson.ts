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
import {
  O_NOFOLLOW,
  createFileNoFollow,
  isSymlink,
  realPathWithMissingTail,
  writeAll,
  writeFileNoFollow,
} from './fs-nofollow';
// A pure leaf (no imports of its own), so unlike plugin-use below this one
// cannot close a cycle and needs no lazy require.
import { errnoOf, recordStateWrite } from './state/state-write-log';

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

export function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
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
 */
export type JsonRead<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'absent' }
  | { readonly kind: 'corrupt'; readonly text: string }
  | { readonly kind: 'unreadable'; readonly errno: string };

export function readJsonResult<T = unknown>(filePath: string): JsonRead<T> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const errno = errnoOf(error);
    return errno === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', errno: errno ?? 'unknown' };
  }
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
 * ── why a sibling and not durability in writeJson ────────────────────────────
 * Measured on this machine (APFS, 400 writes after 50 warm, payload size made no
 * difference across 120B/900B/8000B — the cost is the journal barrier, not the
 * data): tmp+rename 0.13-0.33 ms; +fsync(file) 4.0 ms; +fsync(dir) 8.0 ms. A
 * directory fsync with nothing pending is 0.02 ms, so the ~4 ms it adds here IS
 * the pending rename's transaction.
 *
 * Then the denominator, measured over 133 real `runPipeline` invocations (the
 * replay corpus plus the materializing session/converge suites): a PreToolUse
 * invocation performs a median of 5 `writeJson` calls and 12 at p95. Durability
 * in writeJson for every caller therefore costs 38 ms median and 92 ms p95 — 62%
 * of the product's 150 ms pre-tool hook budget, most of it spent on run-ledger
 * and agent-registry churn that is rebuilt from scratch on the next hook anyway.
 * That is not affordable, so the property goes where it is load-bearing instead:
 * the canonical `.one.json` publish (state/normalize.ts), 3 writes median / 4 at
 * p95 per PreToolUse, i.e. 23 ms / 31 ms.
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
        dirFd = fs.openSync(dir, 'r');
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
