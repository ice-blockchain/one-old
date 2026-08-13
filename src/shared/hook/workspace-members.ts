// src/shared/hook/workspace-members.ts
// READS a workspace's MEMBERS REGISTRY out of its `.one.json` and answers ONE
// question: which registered member, if any, encloses this directory?
//
// ── THREE THINGS IN THIS TREE ARE CALLED A WORKSPACE, AND THIS IS THE THIRD ──
// Nothing here concerns either incumbent, and neither incumbent concerns this:
//
//   1. the HOST EDITOR workspace — the opened window's root(s), Cursor's
//      `workspace_roots`, `adapters/workspace-root.ts`, the `workspaceRoot` on
//      the hook input, and the `ceiling` every walk in hook/paths.ts takes from
//      it. That is a BOUNDARY: it says how far resolution may climb.
//   2. the PACKAGE-MANAGER workspace DECLARATION — npm/yarn/bun `workspaces`,
//      `pnpm-workspace.yaml`, read by hook/workspace-declaration.ts and
//      `dirDeclaresWorkspace`. That is a MANIFEST: it says what a repository's
//      build tool CLAIMS, in globs, about directories that may not exist.
//   3. this one, a Traffic One WORKSPACE PROJECT — a directory onboarded as
//      `mode: 'workspace'` whose state carries an explicit list of MEMBER
//      directories, each of which is a project in its own right. That is a
//      REGISTRY: it says which directories this workspace has VALIDATED.
//
// (Two further senses exist and are unrelated to root resolution entirely: the
// pnpm/Turborepo layout the product SCAFFOLDS — `workspaceScaffoldOutputs`,
// `plannedWebWorkspace` — and Xcode's `.xcworkspace` in detection/artifacts.ts.)
//
// A CLAIM AND A REGISTRATION ARE NOT THE SAME QUESTION, which is why this module
// is not a mode of hook/workspace-declaration.ts. `workspaceClaimsDescendant`
// asks what a package manager's globs assert; the answer may be about a path
// nobody has ever looked at, and the reader has to guess at glob semantics it
// deliberately declines to guess at. This module asks what a workspace has
// RECORDED, entry by entry, and a registry entry is therefore never a pattern:
// a `*` in one is a malformed entry, not a wildcard. The two can and do
// disagree — an npm monorepo claims `packages/*` while registering nobody, and
// a polyglot workspace registers a Go module no `workspaces` array could name.
//
// Dependency-free apart from the JSON reader, like its sibling, because the hook
// runtime ships no npm packages and this is reached from the resolution walk.

import * as fs from 'fs';
import * as path from 'path';

import { STATE_FILE } from '../../config/paths';
import { SKIP_DIRS } from '../../config/reporting';
import { fsIdentity, type FsIdentity } from '../fs-identity';
import { readJsonResult } from '../fsjson';
import { VCS_MARKERS } from '../project-membership';
import { isSafeRunId } from '../qa-report/schema';
import { shortHash } from '../text';

/**
 * The `mode` value that makes a directory a Traffic One workspace PROJECT.
 *
 * A fourth value beside `new-project`, `existing-codebase` and
 * `existing-with-supabase`. Two incumbent readers see it without being told,
 * and both land where they should: `inferPhaseFromMode` (state/lifecycle.ts)
 * keys on `startsWith('existing')`, so a workspace is `building` rather than
 * `maintenance`, and `isExistingProjectMode` answers false, so architecture
 * enforcement stays ARMED rather than standing down. Neither is a behaviour
 * change today — no project carries this mode until something writes it.
 */
export const WORKSPACE_PROJECT_MODE = 'workspace';

/** The state key holding the registry. Untrusted: an agent's Write tool reaches it. */
export const WORKSPACE_MEMBERS_KEY = 'workspaceMembers';

/**
 * What a directory's state says about the members it has registered.
 *
 * Four arms rather than three, and the split that earns the fourth is
 * `none` vs `illegible` — the distinction `readJson`'s fallback destroys and
 * that this codebase has answered as a confident negative some twenty times.
 * `none` is a POSITIVE finding (there is no state here, or the state is legible
 * and says this is not a workspace); `illegible` is the absence of a finding.
 * Everything downstream that grants something must treat them differently even
 * though both deny, because only one of them is knowledge.
 */
export type WorkspaceMemberRegistry =
  | { readonly kind: 'none' }
  | { readonly kind: 'illegible'; readonly why: string }
  | { readonly kind: 'opaque'; readonly why: string }
  | {
    readonly kind: 'members';
    /**
     * The paths this workspace MANAGES, unchanged in meaning and in spelling
     * from before member identity existed. An OPTED-OUT entry is absent here
     * (see `optOut` below), which is what makes opting out cost the resolver
     * exactly nothing: `enclosingRegisteredMember` reads this array and only
     * this array, so an opted-out directory is as unregistered as one nobody
     * ever wrote down.
     */
    readonly members: readonly string[];
    /**
     * EVERY entry the registry carries, opted-out ones included, each resolved
     * to a stable id. Separate from `members` on purpose: one answers "what
     * does this workspace manage" (a resolution question) and the other
     * answers "what has this workspace decided about" (a record question), and
     * an opted-out member is a member of the second list only.
     */
    readonly identities: readonly WorkspaceMemberIdentity[];
  };

type Rec = Record<string, unknown>;

// ── MEMBER IDENTITY ──────────────────────────────────────────────────────────
//
// WHY AN IDENTITY AT ALL, when the registry is already keyed by path: a run
// record has to name the member it belongs to, a linked run has to join on it,
// and the write fence has to attribute a foreign write to it. A path cannot do
// any of the three. It changes when a directory is renamed, it is not safe as a
// filename component (`apps/web` is two path segments), and it is not stable
// enough to be a join key in a file that outlives the directory layout.
//
// WHAT AN ID DERIVES FROM, and why that answer is "as little as possible":
// `projectRootHash` (state/local-prefs/prefs-store.ts) is this repo's closest
// precedent and it is documented as a hazard rather than a model. It derives a
// durable bucket name from the project's realpath, and the recorded decision is
// NOT to change its spelling, because doing so relocates every bucket on every
// machine — consent reverts to unanswered, wizard answers vanish, and every
// issued override token stops matching. The lesson generalises exactly one
// notch: A DERIVED IDENTITY IS ONLY AS STABLE AS ITS INPUT, and it silently
// relocates everything named by it when that input moves.
//
// For a member the input would be its path inside the container, and a
// directory rename inside a monorepo is ORDINARY MAINTENANCE — far more
// frequent than moving a whole project checkout, which is the rarer event
// projectRootHash already cannot survive. So a purely derived member id would
// reproduce projectRootHash's known failure at a much higher rate.
//
// The answer is therefore that the id is RECORDED, not derived: the writer
// mints an id once, stores it in the entry, and a later rename edits `path`
// while `id` stays put, so every run record that named the member still joins.
// Derivation exists only as the BOOTSTRAP for an entry that carries no id —
// which the registry must tolerate, because `.one.json` is a file a user (or an
// agent's Write tool) hand-edits, and a hand-written entry is `{ path: 'x' }`.
//
// Derivation is consequently NOT stable across registry edits, and saying so is
// the point rather than a caveat: adding a second `web` member changes the
// first one's derived id (see the collision rule below). That instability is
// exactly the argument for recording, and it is why the writer always records.

/** A registry entry with its identity settled. */
export interface WorkspaceMemberIdentity {
  /** The member's path relative to the workspace root, as validated. */
  readonly path: string;
  /** Stable, filename-safe, unique within this workspace. */
  readonly id: string;
  /** True when the workspace has decided NOT to manage this member — see `optOut`. */
  readonly optOut: boolean;
  /**
   * Where the id came from. `declared` is the durable case (the entry recorded
   * it); the other two are bootstraps for an entry that did not, and a caller
   * that persists anything keyed by a non-`declared` id is keying off a value
   * the next registry edit may change.
   */
  readonly origin: 'declared' | 'derived' | 'disambiguated';
}

export type MemberIdentityResolution =
  | { readonly kind: 'resolved'; readonly identities: readonly WorkspaceMemberIdentity[] }
  | { readonly kind: 'collision'; readonly why: string };

/**
 * The readable half of a derived id: the member's LAST path segment, reduced to
 * the character class every consumer of an id can carry.
 *
 * The last segment rather than the whole path because that is the name a human
 * uses for the member (`apps/web` is "web"), and a readable id is the entire
 * reason a derivation exists instead of a bare hash. It collides — `apps/web`
 * and `services/web` both reduce to `web` — and the collision rule below is
 * what answers for that, deliberately, instead of being avoided by flattening
 * the path: `apps/web` flattened to `apps-web` collides just as hard with a
 * directory genuinely named `apps-web`, so flattening buys a rarer collision at
 * the price of pretending there is none.
 */
export function deriveMemberIdBase(memberPath: string): string {
  const last = memberPath.split('/').filter(Boolean).pop() || '';
  // `_` as the replacement, matching the four `safeRunId` copies in this tree
  // (run-settlement/types.ts, host/capability-schema.ts, maintenance/fallback.ts,
  // strict-verification-evidence.ts) so a member id and a run id read alike.
  return fitMemberId(last.replace(/[^A-Za-z0-9._-]/g, '_'), '');
}

/**
 * The id a member gets when its readable base is taken by another member.
 *
 * A hash OF THE PATH, so the disambiguated form is a pure function of the
 * member itself: two workspaces that register the same colliding pair produce
 * the same two ids, and REORDERING the registry array cannot change which
 * member got which id. An order-sensitive rule (first-one-keeps-the-base) would
 * make identity depend on how the array happened to be serialised.
 *
 * `shortHash`'s own default length is used rather than a length chosen here —
 * shared/text.ts owns that number.
 */
export function deriveMemberIdDisambiguated(memberPath: string): string {
  return fitMemberId(deriveMemberIdBase(memberPath), `-${shortHash(memberPath)}`);
}

/**
 * Shrink the readable head until head+tail is a safe path segment.
 *
 * The BOUND IS NEVER RESTATED HERE. The loop asks `isSafeRunId`
 * (shared/qa-report/schema.ts) — the tree's declared "is this a safe path
 * segment" predicate, and the right authority because a member id lands in the
 * same two places a run id does, a directory name under `.traffic-one/` and a
 * key inside a run record. A future tightening of that predicate tightens this
 * derivation automatically instead of drifting away from it, which a copied
 * `.slice(0, 128)` could not do.
 *
 * No last-resort arm: a head that shrinks to one character can still be
 * unsafe in principle, and the final `isSafeRunId` check in
 * `resolveMemberIdentities` is where that is caught — one reachable guard
 * (an author can DECLARE `../evil`) rather than a second unreachable one here.
 */
function fitMemberId(head: string, tail: string): string {
  let kept = head;
  while (kept.length > 1 && !isSafeRunId(`${kept}${tail}`)) kept = kept.slice(0, -1);
  return `${kept}${tail}`;
}

/**
 * Settle every entry's id, or name the collision that stops us.
 *
 * THREE RULES, in this order:
 *
 *   1. Disambiguation is decided from the set of member PATHS ALONE — not from
 *      declared ids, and NOT from `optOut`. Ignoring `optOut` is what keeps an
 *      id stable when a member is opted out and back in again: if opted-out
 *      entries were excluded from the collision count, flipping one flag would
 *      silently re-id a DIFFERENT member, which is the same relocation hazard
 *      projectRootHash records, arriving through a flag instead of a rename.
 *   2. A DECLARED id overrides the derived one. The author's recorded choice is
 *      the durable identity; derivation is only the bootstrap for its absence.
 *   3. The final set must be duplicate-free. A duplicate is REPORTED, never
 *      resolved by last-write-wins: two members sharing an id means two members
 *      sharing a run directory and a join key, and silently picking one is how
 *      one member's evidence gets attributed to another.
 *
 * Rule 3 is reachable in three distinct ways, all of them from untrusted bytes:
 * two entries declaring the same id, an entry declaring an id that a different
 * member's derivation already produced, and an entry declaring an id that is
 * not a safe path segment at all.
 */
export function resolveMemberIdentities(
  entries: readonly { readonly path: string; readonly declaredId: string | null; readonly optOut: boolean }[],
): MemberIdentityResolution {
  const baseCount = new Map<string, number>();
  for (const entry of entries) {
    const base = deriveMemberIdBase(entry.path);
    baseCount.set(base, (baseCount.get(base) || 0) + 1);
  }

  const identities: WorkspaceMemberIdentity[] = [];
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const base = deriveMemberIdBase(entry.path);
    const collides = (baseCount.get(base) || 0) > 1;
    const id = entry.declaredId ?? (collides ? deriveMemberIdDisambiguated(entry.path) : base);
    const origin: WorkspaceMemberIdentity['origin'] = entry.declaredId !== null
      ? 'declared'
      : (collides ? 'disambiguated' : 'derived');
    if (!isSafeRunId(id)) {
      return { kind: 'collision', why: `member ${entry.path} carries the id ${JSON.stringify(id)}, which is not a safe path segment` };
    }
    const owner = seen.get(id);
    if (owner !== undefined) {
      return { kind: 'collision', why: `members ${owner} and ${entry.path} both resolve to the id ${JSON.stringify(id)}` };
    }
    seen.set(id, entry.path);
    identities.push({ path: entry.path, id, optOut: entry.optOut, origin });
  }
  return { kind: 'resolved', identities };
}

// ── GIT OWNERSHIP ────────────────────────────────────────────────────────────

/**
 * Whether a member is its own repository, or a directory inside somebody's.
 *
 * The two are different animals and the difference is not cosmetic:
 *
 *   - OWN REPOSITORY. `projectMembershipRoot` stops climbing at it, so the
 *     container can never absorb it; its history is separate; and — the fact
 *     that actually decides something this wave — a `.gitignore` at the
 *     container has NO effect on its files, because ignore rules do not cross a
 *     repository boundary. Anything Traffic One writes inside it must be
 *     ignored from inside it.
 *   - CONTAINER REPOSITORY. Its files are the container repository's files, so
 *     one ignore region at the container can cover it — but only if that region
 *     is written recursively, which the container's current region is not (see
 *     shared/state/workspace-members.ts, where that was measured against git).
 *
 * NOT FOLDED INTO THE REGISTRY READER, on purpose. `readWorkspaceMemberRegistry`
 * costs one state-file read and `workspaceMemberRegistryOf` costs no syscall at
 * all, and both sit on the resolution walk; git ownership is a directory probe
 * per member, so it stays a function a caller asks for when it needs the answer.
 *
 * `existsSync`, never `isDirectory`, for the marker itself: `.git` is a FILE in
 * a worktree and in a submodule (the reasoning `dirHasVcs` in
 * shared/project-membership.ts records). The marker NAMES come from
 * `VCS_MARKERS` there rather than being listed again here.
 */
export type MemberGitOwnership =
  | { readonly kind: 'own-repository'; readonly marker: string }
  | { readonly kind: 'container-repository'; readonly repositoryRoot: string }
  | { readonly kind: 'no-repository-within-workspace' }
  | { readonly kind: 'unobservable'; readonly why: string };

function vcsMarkerIn(dir: string): string | null {
  for (const marker of VCS_MARKERS) {
    if (fs.existsSync(path.join(dir, marker))) return marker;
  }
  return null;
}

export function memberGitOwnership(workspaceRoot: string, member: string): MemberGitOwnership {
  const root = path.resolve(workspaceRoot);
  const dir = path.isAbsolute(member) ? path.resolve(member) : path.resolve(root, member);
  try {
    if (!fs.statSync(dir).isDirectory()) return { kind: 'unobservable', why: `${dir} is not a directory` };
  } catch {
    return { kind: 'unobservable', why: `${dir} could not be read` };
  }
  // Containment is checked up front and NAMED, rather than left to the walk to
  // fall out of. "Which repository owns this member" is not a question about a
  // directory that is not in the workspace, and answering it from a walk that
  // simply never started would report a measurement nobody took.
  if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) {
    return { kind: 'unobservable', why: `${dir} is not inside ${root}` };
  }
  const own = vcsMarkerIn(dir);
  if (own) return { kind: 'own-repository', marker: own };

  // Upward to the workspace root INCLUSIVE, and no further. The third arm is
  // named for that bound rather than for "no version control" because a
  // repository ABOVE the container would still own these files, and this walk
  // never looked there — a claim is only true of the input it was measured on.
  //
  // The bound is stated ONCE, as the member's own depth below the root — which
  // is exactly the number of directories between it and the root, inclusive,
  // so the walk ends ON the root and never above it. Saying it a second time as
  // an enclosing containment condition would decide nothing (the check above
  // already guarantees it) and leave a guard no test could hold to account; a
  // MAX_WALK constant would be a number invented where the input supplies one.
  const segments = path.relative(root, dir).split(path.sep).filter(Boolean);
  let current = path.dirname(dir);
  for (let i = 0; i < segments.length; i += 1) {
    if (vcsMarkerIn(current)) return { kind: 'container-repository', repositoryRoot: current };
    current = path.dirname(current);
  }
  return { kind: 'no-repository-within-workspace' };
}

/**
 * Read `<dir>/.traffic-one/.one.json` and classify what it says about members.
 *
 * The four `readJsonResult` arms, and why each folds where it does — all four
 * DENY, so the question is only which of them is a fact a caller may act on:
 *
 *   absent      → `none`.       Nothing is there. A directory with no state is
 *                               not a workspace, and that is knowledge, not a
 *                               guess: it is the same read `isOnboardedProjectRoot`
 *                               already performs and already trusts.
 *   corrupt     → `illegible`.  There ARE bytes and they do not parse. We cannot
 *                               say this is not a workspace; we can only say we
 *                               could not tell. Answering `none` here is exactly
 *                               the defect the four-armed reader exists for.
 *   unreadable  → `illegible`.  Same verdict as `corrupt`, and DELIBERATELY the
 *                               same rather than a fifth arm. The two part
 *                               company only for a writer deciding whether it
 *                               can preserve the old bytes before replacing them
 *                               (state/normalize.ts statePreservedBeforeReplace).
 *                               Nothing here ever writes, so the only fact left
 *                               is "the registry could not be established", and
 *                               both say it. `why` names which one it was.
 *   ok, other   → `none`.       A legible state whose `mode` is not `workspace`.
 *   ok, mode    → `members` when every entry validates, `opaque` when any does
 *                 not. An ABSENT registry key on a legible workspace state is
 *                 `members: []`: the file is readable and it registers nobody,
 *                 which is a fact, not an inability — the same reasoning that
 *                 makes a pnpm file with no `packages:` key an empty list rather
 *                 than opaque (hook/workspace-declaration.ts parsePnpmPackages).
 */
export function readWorkspaceMemberRegistry(dir: string): WorkspaceMemberRegistry {
  const read = readJsonResult<Rec>(path.join(path.resolve(dir), STATE_FILE));
  if (read.kind === 'absent') return { kind: 'none' };
  if (read.kind === 'corrupt') return { kind: 'illegible', why: `${STATE_FILE} holds bytes that are not JSON` };
  if (read.kind === 'unreadable') return { kind: 'illegible', why: `${STATE_FILE} could not be read (${read.errno})` };
  return workspaceMemberRegistryOf(read.value);
}

/**
 * The same classification over a state record a caller ALREADY holds.
 *
 * This overload is what keeps the resolution hot path free: `nearestOnboardedRoot`
 * reads each level's `.one.json` exactly once — as it always has — and hands the
 * value here, so the workspace question costs one string comparison and no
 * syscall. There is no arm for an illegible read because a caller holding a
 * value has, by construction, already had a legible one.
 */
export function workspaceMemberRegistryOf(state: unknown): WorkspaceMemberRegistry {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { kind: 'none' };
  const record = state as Rec;
  if (record.mode !== WORKSPACE_PROJECT_MODE) return { kind: 'none' };
  const raw = record[WORKSPACE_MEMBERS_KEY];
  if (raw === undefined || raw === null) return { kind: 'members', members: [], identities: [] };
  if (!Array.isArray(raw)) return { kind: 'opaque', why: `${WORKSPACE_MEMBERS_KEY} is not an array` };
  const parsed: { path: string; declaredId: string | null; optOut: boolean }[] = [];
  for (const entry of raw) {
    const member = validateMemberEntry(entry);
    if (typeof member === 'string') {
      return { kind: 'opaque', why: `${WORKSPACE_MEMBERS_KEY} holds the entry ${JSON.stringify(entry)}, which ${member}` };
    }
    // The same directory listed twice, resolved the SAME way the writer
    // resolves the same input: an identical repeat is a duplicate and is
    // dropped, while a repeat that disagrees about the id or the opt-out is a
    // CONTRADICTION and poisons the list. Reading these two apart matters
    // because only one of them leaves the registry meaning one thing — and a
    // reader that folded them together would answer a question the file asks
    // twice and answers differently each time.
    const existing = parsed.find((candidate) => candidate.path === member.path);
    if (existing) {
      if (existing.declaredId !== member.declaredId || existing.optOut !== member.optOut) {
        return { kind: 'opaque', why: `${WORKSPACE_MEMBERS_KEY} lists ${member.path} twice with different terms` };
      }
      continue;
    }
    parsed.push(member);
  }
  const resolved = resolveMemberIdentities(parsed);
  // A duplicate id poisons the list for the same reason a malformed path does,
  // and the reasoning is the mirror of the one recorded above
  // `validateMemberEntry`: half an authorization list answers "no" to a question
  // it never read, and a registry whose ids are not unique cannot answer the
  // identity question for ANY of its members without possibly answering it for
  // the wrong one.
  if (resolved.kind === 'collision') {
    return { kind: 'opaque', why: `${WORKSPACE_MEMBERS_KEY} carries an unusable identity: ${resolved.why}` };
  }
  return {
    kind: 'members',
    members: resolved.identities.filter((identity) => !identity.optOut).map((identity) => identity.path),
    identities: resolved.identities,
  };
}

/**
 * ONE BAD ENTRY POISONS THE WHOLE LIST, following the convention
 * hook/workspace-declaration.ts set — and the argument that carries it there
 * carries here too, though the direction is the mirror image and worth saying
 * out loud rather than inheriting.
 *
 * There the list is authority to DELETE, so dropping an unreadable NEGATIVE
 * would delete a directory the author excluded. Here the list is authority to
 * treat a directory as its own project, so dropping an entry costs a member its
 * standing — and the reader cannot tell whether the entry it dropped was the one
 * the caller is asking about. A half-read authorization list answers "no" to a
 * question it never actually read, which is the confident-negative defect again,
 * one layer up.
 *
 * WHAT THE POISON COSTS, corrected — the earlier wording ("`opaque` denies
 * everything, denying everything is today's behaviour, so a malformed registry
 * cannot do worse than not existing") is false, and comfortably so. The two are
 * not the same answer at all. MEASURED on one container and one member:
 *
 *   no registry at all      the member resolves to itself and every gate operates
 *   a malformed registry    `resolveToolScope` reports `unresolved` and EVERY
 *                           gated call under the container is refused
 *
 * A malformed registry therefore FREEZES members that would otherwise work,
 * which is strictly worse than not existing. It is still the right direction —
 * a half-read authorization list answering "no" to a question it never read is
 * the alternative, and that one loses a member's state rather than a session's
 * writes — but it is a cost to be paid deliberately, not a free poison. The
 * refusal names the container and the `why`, so the freeze is legible to
 * whoever has to repair the file, and it clears on the first parse.
 *
 * (This predates member identity and is not a regression; it is recorded here
 * because the sentence it replaces is the reassurance that would stop the next
 * reader from measuring.)
 */
// Returns the parsed entry, or a STRING saying what is wrong with it — which
// the caller splices into its `why` so a malformed registry names the field
// that made it malformed rather than only the entry that carried it.
function validateMemberEntry(
  entry: unknown,
): { path: string; declaredId: string | null; optOut: boolean } | string {
  // Objects only. A bare string entry is rejected on purpose: the registry is
  // the extension point for per-member facts a later item needs to attach, and
  // accepting two shapes now means validating two shapes forever. (`id` and
  // `optOut` below are that extension point being used for the first time,
  // which is the reason the shape was fixed here rather than widened later.)
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'is not a member entry object';
  const record = entry as Rec;
  const verdict = memberPathVerdict(record.path);
  if (!verdict.ok) return verdict.why;

  // `id`, when present, is the DURABLE identity — the whole reason a rename
  // does not orphan a member's run records. Absent is legal and common: a
  // hand-written `{ path: 'x' }` is exactly what a user types, and it is
  // bootstrapped by derivation. Present-but-wrong is not legal, because an id
  // this reader waved through would become a directory name.
  let declaredId: string | null = null;
  if (record.id !== undefined && record.id !== null) {
    if (typeof record.id !== 'string' || !isSafeRunId(record.id)) {
      return `carries an id that is not a safe path segment: ${JSON.stringify(record.id)}`;
    }
    declaredId = record.id;
  }

  // OPT-OUT. Absent means managed, so the default is the reading a registry
  // written before this field existed already had.
  if (record[MEMBER_OPT_OUT_KEY] !== undefined && typeof record[MEMBER_OPT_OUT_KEY] !== 'boolean') {
    return `carries a non-boolean ${MEMBER_OPT_OUT_KEY}: ${JSON.stringify(record[MEMBER_OPT_OUT_KEY])}`;
  }
  return { path: verdict.path, declaredId, optOut: record[MEMBER_OPT_OUT_KEY] === true };
}

/**
 * The entry field that says "this workspace has CONSIDERED this directory and
 * decided not to manage it".
 *
 * WHAT OPTING OUT MEANS, and it is worth being exact because two plausible
 * readings differ sharply:
 *
 *   NOT "invisible". Making a member invisible would route its files to the
 *   CONTAINER — `enclosingRegisteredMember` would decline it, the walk would
 *   keep climbing, and the container would adopt them. Traffic One would then
 *   manage the very directory the user asked it to leave alone, only worse,
 *   because it would manage it as part of something else. Opting a member out
 *   must never make its files the container's problem.
 *
 *   IT MEANS "not a member of this workspace" — which is precisely what an
 *   ABSENT entry already means to every resolver. So opt-out adds NO new
 *   authority and NO new resolver behaviour: the entry is simply excluded from
 *   `members`, and everything downstream answers as it would for a directory
 *   nobody registered. If the directory is a project in its own right it is
 *   judged on its own terms, exactly as it would be if this workspace did not
 *   exist.
 *
 *   ON ONE AXIS THE EQUIVALENCE DOES NOT HOLD, and stating it without the
 *   exception understated the consequence for a member that already holds
 *   state. A member owning no project marker, onboarded and then flipped to
 *   opted-out, stopped resolving to itself, became a leaked nested root and had
 *   its `.traffic-one` removed by the next SessionStart sweep — the flag that
 *   promises Traffic One will leave a directory alone deleting that directory's
 *   record of ever having been managed. `registryEnclosureOf` therefore answers
 *   `vouched` for an opted-out entry: no member's authority (the paragraph
 *   above is unchanged), and never a deletion candidate.
 *
 * WHY RECORD IT AT ALL, then, if absence produces the same behaviour: because
 * absence and refusal are different FACTS, and this module already draws that
 * line four times (`none` vs `illegible`, `not-member` vs `indeterminate`). An
 * absent entry is "nobody has considered this directory"; an opted-out entry is
 * "this was considered and the answer was no". Workspace onboarding — the item
 * that will rescan a container and offer what it finds — is the consumer that
 * cannot function without the difference, because without it every rescan
 * re-offers the same directory forever.
 *
 * WHY NOT REUSE `pluginUseDeclined`, which answers the analogous question for a
 * whole project: it answers a DIFFERENT axis and the two compose rather than
 * compete. A plugin-use decline is per-user and per-machine, stored in
 * `~/.traffic-one/projects/<hash>/preferences.json` and deliberately never in
 * the repository (state/plugin-use.ts's opening note), so it cannot express "in
 * THIS repository, that directory is not one of ours" to anybody else who
 * clones it. This flag is committed by construction, because `.one.json` is.
 * Spelling this one `declined` would have made one word mean both, which is the
 * confusion, not the economy. A declined member is also still declined: nothing
 * here weakens that fence, and a member can be both.
 */
export const MEMBER_OPT_OUT_KEY = 'optOut';

// A registry lists DIRECTORIES, never patterns — the whole difference from the
// declaration reader next door. Glob metacharacters are therefore rejected
// rather than interpreted: a `*` in a registry entry is a malformed entry, and
// reading it as a wildcard would silently widen an authorization the author
// wrote as a literal.
const GLOB_SYNTAX = /[*?[\]{}()!]/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;

/**
 * A directory name that is somebody's dependencies, build output or cache, and
 * therefore can never be a member.
 *
 * DERIVED BY EXPRESSION from `SKIP_DIRS` (config/reporting.ts), which describes
 * itself as THE single skip authority and is already read by the code graph,
 * the immutable baseline capture and every baseline-derived diff. A third
 * hand-written copy of `vendor`/`node_modules`/`Pods`/`.venv` would be a drift
 * pair the day it was typed.
 *
 * The inherited curation matters as much as the inherited list: `SKIP_DIRS`
 * deliberately omits `bin` and bare `lib` because they are ordinary source
 * directories in enough ecosystems to make skipping them a net loss — which is
 * the same trade this predicate faces, in the same direction (a member wrongly
 * rejected is worse than a vendor dir wrongly considered, since the second is
 * caught by the manifest check onboarding will do anyway).
 *
 * SEGMENT EQUALITY, never substring: `services/target-api` is not `target`.
 */
export function isVendorDirName(name: string): boolean {
  return SKIP_DIRS.has(name);
}

export type MemberPathVerdict =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly why: string };

/**
 * The one place a member path is judged, for both the reader and the writer.
 *
 * Returns the REASON as well as the verdict because the writer reports it to a
 * caller, and "this is not inside the workspace" versus "this is a vendor
 * directory" versus "this is a glob" send whoever reads them looking in three
 * different places. `validateMemberPath` below is the boolean-shaped projection
 * of this, kept because it is an exported signature other code already calls.
 */
export function memberPathVerdict(raw: unknown): MemberPathVerdict {
  if (typeof raw !== 'string') return { ok: false, why: `is not a member path: ${JSON.stringify(raw)}` };
  const normalized = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized) return { ok: false, why: 'is an empty member path' };
  // Relative to the workspace root, always. An absolute entry would let a
  // hand-edited `.one.json` nominate any directory on the machine as "a member
  // of this workspace", which is authority the file has no business carrying.
  if (normalized.startsWith('/') || WINDOWS_DRIVE.test(normalized)) {
    return { ok: false, why: `is an absolute path, which a member entry may never be: ${normalized}` };
  }
  if (GLOB_SYNTAX.test(normalized)) return { ok: false, why: `is a pattern, not a directory: ${normalized}` };
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return { ok: false, why: `is not a normalized relative directory: ${normalized}` };
  }
  const vendor = segments.find((segment) => isVendorDirName(segment));
  if (vendor !== undefined) {
    return { ok: false, why: `lies under the dependency/build directory ${JSON.stringify(vendor)}: ${normalized}` };
  }
  return { ok: true, path: normalized };
}

/** A member path this reader is willing to vouch for, normalized, or null. */
export function validateMemberPath(raw: unknown): string | null {
  const verdict = memberPathVerdict(raw);
  return verdict.ok ? verdict.path : null;
}

/**
 * `dev:ino` for a DIRECTORY, with "not there" kept apart from "could not tell".
 *
 * The primitive is shared/fs-identity.ts, which retention.ts's `fileIdentity`
 * is the other copy of; see that file's header for why the six lines are shared
 * and the POLICIES above them deliberately are not.
 */
function directoryIdentity(dir: string): FsIdentity {
  return fsIdentity(dir, { mustBeDirectory: true });
}

/**
 * Does this entry NAME the directory it reaches, or merely POINT AT it?
 *
 * THE ONE QUESTION THAT SPLITS MAJOR 3'S ASYMMETRY, so it is worth being exact
 * about what it separates. Both of these reach one directory and are therefore
 * one `dev:ino`:
 *
 *   - `Api` where the directory is `api`. A TYPO in a committed file, on a
 *     volume that folds case. The entry names that directory; the author wrote
 *     down the directory they meant and the platform agrees. Identity here is
 *     what stops the member's own state from being swept as a leaked nested
 *     root, which is the deletion this whole matcher exists to avert.
 *   - `x` where `x` is a SYMLINK to `secret`, and the registry never names
 *     `secret` anywhere. The entry does not name that directory, it points at
 *     it — so treating it as a member LAUNDERS membership onto a directory the
 *     author never authorized, and needs no privilege at all when `x` is a ghost
 *     entry nobody has to overwrite.
 *
 * `realpathSync`, NOT `lstat`, and not `realpathSync.native`. `lstat` sees only
 * a symlink at the LAST component and would miss `link/api`. `native` CANONICALIZES
 * CASE on APFS (measured: `.../Api` → `.../api`), which would fold the typo into
 * the symlink's answer and lose the very distinction this draws. Plain
 * `realpathSync` resolves every symlink and preserves the caller's spelling
 * (measured on this volume: `Api` → `Api`, `x` → `secret`), which is exactly the
 * discriminator — and it is asked ONLY after an identity match, so the common
 * path never pays for it.
 *
 * A FAILURE ANSWERS false, and that is safe in both directions rather than by
 * luck: false denies member standing (fail closed for an authorization question)
 * and the caller's remaining arm is `vouched`, which keeps the directory's state
 * (fail closed for the deletion question). The identity stat has already
 * succeeded by the time we are here, so this is exotic either way.
 *
 * ── WHAT THIS DOES NOT SAY, because the obvious wording is false ─────────────
 *
 * NOT "a name the workspace committed is standing whatever sits at that name".
 * A registered leaf that IS a link does keep member standing, but not because
 * this function grants it: the exact-spelling pass answers first and never asks
 * the question. This is consulted EXCLUSIVELY when the query spelling differs
 * from the entry's — so the same directory and the same link, queried through
 * an entry differing in nothing but CASE, come back `vouched` instead of
 * `member` on a folding volume, while every row of the spelling table on
 * `enclosingRegisteredMember` says a case difference there is the same name. An
 * ancestor symlink does the same to the case-typo forgiveness one segment up.
 *
 * The claim that survives is narrower, and it is the one the callers rely on:
 * THE EXACT SPELLING AN ENTRY CARRIES is standing whatever sits at that name;
 * every other spelling is judged here. Both flips above land on `vouched`, so
 * they cost AUTHORITY and never data — which is why this is a bound worth
 * stating rather than a hole worth plugging, and why widening the question to
 * the ENTRY's own realpath would be a deliberate change on the authority axis
 * rather than a repair of this one.
 */
function namesDirectly(rootReal: string, rootAbs: string, segments: readonly string[]): boolean {
  try {
    return fs.realpathSync(path.join(rootAbs, ...segments)) === path.join(rootReal, ...segments);
  } catch {
    return false;
  }
}

function realpathOrSelf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/** Registry entries grouped by how many segments they carry — no syscall. */
function entriesByDepth(members: readonly string[]): Map<number, readonly string[][]> {
  const byDepth = new Map<number, string[][]>();
  for (const member of members) {
    const segments = member.split('/');
    const bucket = byDepth.get(segments.length);
    if (bucket) bucket.push(segments);
    else byDepth.set(segments.length, [segments]);
  }
  return byDepth;
}

/**
 * What a registry says about ONE directory, on the two axes that need opposite
 * safe directions.
 *
 * `member` is full standing: the fence attributes work to it, a plan and run
 * state and role claims live in it, and `resolveProjectRoot` answers with it.
 * `vouched` is standing on the DELETION axis only — some entry reaches this
 * exact directory, but not by naming it (see `namesDirectly`), or we could not
 * settle the question at all. A vouched directory's state must never be swept as
 * a leaked nested root, and it must never be granted a member's authority.
 *
 * `indeterminate` is separate from `none` for the reason this module draws that
 * line five times over: `none` is the positive finding that no entry reaches
 * this directory, and `indeterminate` is the absence of a finding. They are
 * folded together by exactly one consumer and only in one direction.
 */
export type RegistryEnclosure =
  | { readonly kind: 'member'; readonly member: string }
  | { readonly kind: 'vouched'; readonly why: string }
  | { readonly kind: 'indeterminate'; readonly why: string }
  | { readonly kind: 'none' };

/**
 * Is THIS EXACT DIRECTORY one the registry reaches — and if so, does it reach it
 * by naming it?
 *
 * The exact question, asked once per directory that holds committed state, which
 * is what makes it affordable to be thorough here: it scans every entry at every
 * depth, so a bind mount or a symlink that reaches this directory from a
 * different depth is still SEEN (as `vouched`), and a member state file is
 * therefore never swept just because the entry that reaches it is spelled at
 * another depth. `enclosingRegisteredMember` below is the hot ancestor-or-self
 * walk and deliberately does less.
 *
 * ORDER IS THE POLICY: spelling, then same-depth direct identity, then anything
 * else that reaches here, then our own inability. The first two grant authority;
 * the last two only withhold a deletion.
 */
export function registryEnclosureOf(
  root: string,
  registry: WorkspaceMemberRegistry,
  dir: string,
): RegistryEnclosure {
  if (registry.kind !== 'members') return { kind: 'none' };
  const rootAbs = path.resolve(root);
  const rel = path.relative(rootAbs, path.resolve(dir)).replace(/\\/g, '/');
  if (!rel || rel === '.' || rel.startsWith('../')) return { kind: 'none' };
  const parts = rel.split('/');
  const spelled = parts.join('/');
  // The exact spelling first, and it stats NOTHING — which is what keeps a ghost
  // entry (one naming a directory that does not exist) behaving exactly as it
  // always has.
  if (registry.members.includes(spelled)) return { kind: 'member', member: path.join(root, ...parts) };

  // AN OPTED-OUT ENTRY IS READ HERE, AND ONLY HERE — the one place the
  // record list beats the resolution list. `members` excludes it, so every
  // resolver answers for it exactly as it does for a directory nobody wrote
  // down, which is what the note on `MEMBER_OPT_OUT_KEY` promises and what
  // keeps opting out free. That promise is about AUTHORITY, and on the
  // DELETION axis the same equivalence is a data loss: an onboarded member
  // owning no project marker, flipped to opted-out, stopped resolving to
  // itself, `isLeakedNestedRoot` reported its live `.traffic-one` and the
  // SessionStart sweep removed it — so the flag whose whole documented
  // contract is "Traffic One leaves this directory alone" deleted the
  // directory's memory of ever having been managed. `vouched` is the arm that
  // separates the two: no member's authority, and never a sweep candidate.
  //
  // It is also the more honest reading of the flag. An absent entry is "nobody
  // has considered this directory"; an opted-out entry is "this was considered
  // and the answer was no" — a DECISION ABOUT THIS DIRECTORY, which is exactly
  // what `none` (no entry reaches here) denies having.
  if (registry.identities.some((identity) => identity.optOut && identity.path === spelled)) {
    return {
      kind: 'vouched',
      why: `the entry ${JSON.stringify(spelled)} is opted out — a decision this workspace recorded about this directory, not an absence of one`,
    };
  }
  if (registry.members.length === 0) return { kind: 'none' };

  const candidateDir = path.join(rootAbs, ...parts);
  const candidate = directoryIdentity(candidateDir);
  if (candidate.kind === 'indeterminate') return { kind: 'indeterminate', why: candidate.why };
  // A directory that is not there, or is not a directory, is not reached by any
  // entry — a finding, not an inability, so no entry needs to be stat'ed for it.
  //
  // EXCEPT WHEN THE FINDING CONTRADICTS THE CALLER. ENOENT and ENOTDIR are
  // evidence about a NAME, and that is sound for an entry — a registry entry
  // reaching nothing is a real fact about the entry. Here the name is the
  // directory whose fate is being decided, and the caller that matters is a
  // deletion sweep standing in it because it found committed state there. A
  // name that reaches nothing while its `.one.json` is still readable is not a
  // directory that stopped existing; it is a rename in flight — a `git
  // checkout` swapping the tree under a session sweep is the reachable window —
  // and answering `none` there hands the container the member's state file for
  // an instant that the sweep is entirely capable of acting inside. One
  // `existsSync`, on an arm that is already exotic, and only when the stat
  // itself came back absent: a directory that genuinely does not exist has no
  // state file, so "a legible registry that does not list you" stays the
  // positive negative it has always been.
  if (candidate.kind === 'absent' && fs.existsSync(path.join(candidateDir, STATE_FILE))) {
    return { kind: 'indeterminate', why: `${candidateDir} reached nothing while still holding ${STATE_FILE}` };
  }
  if (candidate.kind !== 'identity') return { kind: 'none' };

  const rootReal = realpathOrSelf(rootAbs);
  let vouched = '';
  let indeterminate = '';
  for (const member of registry.members) {
    const segments = member.split('/');
    const entry = directoryIdentity(path.join(rootAbs, ...segments));
    if (entry.kind === 'indeterminate') {
      if (!indeterminate) indeterminate = entry.why;
      continue;
    }
    if (entry.kind !== 'identity' || entry.id !== candidate.id) continue;
    if (segments.length === parts.length && namesDirectly(rootReal, rootAbs, segments)) {
      return { kind: 'member', member: path.join(root, ...parts) };
    }
    if (!vouched) {
      vouched = `the entry ${JSON.stringify(member)} reaches ${rel} without naming it`;
    }
  }
  if (vouched) return { kind: 'vouched', why: vouched };
  if (indeterminate) return { kind: 'indeterminate', why: indeterminate };
  return { kind: 'none' };
}

/**
 * The registered member that is `descendant` itself, or encloses it — or null.
 *
 * ANCESTOR-OR-SELF, matching `workspaceClaimsDescendant`'s own ancestor arm and
 * for the same reason: a source file at `<member>/internal/ledger/ledger.go`
 * belongs to `<member>`, and a workspace that registered `<member>` said so
 * about everything under it. The DEEPEST match wins, so a workspace that
 * registers both `apps` and `apps/web` resolves a file in `apps/web` to
 * `apps/web`.
 *
 * ── MATCHED BY FILESYSTEM IDENTITY, WITH THE SPELLING AS A SHORTCUT ──────────
 *
 * An entry differing from its directory only in CASE is an ordinary typo in a
 * committed file, and on a case-folding volume (APFS, NTFS) it names THE SAME
 * DIRECTORY. Under a string comparison it matched nothing, so the member was
 * not recognised, so `resolveProjectRoot` climbed past it to the container,
 * so `isLeakedNestedRoot` reported the member's own live `.traffic-one` as a
 * leaked nested root and the SessionStart sweep REMOVED it. MEASURED on two of
 * three sub-shapes of a `Api`/`api` container (the member owning no project
 * marker, and the container additionally declaring package-manager
 * workspaces): the member's state was planned for deletion.
 *
 * THE FIX IS NOT A FOLDING TABLE, and refusing one is the whole point —
 * shared/retention.ts reached the same conclusion over seventeen adversarial
 * spellings when it had to decide which `readdir` entries durable memory
 * reaches, and the reasoning transfers exactly. A fold this code writes down is
 * only as good as the set of rules it happens to know: case, Unicode
 * normalization, trailing dots and spaces, and whatever a locale or a volume
 * flag does that nobody here has tested. Asking the FILESYSTEM which directory
 * an entry resolves to needs to be right about none of them.
 *
 * It is also the answer that stays correct on a case-SENSITIVE volume, which a
 * fold would get wrong. There `<ws>/Api` and `<ws>/api` are two directories, the
 * registry names one of them, and state in the other genuinely IS an
 * unregistered nested root — the packages/ui leak this sweep exists to heal.
 * Identity says "different directory" there and "same directory" on APFS, from
 * one rule, because the rule is the platform's own.
 *
 * ── TWO PASSES, AND WHAT THE SECOND ONE IS ALLOWED TO COST ───────────────────
 *
 * SPELLING ACROSS EVERY DEPTH FIRST, then identity — because identity costs a
 * stat per candidate depth plus a stat per entry, and the correctly-spelled
 * registry is the overwhelmingly common case. Instrumented on a 60-member
 * workspace over 200 warm calls, resolving from a directory inside a member: the
 * single-pass form built the whole identity set at the first depth whose exact
 * spelling missed and cost 61 `statSync` (66 at six levels deep), against 0
 * before member identity existed. Two passes make that shape free.
 *
 * A NAIVE two-pass form would also CHANGE ANSWERS, in the one direction that
 * costs data, and this one therefore does not take it: returning the deepest
 * SPELLING match without looking deeper by identity would resolve a file in
 * `api/web` to `api` for the registry `['api', 'Api/web']`, so `api/web`'s own
 * state stops resolving to itself and becomes a deletion candidate — the exact
 * sweep this matcher exists to prevent, reintroduced by an optimization. The
 * second pass therefore still runs, and runs at every depth DEEPER than the
 * spelling match, which is the complete set of depths that could beat it.
 *
 * The pass is PRUNED BY DEPTH rather than by any rule about names: an entry can
 * only be compared against a candidate carrying the same number of segments. A
 * differently-deep entry reaching the same directory is a symlink or a bind
 * mount, and that population is exactly the one the note on `namesDirectly`
 * denies member standing to anyway — it keeps its standing on the deletion axis
 * through `registryEnclosureOf`, which is unpruned and is what the sweep asks.
 *
 * WHY UNPRUNING THIS PASS CHANGES NO ANSWER, stated correctly because the
 * obvious version of the argument is false. It is NOT that two directories can
 * only share a `dev:ino` at different depths as the filesystem root, or that
 * making them do so needs privilege: stock macOS ships nineteen firmlink pairs
 * that are exactly this — identical device and inode at different depths,
 * transparent to `realpathSync`, available to any user. What actually holds is
 * narrower and stronger: every such pair's two spellings share no common
 * ancestor BELOW the filesystem root, while a registry's entries are all
 * relative to one workspace root that this resolver never lets be the root
 * (`isMachineConfigRoot` and the `$HOME` stop in hook/paths.ts end the walk
 * first). So no pair of them can appear as two entries of one registry, and a
 * differently-deep match inside a workspace is a symlink or a bind mount the
 * author made — the population `namesDirectly` denies anyway.
 *
 * The exact spelling is still tried FIRST at every depth, and not only to save a
 * syscall: it is what keeps a registry entry naming a directory that does not
 * exist behaving exactly as it did before — a ghost entry claims a descendant
 * spelled the same way, and stats nothing.
 *
 * SPELLING-PRESERVING, and now more strictly than before: the result is built
 * from the DESCENDANT's own segments on the caller's own `root`, never from the
 * entry and never from a realpath. The deletion predicate in
 * shared/retention.ts compares the resolver's answer to its own input BY
 * STRING, so returning the registry's `Api` for a directory the caller called
 * `api` would have left the member a deletion candidate even once it was
 * correctly recognised — the string test moved, not the outcome. For every
 * entry whose spelling already matches, the two are the same string.
 */
export function enclosingRegisteredMember(
  root: string,
  registry: WorkspaceMemberRegistry,
  descendant: string,
): string | null {
  if (registry.kind !== 'members' || registry.members.length === 0) return null;
  const rootAbs = path.resolve(root);
  const rel = path.relative(rootAbs, path.resolve(descendant)).replace(/\\/g, '/');
  // The workspace root is never its own member: an empty relative path matches
  // no entry, because every validated entry has at least one segment.
  if (!rel || rel === '.' || rel.startsWith('../')) return null;
  const parts = rel.split('/');
  const spelled = new Set(registry.members);

  // PASS 1 — spelling, deepest first, no syscall at all.
  let spelledDepth = 0;
  for (let depth = parts.length; depth >= 1; depth -= 1) {
    if (spelled.has(parts.slice(0, depth).join('/'))) { spelledDepth = depth; break; }
  }
  // Nothing can be deeper than the descendant itself, so this exit is the whole
  // of the common case: a member asked about itself never stats anything.
  if (spelledDepth === parts.length) return path.join(root, ...parts);

  // PASS 2 — identity, only at the depths that could still beat pass 1, and only
  // against the entries carrying that many segments.
  const byDepth = entriesByDepth(registry.members);
  let rootReal = '';
  for (let depth = parts.length; depth > spelledDepth; depth -= 1) {
    const entries = byDepth.get(depth);
    if (!entries) continue;
    const segments = parts.slice(0, depth);
    const candidate = directoryIdentity(path.join(rootAbs, ...segments));
    if (candidate.kind !== 'identity') continue;
    for (const entry of entries) {
      const found = directoryIdentity(path.join(rootAbs, ...entry));
      if (found.kind !== 'identity' || found.id !== candidate.id) continue;
      if (!rootReal) rootReal = realpathOrSelf(rootAbs);
      if (namesDirectly(rootReal, rootAbs, entry)) return path.join(root, ...segments);
    }
  }
  return spelledDepth > 0 ? path.join(root, ...parts.slice(0, spelledDepth)) : null;
}

/**
 * Collapse a list of member directories to one entry PER DIRECTORY, keeping the
 * first spelling of each.
 *
 * The counting side of the same question `enclosingRegisteredMember` answers on
 * the matching side, and they have to agree: with the registry `['api', 'Api']`
 * on a case-folding volume, `<ws>/api/a.ts` and `<ws>/Api/b.ts` are two writes
 * into ONE directory, and a fence counting by string reports "spans 2 members"
 * about a call that spans one. (It denied either way, so this is a wording
 * defect rather than a hole — but a lane that applied filesystem identity to
 * matching and left string equality on counting has two rules for one question,
 * and the next reader cannot tell which is the intended one.)
 *
 * AN UNAVAILABLE IDENTITY KEEPS THE ENTRIES APART, which is the safe direction
 * here and the opposite of the one the deletion axis wants: merging two
 * directories we cannot prove are one would UNDER-count a span and allow a
 * cross-member call, while keeping them apart over-counts and refuses. The
 * refusal names both spellings, so a user reading it can see what happened.
 */
export function dedupeMemberDirectories(dirs: readonly string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const identity = directoryIdentity(dir);
    const key = identity.kind === 'identity' ? identity.id : `spelled:${path.resolve(dir)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(dir);
  }
  return kept;
}

