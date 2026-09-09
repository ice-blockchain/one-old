// src/shared/state/workspace-members.ts
// The WRITE half of the Traffic One workspace members registry. The read half —
// and the long note on which of this tree's five "workspace" senses this is —
// lives in shared/hook/workspace-members.ts, which is a leaf so the resolution
// walk can reach it; this side needs the state lock and the write fence, so it
// lives here instead of closing a state → hook/paths → state cycle.

import * as path from 'path';

import { STATE_DIR, STATE_FILE } from '../../config/paths';
import { TRAFFIC_ONE_BLOCK_BODY } from '../architecture-contract/scaffold-content';
import { readJsonResult } from '../fsjson';
import {
  MEMBER_OPT_OUT_KEY,
  WORKSPACE_MEMBERS_KEY,
  WORKSPACE_PROJECT_MODE,
  memberGitOwnership,
  memberPathVerdict,
  readWorkspaceMemberRegistry,
  resolveMemberIdentities,
  type WorkspaceMemberIdentity,
} from '../hook/workspace-members';
import { convertToContainerCommand, convertToContainerYesCommand } from '../workspace-command';
import { patchState } from './normalize';

/**
 * What a registry write did.
 *
 * `rejected` and `refused` are separated because they are answers from
 * different parties and only one of them is retryable by fixing the input:
 * `rejected` is THIS function declining a member path it will not vouch for,
 * and `refused` is the state file declining the write (the consent fence, a
 * planted symlink, a `.one.json` whose current bytes could not be read). A
 * caller that reported "saved" over either is the defect class
 * tests/refusal-contract.test.ts ratchets against.
 */
export type WorkspaceMemberRegistryWrite =
  | {
    readonly outcome: 'written';
    readonly members: readonly string[];
    /** Every entry as published, opted-out ones included, each with the id now RECORDED. */
    readonly identities: readonly WorkspaceMemberIdentity[];
  }
  | { readonly outcome: 'rejected'; readonly why: string }
  | { readonly outcome: 'refused'; readonly why: string };

/**
 * A member as a caller nominates it. A bare string is still accepted and still
 * means "manage this directory", so every existing call site reads unchanged.
 */
export interface WorkspaceMemberInput {
  readonly dir: string;
  /** See MEMBER_OPT_OUT_KEY: considered, and this workspace does not manage it. */
  readonly optOut?: boolean;
  /**
   * An id to record instead of the derived one. Supplying it is how a caller
   * PRESERVES identity across a rename: re-register the moved directory with
   * the id it already had and every run record that named it still joins.
   */
  readonly id?: string;
}

/**
 * The mode a directory has ALREADY committed, when that mode forbids making it
 * a container — or '' when nothing stands in the way.
 *
 * A CONTAINER IS NOT AN UPGRADE OF A PROJECT. This write publishes
 * `mode: 'workspace'`, and doing that to a directory already onboarded as
 * `new-project` / `existing-codebase` / `existing-with-supabase` would not add
 * a capability to it, it would REPLACE its identity: `inferPhaseFromMode` stops
 * reading it as maintenance, `isExistingProjectMode` starts answering false,
 * and — the one that cannot be undone by writing the old mode back — every gate
 * begins refusing every call at that root as "a container with no project in
 * it" (shared/tool-scope.ts). A repository with a plan, a compiled architecture
 * and run history would be told it holds no project.
 *
 * Unreachable before this wave (nothing called this function) and reachable the
 * moment registration exists, because the directory a person runs setup in is
 * routinely one that has already been set up.
 *
 * Read OUTSIDE the state lock, which is a bounded race and not a hole: the only
 * writer that could commit a mode in the gap is another onboarding of the same
 * directory, and two of those are already contending for what this directory
 * is. The value being read is durable — a project does not spontaneously stop
 * being one — so a stale read here is a stale read of a constant.
 */
function blockingCommittedMode(root: string): string {
  const read = readJsonResult<Record<string, unknown>>(path.join(root, STATE_FILE));
  if (read.kind !== 'ok' || !read.value || typeof read.value !== 'object') return '';
  const mode = (read.value as Record<string, unknown>).mode;
  if (typeof mode !== 'string' || !mode.trim() || mode === WORKSPACE_PROJECT_MODE) return '';
  return mode;
}

/**
 * Publish `workspaceRoot`'s member registry, and mark it a workspace project.
 *
 * WHOLE-VALUE, not append-one, and that is a correctness choice rather than a
 * convenience: `patchState` re-reads the base INSIDE the state lock and merges
 * the fields handed to it, so a whole-array field is published atomically,
 * while an append would have to read the current array OUTSIDE the lock and
 * would silently drop a member registered by a concurrent process. A workspace's
 * membership is authored as a set anyway — onboarding decides which directories
 * are members — so nothing wants the append.
 *
 * ALL-OR-NOTHING on validation, mirroring the reader's one-bad-entry-poisons-the-
 * list rule. A registry that was half-written is a registry whose author
 * believes it lists more than it does.
 *
 * The mode goes in the SAME patch as the members. A registry without
 * `mode: 'workspace'` is inert (the reader's first comparison rejects it) and a
 * workspace mode without a registry registers nobody, so publishing them
 * separately would leave a window in which the state file means neither thing.
 *
 * A directory that has already committed a PROJECT mode is refused outright —
 * see blockingCommittedMode.
 */
export function writeWorkspaceMemberRegistry(
  workspaceRoot: string,
  memberDirs: readonly (string | WorkspaceMemberInput)[],
): WorkspaceMemberRegistryWrite {
  const root = path.resolve(workspaceRoot);
  const committedMode = blockingCommittedMode(root);
  if (committedMode) {
    return {
      outcome: 'rejected',
      why: `${root} is already onboarded as a ${committedMode} project, and a Traffic One workspace is a CONTAINER of `
        + 'projects rather than a project with members — converting it would make every gate refuse work at this root. '
        + `To convert this directory into a container, run ${convertToContainerCommand()} `
        + `(or ${convertToContainerYesCommand()} if it already has a plan or runs). `
        + 'Register members in the directory that HOLDS the projects.',
    };
  }
  const nominated: { path: string; declaredId: string | null; optOut: boolean }[] = [];
  for (const nomination of memberDirs) {
    const input: WorkspaceMemberInput = typeof nomination === 'string' ? { dir: nomination } : nomination;
    const memberDir = input?.dir;
    if (typeof memberDir !== 'string' || !memberDir.trim()) {
      return { outcome: 'rejected', why: `${JSON.stringify(memberDir)} is not a directory` };
    }
    // Absolute and relative spellings both arrive here — a caller holding
    // resolved directories should not have to relativize them itself, and a
    // caller holding relative ones should not have to absolutize them. Either
    // way the stored form is relative to the root, because an absolute entry in
    // a committed file would break the moment the repository is cloned
    // somewhere else.
    const absolute = path.isAbsolute(memberDir) ? path.resolve(memberDir) : path.resolve(root, memberDir);
    const rel = path.relative(root, absolute).replace(/\\/g, '/');
    if (!rel || rel === '.' || rel.startsWith('../')) {
      return { outcome: 'rejected', why: `${memberDir} is not inside ${root}` };
    }
    const verdict = memberPathVerdict(rel);
    // The reader's own reason, forwarded verbatim rather than flattened into
    // "not a member path this reader accepts" — a vendor directory and a glob
    // fail here for different reasons and send a caller to different fixes.
    if (!verdict.ok) return { outcome: 'rejected', why: `${memberDir} is not a member path this reader accepts: it ${verdict.why}` };
    const declaredId = input.id ?? null;
    const optOut = input.optOut === true;
    const duplicate = nominated.find((entry) => entry.path === verdict.path);
    if (duplicate) {
      // Nominating the same directory twice IDENTICALLY is deduplicated, as it
      // always was. Nominating it twice with different answers is not a
      // duplicate, it is a CONTRADICTION, and picking one silently would record
      // an opt-out the caller may have meant to revoke, or revoke one it meant
      // to keep.
      if (duplicate.optOut !== optOut || duplicate.declaredId !== declaredId) {
        return { outcome: 'rejected', why: `${verdict.path} is nominated twice with different terms` };
      }
      continue;
    }
    nominated.push({ path: verdict.path, declaredId, optOut });
  }

  // Identity is settled through the READER's own resolver, not through a second
  // derivation living here. The bucket name must come from the function that
  // creates it — the rule state/traffic-one-paths.ts records after a $HOME
  // self-heal silently no-opped because a guard and a delete each computed the
  // "same" hash their own way.
  const resolved = resolveMemberIdentities(nominated);
  if (resolved.kind === 'collision') return { outcome: 'rejected', why: resolved.why };
  const members = resolved.identities.filter((identity) => !identity.optOut).map((identity) => identity.path);

  // The id is RECORDED for every entry, including ones this call derived. That
  // is the whole point of the derivation being a bootstrap: once written, the
  // id survives a rename of the directory it was derived from, and it survives
  // a later member joining the workspace and colliding with its base. A
  // registry that stored only paths would re-derive — and therefore silently
  // re-assign — an id on every read.
  const entries = resolved.identities.map((identity) => (identity.optOut
    ? { path: identity.path, id: identity.id, [MEMBER_OPT_OUT_KEY]: true }
    : { path: identity.path, id: identity.id }));
  // NO `onboardingComplete`, DELIBERATELY — do not "fix" this by adding it.
  //
  // It looks like an omission because every project state file carries it, and
  // the obvious reading is that a container is left permanently un-onboarded.
  // It is not: for `mode: 'workspace'` the onboarding gate asks
  // `computeOnboarding(root).done`, and that answer comes from the container
  // branch in onboarding-server/flow.ts — the shared steps, then the member
  // recursion — which never reads this field. So the flag decides nothing the
  // container's own completeness depends on, and `normalizeState` cannot heal
  // it in either, because it returns at its stackless early exit and a
  // container has no stack.
  //
  // What the flag WOULD decide is materialization. materialize/converge.ts asks
  // `state.mode === 'new-project' || state.onboardingComplete === true` on a
  // stackless state, so adding it routes a container into
  // materializeProjectFromState. Measured both ways: absent yields `null` and
  // nothing written, present yields status `incomplete` and the system message
  // "`.traffic-one/.one.json` is incomplete; cannot materialize project" on
  // every SessionStart. Nothing is written either way — validation catches
  // it — but the second is a false statement about a file that is exactly as
  // complete as it should be, and it sends the reader off to repair the
  // container when the thing to do is work in a member.
  //
  // The boolean is the whole point of routing through patchState: it is false
  // when the fence refused, when a symlink was planted, and when the current
  // `.one.json` was corrupt or unreadable (patchState refuses rather than
  // healing, so a torn file is preserved instead of being replaced by this one
  // field). Minting a `written` over any of those is the failure this repo has
  // shipped most often.
  if (!patchState(root, { mode: WORKSPACE_PROJECT_MODE, [WORKSPACE_MEMBERS_KEY]: entries })) {
    return {
      outcome: 'refused',
      why: `${path.join(root, '.traffic-one', '.one.json')} did not accept the write`,
    };
  }
  return { outcome: 'written', members, identities: resolved.identities };
}

/**
 * What registering ONE member did.
 *
 * `already` is separated from `registered` because the caller reports them
 * differently — re-running setup on a member that is already registered is the
 * ordinary idempotent case and must not read as a fresh registration.
 */
export type WorkspaceMemberRegistration =
  | { readonly outcome: 'registered'; readonly member: WorkspaceMemberIdentity }
  | { readonly outcome: 'already'; readonly member: WorkspaceMemberIdentity }
  /**
   * The repository has recorded that this workspace does NOT manage this
   * directory, and that decision is FINAL here. Registration is the one
   * operation that would silently reverse it, so it is the one operation that
   * has to refuse: `optOut` is committed in `.one.json`, it travels with the
   * clone, and a person running setup inside the directory is not evidence that
   * the team's exclusion was withdrawn. Revoking it is an edit to the
   * repository's own state, made deliberately, by whoever made the exclusion.
   */
  | { readonly outcome: 'opted-out'; readonly member: WorkspaceMemberIdentity; readonly why: string }
  | { readonly outcome: 'rejected'; readonly why: string }
  | { readonly outcome: 'refused'; readonly why: string };

/**
 * Add `memberPath` to `workspaceRoot`'s registry, preserving every entry that
 * is already there.
 *
 * The underlying write is WHOLE-VALUE (see writeWorkspaceMemberRegistry), so
 * this re-nominates the existing entries WITH the ids and opt-outs they already
 * carry. Re-deriving them instead would silently re-id a member the moment this
 * registration changed a collision count — `apps/web` alone is `web`, and the
 * arrival of `services/web` turns both into disambiguated ids, which would
 * orphan every run record that named the first one.
 *
 * An unenumerable registry REFUSES rather than being replaced. The bytes say
 * something this reader could not understand; overwriting them with a list
 * built from what it could parse would drop members it never saw.
 */
export function registerWorkspaceMember(
  workspaceRoot: string,
  memberPath: string,
): WorkspaceMemberRegistration {
  const root = path.resolve(workspaceRoot);
  const registry = readWorkspaceMemberRegistry(root);
  if (registry.kind === 'illegible' || registry.kind === 'opaque') {
    return { outcome: 'refused', why: `${root}: ${registry.why}` };
  }
  const verdict = memberPathVerdict(
    path.isAbsolute(memberPath)
      ? path.relative(root, path.resolve(memberPath)).replace(/\\/g, '/')
      : memberPath,
  );
  if (!verdict.ok) return { outcome: 'rejected', why: `${memberPath} ${verdict.why}` };

  const existing = registry.kind === 'members' ? registry.identities : [];
  const already = existing.find((entry) => entry.path === verdict.path);
  if (already?.optOut) {
    return {
      outcome: 'opted-out',
      member: already,
      why: `${verdict.path} is recorded in ${root}'s member registry as opted out, and that exclusion is committed to `
        + 'the repository. Traffic One does not re-enable a directory the repository excluded; remove the '
        + `${MEMBER_OPT_OUT_KEY} entry there if the exclusion no longer applies.`,
    };
  }
  if (already) return { outcome: 'already', member: already };

  const nominations: WorkspaceMemberInput[] = [
    ...existing.map((entry) => ({ dir: entry.path, id: entry.id, optOut: entry.optOut })),
    { dir: verdict.path },
  ];
  const written = writeWorkspaceMemberRegistry(root, nominations);
  if (written.outcome !== 'written') return written;
  const member = written.identities.find((entry) => entry.path === verdict.path);
  return member
    ? { outcome: 'registered', member }
    : { outcome: 'refused', why: `${verdict.path} is absent from the registry this write published` };
}

// ── RECURSIVE GITIGNORE ──────────────────────────────────────────────────────

/**
 * The Traffic One ignore region, re-anchored so it also covers MEMBERS.
 *
 * THE DEFECT THIS FIXES, measured against git 2.50.1 rather than reasoned from
 * the documentation. A gitignore pattern containing a `/` anywhere but at its
 * end is anchored to the directory holding the `.gitignore`, so the container's
 * existing region — `TRAFFIC_ONE_BLOCK_BODY`, whose lines all read
 * `.traffic-one/<entry>` — matches the CONTAINER's own run state and nothing
 * else. In a container holding `member/.traffic-one/runs/b.json` and
 * `deep/nest/member2/.traffic-one/runs/d.json`, `git check-ignore` reported
 * both as tracked. With the `RECURSIVE_ANCHOR` prefix below (a doubled star and
 * a slash, git's "match in all directories" form) it reported both as ignored,
 * and the container's own `.traffic-one/runs/` stayed ignored too — one region
 * covers every depth, so a member does not need a file of its own merely
 * because it is nested.
 *
 * DERIVED BY EXPRESSION from `TRAFFIC_ONE_BLOCK_BODY`, never re-listed. That
 * constant is the authority on WHICH Traffic One artifacts git may ignore, and
 * it carries a decision this must not quietly reverse: `digests/` is
 * deliberately absent from it, because the handoff record is the one artifact
 * the reader needs to see. The same measurement confirmed it —
 * `member/.traffic-one/digests/c.md` stayed tracked under both bodies. Never
 * hide from git something the reader needs to see; re-anchoring a list must not
 * become an opportunity to lengthen it.
 *
 * The prefix is applied only to lines that begin with the state directory, so
 * the two comment lines the authority carries survive untransformed and a
 * future non-`.traffic-one` entry is left alone rather than being silently
 * globbed.
 */
const RECURSIVE_ANCHOR = '**/';

export const WORKSPACE_MEMBER_GITIGNORE_BODY = TRAFFIC_ONE_BLOCK_BODY
  .split('\n')
  .map((line) => (line.startsWith(`${STATE_DIR}/`) ? `${RECURSIVE_ANCHOR}${line}` : line))
  .join('\n');

/**
 * WHERE a member's Traffic One artifacts have to be ignored, and with what.
 *
 * A PLAN, not a write, and that is deliberate for this wave: nothing may start
 * writing into a real project until workspace onboarding exists. The caller
 * that eventually converges these files is `ensureProjectGitignore`
 * (architecture-contract/scaffold-content.ts), which performs no consent check
 * of its own, so whoever wires this up gates it the way
 * `materializeProjectAssets` already does.
 *
 * The three answers follow git's own boundary rule rather than a preference:
 *
 *   at-member    — the member owns a repository, so the container's
 *                  `.gitignore` cannot reach its files at all. Ignore rules do
 *                  not cross a repository boundary; the region must be inside.
 *                  The body is the UNANCHORED authority, because inside its own
 *                  repository the member IS the root, and the recursive anchor
 *                  would only widen the region to sub-directories nobody writes
 *                  into.
 *   at-workspace — the member's files belong to a repository at or above the
 *                  container, so ONE recursive region at the container covers
 *                  this member and every other one. Preferred over a file per
 *                  member because Traffic One is writing into a repository it
 *                  did not create, and the standing rule there (see
 *                  TRAFFIC_ONE_BLOCK_BODY) is to impose the least it can: one
 *                  region in one file the project already has, rather than N
 *                  new files in N directories.
 *   none         — an opted-out member. Traffic One writes nothing inside a
 *                  member it does not manage, so there is nothing to ignore,
 *                  and minting a `.gitignore` there would be the first artifact
 *                  of the management the user declined.
 *
 * The `unobservable` ownership arm — a member path naming a directory that is
 * not there — also yields `none`, and for a reason worth separating from the
 * opt-out one: we cannot say where a plan belongs for a directory we could not
 * read, and guessing `at-workspace` would write a region for a member that may
 * never exist.
 */
export type MemberGitignorePlan =
  | { readonly kind: 'at-member'; readonly file: string; readonly body: string; readonly why: string }
  | { readonly kind: 'at-workspace'; readonly file: string; readonly body: string; readonly why: string }
  | { readonly kind: 'none'; readonly why: string };

export function memberGitignorePlan(
  workspaceRoot: string,
  member: Pick<WorkspaceMemberIdentity, 'path' | 'optOut'>,
): MemberGitignorePlan {
  const root = path.resolve(workspaceRoot);
  if (member.optOut) {
    return { kind: 'none', why: `${member.path} is opted out, so Traffic One writes nothing inside it` };
  }
  const ownership = memberGitOwnership(root, member.path);
  if (ownership.kind === 'unobservable') {
    return { kind: 'none', why: `${member.path} could not be observed: ${ownership.why}` };
  }
  if (ownership.kind === 'own-repository') {
    return {
      kind: 'at-member',
      file: path.join(root, ...member.path.split('/'), '.gitignore'),
      body: TRAFFIC_ONE_BLOCK_BODY,
      why: `${member.path} carries its own ${ownership.marker}, and ignore rules do not cross a repository boundary`,
    };
  }
  return {
    kind: 'at-workspace',
    file: path.join(root, '.gitignore'),
    body: WORKSPACE_MEMBER_GITIGNORE_BODY,
    why: ownership.kind === 'container-repository'
      ? `${member.path} belongs to the repository at ${ownership.repositoryRoot}, which one recursive region covers`
      : `${member.path} owns no repository within the workspace, so the container's region is the one that can cover it`,
  };
}
