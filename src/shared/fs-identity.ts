// src/shared/fs-identity.ts
// WHICH DIRECTORY (or file) DOES THIS NAME REACH — asked of the filesystem, in
// the one spelling the filesystem itself uses: `dev:ino`.
//
// Two consumers arrived at the same six lines independently — `fileIdentity` in
// shared/retention.ts, deciding which `readdir` entries durable memory reaches,
// and the member matcher in hook/workspace-members.ts, deciding which registry
// entry a directory belongs to — and both did so for the same reason. A NAME is
// not an identity: case folding (APFS, NTFS), Unicode normalization, trailing
// dots and spaces, symlinks, bind mounts and whatever a locale or a volume flag
// does that nobody here has tested all make two spellings reach one directory.
// Asking the platform needs to be right about none of them, which is why both
// consumers refused to write a folding table and both landed here.
//
// ── THE PRIMITIVE IS SHARED; THE POLICIES ABOVE IT MUST NOT BE ───────────────
//
// This function answers "which object does this name reach". It does NOT answer
// "does that make them the same thing for my purposes", and the two callers
// genuinely disagree about that on the same input — measured, not supposed:
//
//   - RETENTION folds names UNCONDITIONALLY and uses identity as a BACKSTOP: it
//     is deciding what to keep, so a name it cannot resolve must still be
//     treated as reachable, and over-keeping costs disk while under-keeping
//     costs a user's durable memory.
//   - MEMBERSHIP refuses every fold and uses SPELLING as a shortcut: it is
//     deciding what a committed authorization list grants, so a name that only
//     looks like an entry grants nothing, and over-granting hands one project's
//     files to another.
//
// On a case-SENSITIVE volume a leaked root's `Plan.md` is therefore spared by
// retention while an entry `Api` claims nothing at all — the same two spellings,
// opposite answers, each running in the safe direction for its own consumer. A
// single shared rule cannot be safe in both directions at once, so anyone who
// later "simplifies" the two policies into one will be choosing which consumer
// to make unsafe. Share these lines; leave the policies where they are.
//
// Dependency-free (fs, path, nothing else): both callers sit on the hook
// resolution walk, and the hook runtime ships no npm packages.

import * as fs from 'fs';

/**
 * What the filesystem said about a name — with "it is not there" kept apart
 * from "we could not tell", because only one of them is evidence.
 *
 * A NULLABLE STRING CANNOT CARRY THIS, which is the whole reason this is a
 * union: `null` folds a positive finding (ENOENT — this name reaches nothing)
 * together with an inability (EACCES, EIO, a network mount blipping, a Spotlight
 * or antivirus hold), and a caller that must not act without evidence has no way
 * to tell them apart. The membership matcher's consumer is a DELETION sweep: a
 * transient stat failure read as "not the same directory" turns a live member
 * into a leaked nested root and removes its state file. Failing closed for an
 * authorization question and failing closed for a deletion are OPPOSITE
 * directions, and a caller can only pick the right one if it is told which of
 * the two it is looking at.
 */
export type FsIdentity =
  | { readonly kind: 'identity'; readonly id: string }
  /** The name reaches nothing (ENOENT/ENOTDIR). A FINDING: callers may act on it. */
  | { readonly kind: 'absent' }
  /** It is there, and it is not the kind that was required. Also a finding. */
  | { readonly kind: 'other-kind'; readonly why: string }
  /** The stat failed for a reason that says nothing about the name. NOT evidence. */
  | { readonly kind: 'indeterminate'; readonly why: string };

/**
 * The errno values that are a STATEMENT ABOUT THE NAME rather than about our
 * ability to ask. Everything else — EACCES, EPERM, EIO, ELOOP, ENAMETOOLONG,
 * EMFILE, a timing-out network mount — is an inability, and is reported as one.
 *
 * ENOTDIR belongs here because it is `a/b` where `a` is a file: the name reaches
 * nothing, said by the ancestor rather than by the leaf.
 */
const ABSENT_ERRNOS = new Set(['ENOENT', 'ENOTDIR']);

/**
 * `dev:ino` for whatever this name reaches, FOLLOWING LINKS.
 *
 * Following is deliberate and is what both callers need: the question is which
 * object the NAME REACHES, and every reader downstream reaches it with
 * `existsSync`/`readFileSync`, both of which follow. A caller that needs to know
 * whether indirection was involved asks a second question (see
 * `namesDirectly` in hook/workspace-members.ts) rather than switching this to
 * `lstat`, because "is this a symlink" and "what is this" are different facts and
 * only one of them is an identity.
 *
 * `mustBeDirectory` exists for the member matcher: a registry entry naming a
 * FILE is not a member, and letting a file's inode into the comparison set would
 * be an authority granted by a typo of a different shape. Retention's own
 * consumer wants no such filter (durable memory is files), so it is a parameter
 * rather than two functions.
 */
export function fsIdentity(target: string, opts: { readonly mustBeDirectory?: boolean } = {}): FsIdentity {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const errno = typeof code === 'string' ? code : 'unknown';
    return ABSENT_ERRNOS.has(errno)
      ? { kind: 'absent' }
      : { kind: 'indeterminate', why: `${target} could not be stat'ed (${errno})` };
  }
  if (opts.mustBeDirectory && !stat.isDirectory()) {
    return { kind: 'other-kind', why: `${target} is not a directory` };
  }
  return { kind: 'identity', id: `${stat.dev}:${stat.ino}` };
}
