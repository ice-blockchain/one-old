// src/shared/fs-nofollow.ts
// The symlink-safety primitives, in ONE place: `fs.writeFileSync` /
// `appendFileSync` / `mkdirSync` / `rmSync` / `renameSync` all resolve symlinks,
// so a path someone else planted a link at redirects the write to the link's
// TARGET, anywhere on the filesystem. This module is what a writer that must not
// be redirected opens through. Extracted from the `.gitignore` TOCTOU fix in
// architecture-contract/scaffold-content.ts, which solved it first and still
// uses these — one implementation rather than two that can drift.
//
// TWO DIFFERENT holes, and closing either alone closes nothing:
//
//   - the FINAL component is a symlink. Closed by O_NOFOLLOW on the open, in
//     the kernel, atomically — which is what makes it a fix rather than a
//     narrowed window: an `lstat` guard ahead of the write can always be raced
//     by the path becoming a link in between. Measured on darwin: ELOOP, target
//     byte-identical, and ELOOP for a DANGLING link too — the case plain
//     `writeFileSync` does not merely follow but CREATES the target of.
//
//   - an INTERMEDIATE component is a symlink. O_NOFOLLOW says NOTHING about
//     those: measured, `open('<link-to-dir>/f.txt', O_CREAT|O_NOFOLLOW)`
//     succeeds and the file lands inside the link's target. Only a realpath
//     containment test catches those, and it needs a caller who knows where the
//     path is allowed to end up — hence `realPathWithMissingTail` here and the
//     containment rule itself in fsjson.ts, which knows the boundary.
//
// `fs.constants.O_NOFOLLOW` is UNDEFINED on Windows, so it degrades to 0 there —
// which would silently disable the first half. Every caller therefore keeps a
// pre-open `lstat` refusal that stands on its own, and no platform ends up with
// LESS protection than that check alone gave it.

import * as fs from 'fs';
import * as path from 'path';

export const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;

/** Does the kernel enforce the final-component refusal for us on this platform? */
export const nofollowEnforcedByKernel = O_NOFOLLOW !== 0;

/** Is `target` ITSELF a symlink? False when it does not exist or cannot be stat'd —
 *  the open/mkdir/rename that follows is the real decision in those cases. */
export function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Where `target` would REALLY land: every symlink in it resolved, including the
 * intermediate ones no open flag can refuse, with the not-yet-existing tail
 * appended literally.
 *
 * `null` means "refuse": either a component EXISTS but does not resolve — a
 * dangling symlink, the shape `realpathSync` reports as plain ENOENT and a naive
 * "walk up to the first ancestor that resolves" would step straight over — or no
 * ancestor resolves at all.
 */
export function realPathWithMissingTail(target: string): string | null {
  let cursor = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cursor), ...tail);
    } catch {
      // Not resolvable. A component that is NEVERTHELESS there is a dangling
      // link (or an ancestor we may not traverse): refuse, never skip past it.
      if (isSymlink(cursor)) return null;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null; // reached the filesystem root, still unresolved
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
}

// `writeSync` is permitted to write short; a regular file never does in
// practice, but a truncated state file is not a failure mode worth assuming
// away.
//
// `position` is the whole distinction between the two exports below, and getting
// it wrong is silent: an EXPLICIT position makes the write a `pwrite`, which
// ignores O_APPEND and lands at that offset — so appending with `writeAll` wrote
// every record at byte 0 and each append erased the one before it (measured: the
// decision log kept its second record and lost its first). An explicit position
// is equally load-bearing the other way, for a caller that has already read
// through the same fd and left its offset at EOF (ensureProjectGitignore).
function writeAllAt(fd: number, payload: Buffer, position: number | null): void {
  let written = 0;
  while (written < payload.length) {
    const at = position === null ? null : position + written;
    written += fs.writeSync(fd, payload, written, payload.length - written, at);
  }
}

/** Write `payload` as the file's first bytes, whatever the fd's offset is. */
export function writeAll(fd: number, payload: Buffer): void {
  writeAllAt(fd, payload, 0);
}

/** Write `payload` at the fd's OWN offset — for an O_APPEND fd, atomically at EOF. */
export function appendAll(fd: number, payload: Buffer): void {
  writeAllAt(fd, payload, null);
}

/**
 * Create-or-rewrite `absolute` without ever following a symlink AT it. Throws
 * exactly what `fs` throws (ELOOP for a link, EISDIR for a directory, EACCES,
 * ENOSPC, …) so a caller can tell a refusal from a real IO failure.
 */
export function writeFileNoFollow(absolute: string, text: string, mode: 'truncate' | 'append'): void {
  const append = mode === 'append';
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | O_NOFOLLOW
    | (append ? fs.constants.O_APPEND : fs.constants.O_TRUNC);
  const fd = fs.openSync(absolute, flags);
  try {
    const payload = Buffer.from(text, 'utf8');
    if (append) appendAll(fd, payload); else writeAll(fd, payload);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * READ `absolute` without ever following a symlink AT it — `writeFileNoFollow`'s
 * twin, and it exists because the write half alone protects nothing on the way
 * IN.
 *
 * A bare `readFileSync` on a path someone else planted a link at returns the
 * LINK TARGET's bytes, anywhere on the filesystem, and a caller that then copies
 * those bytes into a file inside the project has exfiltrated them. MEASURED:
 * `architecture.md` -> `../outside-secret.md` in a state-holding project put the
 * outside file's bytes into `.traffic-one/plan.md` and unlinked the link
 * (materialize/plan-migration.ts, peer row R11). The ownership gate in that same
 * module already refuses a SYMLINKED `.one.json` on the grounds that a link is
 * not evidence of what it names; this is the same rule for the read.
 *
 * Throws exactly what `fs` throws — ELOOP for a link, EISDIR for a directory,
 * EACCES, ENOENT — so a caller can tell a refusal from a real IO failure, and so
 * "I could not read it" never arrives as an empty string. Callers keep their own
 * pre-open `lstat` refusal for the same reason every writer here does: O_NOFOLLOW
 * is undefined on Windows and degrades to 0, where the check is the whole
 * protection.
 *
 * ── BOUNDED, and O_NOFOLLOW was never what bounded it ────────────────────────
 * This function used to open `O_RDONLY|O_NOFOLLOW` with no `O_NONBLOCK` and no
 * kind test, and the docblock above stopped at the link. O_NOFOLLOW refuses a
 * SYMLINK at the final component; it does not refuse a FIFO, a socket or a
 * device NAMED at that component, and `open(O_RDONLY)` on a FIFO with no writer
 * waits for one forever. So the twin of a write that cannot be redirected was
 * still a read that could never return — measured at three structurally
 * identical readers elsewhere in this tree (bounded-read.ts), and at this
 * module's own gate paths at 12 023 ms and 12 080 ms to SIGKILL
 * (.tmp/bounded-reads).
 *
 * The two flags do different jobs and neither substitutes for the other:
 *   O_NOFOLLOW  refuses a link AT the name — whose bytes answer.
 *   O_NONBLOCK  makes the open of a FIFO return instead of waiting — when.
 *   the fstat   converts every remaining non-regular shape into a refusal
 *               instead of an EOF, because an O_NONBLOCK FIFO reads as EMPTY.
 *
 * THE KIND TEST THROWS RATHER THAN ANSWERING `null`, unlike
 * `bounded-read.ts`'s `readRegularFile`, because this function's contract is
 * that it throws and its callers read `.code` off the error. A synthesized
 * `ENOTREG` would be a code no kernel produces on a real error object, which is
 * the same convention bounded-read.ts's `not-a-regular-file` and fsjson.ts's
 * `RefusalReason` already use in that field — an operator can tell our refusal
 * from the filesystem's. `EISDIR` is kept as the kernel's own answer for a
 * directory, which is what the unbounded version already threw from the read.
 *
 * THIS IS WHY THE CALLER'S PRE-OPEN `lstat` IS NOT THE FIX. Its one production
 * caller (materialize/plan-migration.ts) refuses a non-regular source with an
 * `lstatSync` before calling this, which HAPPENS to keep the FIFO away from the
 * open today — and that is precisely the classify-one-object-read-another
 * window bounded-read.ts argues against: anyone who can plant a FIFO can
 * substitute the name between the two calls. The primitive must not depend on a
 * caller's stat, so the kind is decided here, on the descriptor, and the
 * caller's lstat stays as the Windows fallback it also is.
 */
export function readFileNoFollow(absolute: string): string {
  const fd = fs.openSync(
    absolute,
    fs.constants.O_RDONLY | O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw Object.assign(
        new Error(`${absolute} is not a regular file`),
        { code: stat.isDirectory() ? 'EISDIR' : 'ENOTREG' },
      );
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * CREATE `absolute`, or fail with EEXIST because someone else got there first.
 * `O_CREAT|O_EXCL` is the kernel's compare-and-swap on a filename: the existence
 * test and the creation are one operation, so unlike an `existsSync` guard it
 * cannot be raced.
 *
 * Deliberately NOT a temp-file + rename like fsjson.ts's writeJson: a rename
 * REPLACES the destination, which is the exact opposite of the exclusivity being
 * asked for here. The payloads that use this are a single small JSON object, so
 * one `writeSync` carries the whole file, and every reader of these files parses
 * with a null fallback and skips what it cannot parse (claims-pending.ts's
 * readClaimFile) — a torn read is dropped, never misread as a different claim.
 *
 * O_EXCL also subsumes the final-component symlink refusal on every platform,
 * including the ones where O_NOFOLLOW degrades to 0: POSIX makes O_CREAT|O_EXCL
 * fail with EEXIST when the path names a symlink, whether or not its target
 * exists. O_NOFOLLOW is still passed so this file has one flag policy rather
 * than two. The caller therefore has to tell "a rival created it" from "a link
 * is planted there", which fsjson.ts does by asking after the fact — safe,
 * because on EEXIST nothing was written either way.
 *
 * Throws what `fs` throws, exactly like its sibling above.
 */
export function createFileNoFollow(absolute: string, text: string): void {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;
  const fd = fs.openSync(absolute, flags);
  try {
    writeAll(fd, Buffer.from(text, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}
