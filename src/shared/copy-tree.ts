// src/shared/copy-tree.ts
// A TREE COPY THAT CANNOT REPORT A BACKUP IT DID NOT TAKE.
//
// `bounded-read.ts` bounds the read of ONE file and answers `false` for a source
// that is not a regular file; `copyRegularFile`'s docblock states the rule the
// caller survey yielded — "discarding `false` is survivable only where the
// destination's ABSENCE is itself the signal; where anything downstream RECORDS
// that the copy happened, the answer has to be raised". This file is that rule
// applied to a DIRECTORY, because the two backup writers in this tree copy
// directories and `fs.cpSync` cannot satisfy it.
//
// ── WHAT cpSync ACTUALLY DOES, DRIVEN, AND WHAT THE LEDGER CLAIMED ───────────
// `EXCUSED`'s three `cpSync` rows read "node classifies with lstat first and
// throws ERR_FS_CP_FIFO_PIPE / ERR_FS_CP_SOCKET / ELOOP rather than opening".
// That is FALSE on the node this repo ships against (v26.5.0), and the false
// version is recorded here rather than corrected out of sight, because the two
// substitutions are worse than the codes they replace:
//
//   a FIFO or a unix socket INSIDE the copied tree is SILENTLY OMITTED. `cpSync`
//   returns success in ~2 ms and the destination simply does not contain it, so a
//   snapshot is recorded as taken while being incomplete.
//
//   a genuine SYMLINK LOOP inside the tree ABORTS THE PROCESS — an uncaught C++
//   `std::filesystem_error` out of `weakly_canonical`, exit 134, which neither a
//   `try/catch` nor an `uncaughtException` handler can see. A `catch { /*
//   best-effort */ }` around the copy cannot catch it, and git stores every
//   symlink as a mode-120000 blob, so a loop arrives through a pull request.
//
// The cost of the first is what this file exists to remove: `git-sandbox.ts`'s
// pre-apply backup records `{ existed: true, backupPath }` after the copy and
// `restoreApplyTargets` `rmSync`s the target BEFORE restoring, so an incomplete
// directory backup makes the rollback delete what it exists to protect — while
// reporting a clean rollback. The cost of the second is a runner that dies
// without a decision record.
//
// ── SO: REFUSE, DO NOT DEREFERENCE, AND NEVER OMIT ──────────────────────────
// Three kinds are copied and everything else THROWS: a regular file (through
// `copyRegularFile`, which decides on the DESCRIPTOR it opened), a directory
// (recursed), and a symlink (RECREATED, never followed — which is also why a loop
// cannot be traversed here: the link is a name to write, not a path to walk).
// A FIFO, a socket or a device node stops the copy with a message naming the entry,
// which is what turns "the backup is incomplete" into "there is no backup", the
// one thing every caller here already knows how to handle.
//
// The refusal is deliberately not a filter. An entry skipped with a warning is
// exactly the outcome measured above — a snapshot that reports success and cannot
// reconstruct the tree — and no caller in this tree can tell the difference
// afterwards, because both leave the destination missing the entry.

import * as fs from 'fs';
import * as path from 'path';

import { copyRegularFile } from './bounded-read';

function kindOf(stat: fs.Stats): string {
  if (stat.isFIFO()) return 'a FIFO';
  if (stat.isSocket()) return 'a socket';
  if (stat.isCharacterDevice()) return 'a character device';
  if (stat.isBlockDevice()) return 'a block device';
  return 'not a regular file';
}

/**
 * Copy `source` onto `destination` — a file, a directory tree or a symlink —
 * THROWING on the first entry that is none of those.
 *
 * Overwrites, like the `cpSync(..., { force: true })` it replaces: an existing
 * destination entry is removed before a link is recreated and truncated before a
 * file is written. Every caller here copies into a fresh backup root, so the
 * behaviour is only ever exercised by a restore writing back over the target.
 */
export function copyTreeStrict(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(source);
    try { fs.rmSync(destination, { recursive: true, force: true }); } catch { /* nothing to replace */ }
    fs.symlinkSync(target, destination);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyTreeStrict(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  // REFUSED FROM THE `lstat`, BEFORE ANY `open`, and then AGAIN on the descriptor.
  // Both halves are load-bearing and for different reasons. Without the first,
  // a unix socket reaches `copyRegularFile`'s `openSync` and node answers with
  // `Unknown system error -102` (ENOTSUP) — DRIVEN, arm `dir-with-socket` — a throw
  // that names neither the kind nor the remedy, and an errno string is not something
  // a caller can be asked to interpret. Without
  // the second, the name could be substituted between the two calls by anybody who
  // can write in the directory, so the kind test that DECIDES stays on the
  // descriptor `copyRegularFile` opened; the `lstat` only supplies the word for
  // what was refused.
  if (!stat.isFile()) {
    throw new Error(`cannot copy ${source}: ${kindOf(stat)} — refusing to record an incomplete copy`);
  }
  if (!copyRegularFile(source, destination)) {
    throw new Error(`cannot copy ${source}: ${kindOf(stat)} — refusing to record an incomplete copy`);
  }
}
