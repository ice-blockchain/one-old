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

import * as path from 'path';

import { STATE_FILE } from '../../config/paths';
import { readJsonResult } from '../fsjson';

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
  | { readonly kind: 'members'; readonly members: readonly string[] };

type Rec = Record<string, unknown>;

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
  if (raw === undefined || raw === null) return { kind: 'members', members: [] };
  if (!Array.isArray(raw)) return { kind: 'opaque', why: `${WORKSPACE_MEMBERS_KEY} is not an array` };
  const members: string[] = [];
  for (const entry of raw) {
    const member = validateMemberEntry(entry);
    if (member === null) {
      return { kind: 'opaque', why: `${WORKSPACE_MEMBERS_KEY} holds the entry ${JSON.stringify(entry)}, which is not a member path` };
    }
    members.push(member);
  }
  return { kind: 'members', members };
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
 * The poison is safe HERE for a reason that is specific rather than assumed:
 * `opaque` denies everything, and denying everything is precisely today's
 * behaviour, because nothing in the tree carries this mode. A malformed registry
 * therefore cannot do worse than not existing.
 */
function validateMemberEntry(entry: unknown): string | null {
  // Objects only. A bare string entry is rejected on purpose: the registry is
  // the extension point for per-member facts a later item needs to attach, and
  // accepting two shapes now means validating two shapes forever.
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return validateMemberPath((entry as Rec).path);
}

// A registry lists DIRECTORIES, never patterns — the whole difference from the
// declaration reader next door. Glob metacharacters are therefore rejected
// rather than interpreted: a `*` in a registry entry is a malformed entry, and
// reading it as a wildcard would silently widen an authorization the author
// wrote as a literal.
const GLOB_SYNTAX = /[*?[\]{}()!]/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** A member path this reader is willing to vouch for, normalized, or null. */
export function validateMemberPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized) return null;
  // Relative to the workspace root, always. An absolute entry would let a
  // hand-edited `.one.json` nominate any directory on the machine as "a member
  // of this workspace", which is authority the file has no business carrying.
  if (normalized.startsWith('/') || WINDOWS_DRIVE.test(normalized)) return null;
  if (GLOB_SYNTAX.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return normalized;
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
 * SPELLING-PRESERVING, and that is inherited rather than incidental: the result
 * is `path.join(root, …)` on the caller's own `root`, never a realpath. The
 * deletion predicate in shared/retention.ts compares the resolver's answer to
 * its own input BY STRING, so an exit that canonicalized here would make every
 * member of a workspace reached through a symlinked checkout a deletion
 * candidate — see the contract note above resolveProjectRoot.
 */
export function enclosingRegisteredMember(
  root: string,
  registry: WorkspaceMemberRegistry,
  descendant: string,
): string | null {
  if (registry.kind !== 'members' || registry.members.length === 0) return null;
  const rel = path.relative(path.resolve(root), path.resolve(descendant)).replace(/\\/g, '/');
  // The workspace root is never its own member: an empty relative path matches
  // no entry, because every validated entry has at least one segment.
  if (!rel || rel === '.' || rel.startsWith('../')) return null;
  let best = '';
  for (const member of registry.members) {
    if (rel !== member && !rel.startsWith(`${member}/`)) continue;
    if (member.length > best.length) best = member;
  }
  return best ? path.join(root, ...best.split('/')) : null;
}
