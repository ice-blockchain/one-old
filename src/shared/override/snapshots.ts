// src/shared/override/snapshots.ts
// The pre-override snapshots, read as EVIDENCE OF MINTS rather than as the
// forensic dump they were written to be.
//
// A mint writes the snapshot first and the ledger line second (token.ts), so
// the two are separate files and only one of them is the thing an attacker
// thinks to remove. `rm overrides.jsonl` erases every line and leaves the whole
// snapshots directory standing; editing one line's MAC makes that line
// unvouchable while its snapshot stays exactly where it was. Both leave the
// same residue: a snapshot no line this install can vouch for accounts for.
//
// That residue is the finding. It is NOT read as "which run was overridden" —
// a snapshot is unsigned, and the same edit that orphaned it can rewrite its
// `runId` to name a run nobody cares about. It is read as "this project's
// ledger is not a complete record of its mints", which is a statement about the
// project and cannot be narrowed by anything the file itself claims.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { readJsonResult } from '../fsjson';
import { errnoOf } from '../state/state-write-log';
import { overrideSnapshotDir } from './paths';
import { readRegularBytesOrThrow } from '../bounded-read';

export interface OrphanSnapshot {
  /** The token id the file is named for. */
  readonly id: string;
  /** The run the snapshot claims, when it carries one. Unsigned: reported for
   *  the operator reading the doctor output, never used to narrow a verdict. */
  readonly runId: string | null;
}

export interface OverrideSnapshotScan {
  readonly orphans: OrphanSnapshot[];
  /**
   * False when the directory could not be listed or held more entries than the
   * bound below. An incomplete scan is not evidence of an orphan and is not
   * evidence against one either, so integrity.ts reports it as its own gap
   * rather than folding it into `orphans`.
   */
  readonly complete: boolean;
  /** Snapshot files seen in the directory, whether or not they were inspected.
   *  What an operator acknowledging an incomplete scan is acknowledging: the
   *  reconciliation covers that many files and no more (reconcile.ts). */
  readonly count: number;
  /**
   * Whether the directory was LOOKED AT. False is the caller's own "I did not
   * ask" — integrity.ts skips the scan on an illegible ledger — and it exists
   * because `{orphans: [], complete: true}` is the shape of a scan that ran and
   * found a clean bucket, which is a different fact and was being reported for
   * both.
   */
  readonly asked: boolean;
}

/** What integrity.ts substitutes when it deliberately does not scan. */
export const OVERRIDE_SNAPSHOT_SCAN_NOT_ASKED: OverrideSnapshotScan = {
  orphans: [], complete: true, count: 0, asked: false,
};

// A project that has legitimately minted 256 operator overrides has a problem
// this counter is not going to be the one to tell it about. The bound exists so
// a directory someone filled with junk cannot make settlement read it all.
const MAX_SNAPSHOT_SCAN = 256;

/**
 * Snapshots in this project's bucket that `named` does not account for.
 *
 * `named` is a set of FILE NAMES, matched EXACTLY, and the exactness is a fix
 * rather than a style choice. This used to strip one `.json` from the entry and
 * test the remainder for membership against a set holding both spellings (the
 * token id and the file name), which made `<sometokenid>.json.json` accounted
 * for by a line that had never heard of it: strip once, and the name a line
 * really did record comes back out. A snapshot is written by exactly one place
 * (token.ts) under exactly one name, so there is no second spelling to admit.
 *
 * `named` must be built from lines this install can VOUCH for — an unvouchable
 * line naming a snapshot excuses nothing, or a one-byte edit to a MAC would
 * both remove a line from the abuse guard and keep its snapshot from being
 * noticed. The cost of that choice is stated where it lands: a rotated
 * per-install key makes every previously minted line unvouchable, so every
 * snapshot it named becomes an orphan and the project stops being certifiable.
 * That is the same verdict the rotation already implies — an install that
 * cannot verify its own override history cannot certify runs against it.
 */
export function scanOrphanSnapshots(
  projectRoot: string,
  named: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): OverrideSnapshotScan {
  const dir = overrideSnapshotDir(projectRoot, env);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    // No directory means no mint ever got as far as writing one — the clean
    // install, and the only reading of a failed listing that is not a gap.
    return { orphans: [], complete: errnoOf(error) === 'ENOENT', count: 0, asked: true };
  }
  const files = entries.filter((name) => name.endsWith('.json')).sort();
  const orphans: OrphanSnapshot[] = [];
  for (const name of files.slice(0, MAX_SNAPSHOT_SCAN)) {
    const id = name.slice(0, -'.json'.length);
    if (named.has(name)) continue;
    const read = readJsonResult<Record<string, unknown>>(path.join(dir, name));
    const claimed = read.kind === 'ok' ? read.value.runId : null;
    orphans.push({ id, runId: typeof claimed === 'string' && claimed ? claimed : null });
  }
  return {
    orphans, complete: files.length <= MAX_SNAPSHOT_SCAN, count: files.length, asked: true,
  };
}

/**
 * A fingerprint of the orphan SET: every orphan's id paired with a digest of
 * its bytes, sorted, hashed once. '' when there are no orphans or any of them
 * could not be read.
 *
 * Content, not just names, because an acknowledgement keyed on names alone
 * would let the file behind an acknowledged name be swapped afterwards. And a
 * SET digest rather than a per-file list because the acknowledgement has to
 * lapse the moment the set changes at all: a new planted file must wedge again
 * (and be reconciled again) rather than ride in beside the ones an operator
 * already looked at.
 *
 * Read only on the reconciliation path and on the settlement path of a project
 * that already HAS a reconciliation on record — a clean install never hashes
 * anything, because it has no orphans to hash.
 */
export function orphanSnapshotSetDigest(
  projectRoot: string,
  orphans: readonly OrphanSnapshot[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (orphans.length === 0) return '';
  const dir = overrideSnapshotDir(projectRoot, env);
  const lines: string[] = [];
  for (const orphan of orphans) {
    let bytes: Buffer;
    try {
      bytes = readRegularBytesOrThrow(path.join(dir, `${orphan.id}.json`));
    } catch {
      // One unreadable orphan makes the whole set unfingerprintable, so nothing
      // is acknowledged rather than a subset silently being.
      return '';
    }
    lines.push(`${orphan.id}:${crypto.createHash('sha256').update(bytes).digest('hex')}`);
  }
  return crypto.createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

/** What the digest below reports for a bucket with no snapshot directory — the
 *  clean install, and a state an acknowledgement must be able to pin, so it
 *  cannot be the same '' that means "I could not look". */
export const OVERRIDE_SNAPSHOT_SET_ABSENT = 'absent';

/**
 * A fingerprint of WHICH snapshot files exist — every name in the directory,
 * sorted, hashed once. `OVERRIDE_SNAPSHOT_SET_ABSENT` when there is no
 * directory; '' when there is one and it could not be listed.
 *
 * This exists for the state integrity.ts deliberately does NOT scan. On an
 * illegible ledger the orphan question is unanswerable (every snapshot looks
 * orphaned), so the scan is skipped — and an operator acknowledging that state
 * is therefore acknowledging a state in which the orphan witness is switched
 * off. What they must be held to is the set of files that existed when they
 * looked, so a later mint's snapshot appearing under the blindfold re-refuses.
 *
 * NAMES ONLY, and unbounded because of it: no `stat`, no read, so a directory
 * someone filled with junk costs one `readdir` rather than N file reads, and
 * there is no bound past which this would have to return '' and turn a
 * fillable directory into an unrepairable wedge. Content is not pinned here
 * because content is not an input to any suppressed verdict — a mint always
 * arrives as a NEW name (a 96-bit id), and the moment the ledger is legible
 * again `orphanSnapshotSetDigest` above pins content for the orphans that
 * actually matter.
 */
export function overrideSnapshotNameDigest(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = overrideSnapshotDir(projectRoot, env);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    return errnoOf(error) === 'ENOENT' ? OVERRIDE_SNAPSHOT_SET_ABSENT : '';
  }
  return crypto.createHash('sha256').update(entries.sort().join('\n')).digest('hex');
}
