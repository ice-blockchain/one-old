// src/shared/hook/paths.ts
// Project-root resolution from a hook tool's file path + new-project monorepo
// predicates. Ported 1:1 from scripts/hook-runtime/handlers/_helpers.cjs.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { STATE_DIR, STATE_FILE } from '../../config/paths';
import { hasPluginAuthoringMarkers, isMachineConfigRoot } from '../authoring-root';
import { readJson, readJsonResult } from '../fsjson';
import { obj } from '../obj';
import { dirOwnsProject, projectMembershipRoot } from '../project-membership';
import { isNativeState } from '../state';
import { hasStateFile } from '../tool-classify';
import { dirDeclaresWorkspace, workspaceClaimsDescendant } from './workspace-declaration';
import {
  WORKSPACE_PROJECT_MODE,
  type WorkspaceMemberRegistry,
  enclosingRegisteredMember,
  readWorkspaceMemberRegistry,
  registryEnclosureOf,
  workspaceMemberRegistryOf,
} from './workspace-members';

// Re-exported so the resolver stays the single import surface for root questions.
export { dirOwnsProject, projectMembershipRoot } from '../project-membership';

type Rec = Record<string, unknown>;

// Kilo's OpenCode-compatible hook bridge can drop the leading slash from an
// absolute macOS path. Restore it only when the resulting path is inside this
// hook's cwd, so an ordinary relative `Users/...` target is never reinterpreted.
function normalizeHookTargetPath(cwd: string, filePath: unknown): string {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || path.isAbsolute(normalized)) return normalized;
  const rootlessAbsolute = path.resolve(path.sep, normalized);
  return isPathWithin(rootlessAbsolute, path.resolve(cwd)) ? rootlessAbsolute : normalized;
}

export function stateRequiresNewProjectMonorepo(state: Rec): boolean {
  if (!state || state.mode !== 'new-project' || isNativeState(state)) return false;
  // The pnpm/Turborepo layout is a named profile contract, not a fallback for
  // every React-labelled or backend-backed project. Custom profiles keep the
  // roots compiled by the capability registry.
  return state.stack === 'default' || state.stack === 'react-realtime-monorepo';
}

// Walk up from the tool's target file to the nearest dir (within cwd) that has a
// .traffic-one state file — that's the project root for monorepo sub-apps.
export function findProjectRootForHookFile(cwd: string, filePath: unknown): string {
  const normalized = normalizeHookTargetPath(cwd, filePath);
  if (!normalized) return cwd;
  const absPath = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
  const cwdAbs = path.resolve(cwd);
  // Segment-aware containment (isPathWithin): a sibling dir sharing a name prefix
  // (/repo vs /repo2) must not be walked as if it were inside cwd.
  const within = (dir: string): boolean => isPathWithin(dir, cwdAbs);
  let current = path.dirname(absPath);
  while (within(current)) {
    // The plugin's own repo and machine-config space (incl. exact system-temp
    // roots) are never project roots, even with a stray state file.
    if (hasStateFile(current) && !hasPluginAuthoringMarkers(current) && !isMachineConfigRoot(current)) return current;
    if (current === cwdAbs) break;
    current = path.dirname(current);
  }
  return cwd;
}

// A dir is a REAL Traffic One project root only when its `.one.json` carries a
// committed `mode` (new-project / existing-*). A monorepo sub-package can accrue a
// SHALLOW stray state file — e.g. just `one-uid`, written by cwd-scoped
// materialization when a scaffolder cd'd into it — which is NOT a root and must not
// shadow the workspace that actually holds the onboarding/lifecycle state.
export function isOnboardedProjectRoot(dir: string): boolean {
  return committedProjectState(dir) !== null;
}

/**
 * The state record behind `isOnboardedProjectRoot`, or null when the directory
 * is not a real root — the SAME single `.one.json` read, handing back the value
 * it already had instead of throwing it away.
 *
 * Split out so the resolution walk can ask a second question of each level (is
 * this a workspace that registered a member below it?) without a second
 * syscall. Behaviour-identical to the `readJson(…, {})` form it replaces on
 * every input: `readJson` IS `readJsonResult` plus a fallback, and every
 * non-`ok` kind — as well as every `ok` value with no string `mode` — reached
 * the same `false` there that reaches `null` here.
 */
function committedProjectState(dir: string): Rec | null {
  const read = readJsonResult<Rec>(path.join(dir, STATE_FILE));
  if (read.kind !== 'ok') return null;
  const s = read.value;
  if (!s || typeof s !== 'object') return null;
  return typeof s.mode === 'string' && s.mode.trim() ? s : null;
}

// Bound the upward walk so a hook can never spend unbounded fs reads climbing to /.
const MAX_ROOT_WALK = 40;

// Ancestor-or-self containment (segment-aware: /repo is not within /repo2).
export function isPathWithin(dir: string, root: string): boolean {
  const d = path.resolve(dir);
  const r = path.resolve(root);
  return d === r || d.startsWith(r + path.sep);
}

// A hook can run with a cwd (or target file) that has DRIFTED inside the
// project's own state tree — e.g. an agent that `cd`'d into
// `.traffic-one/skills/<name>` to read a skill and stayed there. Resolution
// must never anchor inside `.traffic-one/**`: truncate at the first state-dir
// segment so the walk starts from the enclosing project instead.
export function stripStateDirSuffix(dir: string): string {
  if (!dir) return dir;
  const resolved = path.resolve(dir);
  const segments = resolved.split(path.sep);
  const idx = segments.indexOf(STATE_DIR);
  if (idx <= 0) return resolved;
  return segments.slice(0, idx).join(path.sep) || resolved;
}

/**
 * How much authority a workspace DECLARATION carries over a descendant that
 * holds state of its own.
 *
 * `declared` — the historical, deliberately lenient rule: any declaration is
 * enough to move a descendant off its own root. Correct for RESOLUTION, where
 * the cost of a false positive is resolving up one level and the cost of a miss
 * is a stray `.traffic-one` minted into a sub-package (dirDeclaresWorkspace).
 *
 * `membership` — the declaration must POSITIVELY claim this descendant: some
 * declared pattern matches it, or matches an ancestor of it below the root. For
 * a consumer whose false positive is a DELETION, and only for such a consumer.
 * Its single caller is shared/retention.ts isLeakedNestedRoot.
 *
 * The two modes exist because the safe direction is OPPOSITE for the two
 * consumers, so no single leniency setting can serve both — see the header of
 * hook/workspace-declaration.ts for the measurement that forced the split.
 */
export type WorkspaceAuthority = 'declared' | 'membership';

// `claimant` is empty in `declared` mode. In `membership` mode it is the
// directory whose fate is being decided, and a declaration only anchors when it
// claims that directory — except for the directory ITSELF, which is its own
// workspace root whenever it declares one.
function dirAnchorsWorkspaceFor(dir: string, claimant: string): boolean {
  if (!claimant || path.resolve(dir) === path.resolve(claimant)) return dirDeclaresWorkspace(dir);
  return workspaceClaimsDescendant(dir, claimant);
}

/**
 * An onboarded root the walk stopped at, plus the ONE extra fact the walk
 * already knows about it and used to throw away: whether a workspace CONTAINER
 * was involved, and which members it registered.
 *
 * `container` and `registry` are set together or not at all — a non-empty
 * container always carries the registry that made it one. They are set on BOTH
 * container outcomes: the walk that adopted the container itself (`root ===
 * container`) and the walk that was handed DOWN to a member (`root` is the
 * member). The second is the one that is easy to drop and expensive to lose:
 * without it a call already resolved to a member could not say WHICH workspace
 * it is a member of, and the attribution guard in plan-runteam.ts has nothing
 * to compare against.
 *
 * `none` is folded to null rather than carried, so a consumer's test is
 * `registry !== null` and not a second `kind` comparison it could get backwards.
 */
interface OnboardedRootHit {
  readonly root: string;
  readonly container: string;
  readonly registry: WorkspaceContainerRegistry | null;
}

/**
 * A registry that BELONGS to a container: the `none` arm is gone, because
 * `none` and "this is not a container" are the same statement and carrying both
 * spellings of it invites a consumer to test the wrong one. The remaining arms
 * all deny, and a consumer still has to tell `members` from the two that could
 * not be enumerated.
 */
export type WorkspaceContainerRegistry = Exclude<WorkspaceMemberRegistry, { kind: 'none' }>;

function containerRegistry(registry: WorkspaceMemberRegistry): WorkspaceContainerRegistry | null {
  return registry.kind === 'none' ? null : registry;
}

/**
 * The redirect's answer: the member the walk was handed down to, carrying the
 * container that registered it — UNLESS that member is a workspace container in
 * its own right, in which case it carries ITSELF and its own registry.
 *
 * The exception is the same one the acceptance clause makes with its
 * `!container` guard, at the other door into the same wrong answer. A container
 * nested inside a container is registered in the outer one, so the outer's
 * redirect names it as a member; reported with the OUTER's registry,
 * `workspaceAnchoring` finds it in that member list and the fence reports
 * `kind: 'member'` for a workspace root. Reported with its OWN registry, a call
 * that names no member of ITS registry is refused, which is the invariant.
 *
 * A SECOND DOOR, not a defensive duplicate — instrumented over the 21-shape
 * probe, this arm fires on exactly the two nested shapes whose inner container
 * the walk climbs PAST before it can be handed back down: the outer declaring
 * package-manager workspaces (so the inner container fails the leak test below)
 * and the inner container owning no project marker of its own. An inner
 * container the walk stops at never reaches the redirect at all, and is answered
 * by the `!container` guard instead.
 *
 * `root` is untouched either way, and that is what keeps the exception free of
 * deletion risk: retention compares the resolver's answer against its own input
 * by string, and this returns `member` in both arms.
 *
 * `committedProjectState` rather than `readWorkspaceMemberRegistry`, so an
 * ILLEGIBLE member state answers "not a container" instead of "a container
 * whose registry cannot be read". A member whose `.one.json` was torn by a merge
 * is already resolved through this redirect (the walk cannot read its mode
 * either, so it climbs past it), and refusing every call in it on the strength
 * of a file nobody could read would be a new deny for a routine conflict.
 */
function handDownToMember(
  member: string,
  container: string,
  registry: WorkspaceContainerRegistry | null,
): OnboardedRootHit {
  const own = committedProjectState(member);
  const nested = own ? containerRegistry(workspaceMemberRegistryOf(own)) : null;
  return nested
    ? { root: member, container: member, registry: nested }
    : { root: member, container, registry };
}

/**
 * Could an ancestor of `dir` possibly be a workspace that registered it — asked
 * with one `existsSync` per level up to `$HOME`, so the acceptance clause below
 * costs a project that is not inside a workspace one cheap upward pass instead
 * of a full `workspaceMembershipOf` walk.
 *
 * CHEAP IS NOT FREE, and calling it free was wrong twice over — the pass itself
 * costs a syscall per level, and a project whose ancestor DOES hold state pays
 * the full `workspaceMembershipOf` walk this exists to avoid, on EVERY
 * resolution. MEASURED per `resolveProjectRoot`, over 400 warm calls four levels
 * below a temp root, before this clause existed → with it:
 *   solo project                          21 → 32 `existsSync`,  7 →  7 `readFileSync`
 *   under an onboarded (non-ws) ancestor  21 → 37,               7 → 11
 *   member that declares pm workspaces     7 → 11,               3 →  3
 * Wall clock sits in the noise at this size (0.1-0.4 ms/call, and the solo case
 * measured FASTER after), so the counts are the honest figure, not the timings.
 * For the ordinary `~/code/proj` layout the `$HOME` stop keeps the pass to a
 * handful of levels, which is why this is not a budget problem in practice.
 *
 * This is a PRE-SCAN, never an answer: `workspaceMembershipOf` remains the
 * authority and re-walks with its own guards whenever this says "maybe". It may
 * only skip that walk when the walk's answer is already provable, and it is:
 * membership is granted exclusively by an ancestor whose
 * `.traffic-one/.one.json` reads `mode: 'workspace'`, so an ancestor chain
 * holding no `.traffic-one` AT ALL cannot produce one — nor an `illegible` or
 * `opaque` registry, the other two arms that are not `not-member`.
 *
 * The bounds here are deliberately WIDER than the real walk's, which is what
 * makes the implication sound rather than merely plausible. `isMachineConfigRoot`
 * and `hasPluginAuthoringMarkers` only ever STOP or SKIP a level, so omitting
 * them visits a SUPERSET of the directories `workspaceMembershipOf` would read;
 * a superset that finds no state guarantees the subset finds none either. The
 * `$HOME` stop is kept, and keeping it is not an optimization: without it every
 * project under a home directory would see `~/.traffic-one` — the machine-wide
 * config dir, which is not a workspace and never a project's ancestor for this
 * purpose — and pay the full walk on every call.
 *
 * Starts at the PARENT, matching `workspaceMembershipOf`: a workspace root is
 * never its own member, so the directory's own state (which the caller has just
 * read, and which is why we are here) says nothing about this question.
 *
 * EXPORTED ONLY TO BE PINNED, and the pin is the point. Everything above is an
 * argument from inspection, and it stays true only while the two walks agree —
 * add a stop condition here, or a membership-granting path over there that is
 * not an ancestor's `.one.json`, and this starts answering `false` for a genuine
 * member. Nothing would fail: the acceptance clause would simply be skipped, the
 * member would resolve with no container, and the fence would go quiet again
 * exactly the way it was quiet before it was fixed — a regression with no
 * symptom. `shared/__tests__/workspace-prescan-superset.test.ts` therefore
 * asserts the implication itself over a population of tree shapes, and asserts
 * that the population still contains members and still contains `false`
 * answers, because both degeneracies would leave it passing.
 */
export function anyAncestorHoldsState(dir: string, ceiling: string): boolean {
  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → MAX_ROOT_WALK-capped */ }
  let current = path.dirname(path.resolve(dir));
  for (let i = 0; i < MAX_ROOT_WALK; i += 1) {
    if (home && current === home) return false;
    if (ceiling && !isPathWithin(current, ceiling)) return false;
    if (fs.existsSync(path.join(current, STATE_DIR))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

/**
 * Is there a registered member BELOW `member` that also encloses `start`?
 *
 * The acceptance clause below accepts `member` because it is a registered
 * member of an enclosing workspace, and until this guard existed that was the
 * whole test — which orphaned the DEEPEST-MATCH rule
 * (`enclosingRegisteredMember`) for the one registry shape that can disagree
 * with it. A workspace may register both a directory and a subdirectory of it;
 * the membership function documents that shape as supported and
 * `writeWorkspaceMemberRegistry` permits it. When the shallower one is
 * onboarded and the deeper one is not, the walk from inside the deeper member
 * STOPS at the shallower one's committed state, accepts it, and never climbs to
 * the container — so the container's redirect, the only code that implements
 * "deepest match wins", never runs.
 *
 * MEASURED on a container registering `apps` and `apps/web` with `apps`
 * onboarded: `apps/web` and `apps/web/src` both resolved to `apps` with this
 * clause and to `apps/web` without it. It is NOT a deletion: the flip lives in
 * a directory holding no state, so no sweep evaluates it, and it heals the
 * moment `apps/web` is onboarded. What it costs is ATTRIBUTION: every consumer
 * that asks this function where it is — session start, prompt submit, the model
 * gate, subagent bind, the onboarding-gate stop, doctor, the cleanup and reset
 * runners — puts `apps/web`'s plan, run state and role claims under `apps`.
 *
 * NOT the member fence, which is the one place it would be most alarming and is
 * measured clean: `resolveToolScope` attributes each target through the
 * container's own registry rather than this walk, so a spanning call and a
 * cross-member write answer identically with this guard and without it. The
 * fence's own deepest-match rule is the same `enclosingRegisteredMember`; it
 * simply never arrives here to be orphaned.
 *
 * IT RETURNS THE DEEPER MEMBER RATHER THAN A BOOLEAN, and the earlier boolean
 * form was a defect rather than a simplification. "Declining costs nothing" was
 * written on the belief that the walk carries on, reaches the container and is
 * handed back DOWN — which is true of `root` and FALSE of `container`. Control
 * falls through to the two exits below the clause, and BOTH RETURN, with
 * `container: ''`, because the `!container` guard we are inside means there is no
 * container at this level to report. So a decline left `root` where it already
 * was AND stripped the member's workspace standing:
 *
 *   overlapping entry  root   container  scope.workspace.kind  cross-member span
 *   absent             apps   ws         unresolved            REFUSED
 *   present            apps   ''         none                  ALLOWED
 *
 * Over the 12-shape matrix (container declares package-manager workspaces ×
 * member owns a marker × member declares × deeper member onboarded) the boolean
 * form moved 6 rows: 3 fixed and 3 REGRESSED, each regressed row disabling the
 * fence for the shape in which a cross-member write is hardest to notice. The
 * clause's own test passed only because its fixture wrote `workspaces: ['apps']`
 * at the container, which is what let the walk climb after the decline.
 *
 * Handing DOWN directly is the same answer the container's redirect would have
 * produced, taken at the level that actually knows it: `handDownToMember` is the
 * identical function, given the container the membership verdict already carries.
 * The facts are all in hand — the verdict carries the container root and the
 * registry that granted it — so this is one registry query against a value the
 * clause just read, on the arm that already paid for a full
 * `workspaceMembershipOf` walk.
 *
 * The result can never be SHALLOWER than `member`: the walk climbs from `start`,
 * so `member` encloses `start`, so the deepest member enclosing `start` is
 * `member` or something below it — and `null` here means "it is `member`", which
 * is the acceptance the caller then makes.
 *
 * IT MOVES NO ROOT THAT ANY SWEEP EVALUATES. The population whose root moves is
 * exactly the starts inside a deeper member that is NOT onboarded: a start that
 * holds state stops the walk at itself one level earlier and is answered by the
 * acceptance above, and a start that holds none is not a directory retention
 * looks at.
 */
function deeperRegisteredMember(
  membership: { readonly workspaceRoot: string; readonly registry: WorkspaceContainerRegistry },
  member: string,
  start: string,
): string | null {
  const deepest = enclosingRegisteredMember(membership.workspaceRoot, membership.registry, start);
  return deepest !== null && path.resolve(deepest) !== path.resolve(member) ? deepest : null;
}

function nearestOnboardedRoot(startDir: string, ceiling?: string, authority: WorkspaceAuthority = 'declared'): OnboardedRootHit | null {
  // The home dir is machine-wide config space (`~/.traffic-one`), never a project
  // root. Stop the walk there (and never above it): a stray mode-bearing
  // `~/.traffic-one/.one.json` — e.g. from running the plugin in `~` once — must
  // NOT be adopted as the root for a project that lacks its own state file.
  // Computed per-call (not module-scoped) so tests can pin $HOME.
  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → unbounded but MAX-capped */ }
  const ceil = ceiling ? path.resolve(ceiling) : '';
  const start = path.resolve(startDir);
  let current = start;
  for (let i = 0; i < MAX_ROOT_WALK; i += 1) {
    if (home && current === home) break; // reached the home dir — don't treat it (or above) as a root
    // Machine-config space (incl. exact system-temp roots like /private/tmp) is
    // never a project root and nothing above it is this project — stop, so a
    // stray .traffic-one minted into a temp root can never be adopted.
    if (isMachineConfigRoot(current)) break;
    // Never resolve above the host's authoritative workspace root (Cursor's
    // workspace_roots): a dir OUTSIDE the opened workspace is not this project, even
    // with a stray onboarded .one.json. Without this an out-of-tree tool path (or a
    // stray ancestor) re-roots Traffic One to the parent → a second onboarding wizard.
    if (ceil && !isPathWithin(current, ceil)) break;
    // A mode-bearing .one.json INSIDE the plugin authoring repo is a stray, never
    // a project — skip it and keep walking so an enclosing real workspace (if
    // any) still resolves. The repo can therefore never be adopted as a project.
    const committed = committedProjectState(current);
    if (committed && !hasPluginAuthoringMarkers(current)) {
      // A Traffic One WORKSPACE PROJECT (mode: 'workspace') hands the walk back
      // DOWN to the member it registered, instead of adopting the container.
      // This is the whole of the P4 workspace change to resolution, and it is
      // unreachable on every project that exists today: `committed.mode` is one
      // of new-project / existing-codebase / existing-with-supabase everywhere,
      // and workspaceMemberRegistryOf returns `none` on its first comparison for
      // all three. No pattern is read, no file is opened, nothing is allocated —
      // the default path pays one string comparison against a value it is
      // already holding.
      //
      // It can only ever move the answer DOWNWARD, to a directory between this
      // root and `start` (inclusive of `start`, exclusive of this root — a
      // workspace is never its own member). A directory that resolved to ITSELF
      // still does, because the redirect is only reachable at an ANCESTOR level,
      // which the walk only reaches after declining to return the start. So it
      // cannot turn a kept `.traffic-one` into a deletion candidate under
      // shared/retention.ts's `resolveProjectRoot(dir) !== dir`; it can only
      // rescue one, which is the safe direction for that consumer.
      const registry = workspaceMemberRegistryOf(committed);
      const member = enclosingRegisteredMember(current, registry, start);
      if (member) return handDownToMember(member, current, containerRegistry(registry));
      // An onboarded root that is ITSELF a workspace root is the monorepo root —
      // the NEAREST such root wins, even when a farther ancestor also declares
      // workspaces (a project nested inside an unrelated umbrella repo must not
      // resolve to the umbrella — the tests/claude/3 digests-at-parent incident).
      const container = containerRegistry(registry);
      // …but a REGISTERED WORKSPACE MEMBER is not a leak and never was, so it is
      // ACCEPTED here, ahead of BOTH tests below. The redirect at the top of this
      // branch already answers for a member with no state of its own — the walk
      // climbs past it to the container and is handed back DOWN — and that is
      // precisely the member it cannot answer for: a member that IS onboarded
      // stops the walk at its own committed state, one level below the container,
      // and the exits below then return it with `container: ''`. The root was
      // right and the workspace facts were dropped, so `resolveToolScope`
      // reported `workspace.kind: 'none'` for a real member and the member fence
      // — the thing that stops a sibling write and names the member in the
      // claim-debug row — could not engage for the population it exists for.
      //
      // AHEAD OF THE DECLARATION EXIT, not merely ahead of the leak test, and
      // that ordering is the whole of the polyglot case. A workspace registering
      // `frontend` (a pnpm/npm monorepo in its own right) and `backend` (a Go
      // module) is the motivating shape, and `frontend` returns at
      // `dirDeclaresWorkspace(current)` with `container: ''`. MEASURED on that
      // fixture with this clause placed after that exit: `backend` resolved
      // `workspace.kind: 'member'` while `frontend` resolved `'none'`, so the
      // SAME two-member spanning call flipped on target order alone — refused
      // with `backend` last, allowed with `frontend` last — and every claim-debug
      // row anchored to `frontend` omitted `workspaceMember`. Ordering costs a
      // declaring member one `workspaceMembershipOf` walk it did not pay before,
      // and only when the pre-scan says an ancestor holds state at all.
      //
      // NEVER FOR A CONTAINER, which is the `!container` guard and not a detail.
      // `blockingCommittedMode` returns '' for a directory whose only mode is
      // `workspace`, so registering members inside a directory that is ITSELF a
      // registered member is permitted, and flow.ts's container onboarding
      // carries a `depth` parameter precisely because that nesting is
      // anticipated. Without the guard such a container is reported with the
      // OUTER container and the outer's registry, `workspaceAnchoring` finds it
      // in the outer's member list, and the fence reports `kind: 'member'` for a
      // workspace root — MEASURED as `unresolved`/refused before and
      // `member`/allowed after. That is the invariant this clause exists to
      // strengthen ("No gate may operate on a workspace root", tool-scope.ts)
      // failing at the one place that is hardest to notice, and it would let
      // every gate mint a plan, run state and role claims at a container, which
      // is exactly the state writeWorkspaceMemberRegistry refuses to create on
      // purpose. The guard is one comparison on a value already in hand.
      //
      // NEVER OVER A DEEPER MEMBER either, which is `deeperMemberEncloses` and
      // is the second guard rather than a variation on the first. `!container`
      // asks what THIS directory is; that one asks whether accepting it would
      // answer for a directory the registry gave to somebody else. See its own
      // note for the overlapping-entry shape it exists for.
      //
      // AN ACCEPTANCE, NOT A DECLARATION. The tempting alternative — teaching the
      // container to declare a workspace — is the catastrophic one: it makes
      // `nearestWorkspaceRoot(dirname(member))` non-null, so the leak test below
      // fails for EVERY member, the walk climbs past all of them,
      // `isLeakedNestedRoot` reports each one, and the next SessionStart sweep
      // deletes their state. This clause moves in the opposite direction by
      // construction: it can only ever return `current` itself, which is the
      // answer that makes retention's `resolveProjectRoot(dir) !== dir` say KEEP.
      //
      // WHAT REVERTING THIS CLAUSE COSTS, re-measured — and the answer is no
      // longer "nothing but `container`". It was, and the paragraph that said so
      // was true when it was written; the `indeterminate` disjunct above
      // falsified it, and a paragraph whose whole job is to license a future
      // deletion of this clause is the last place a stale claim may sit.
      //
      // The probe is 21 shapes (nested containers, a member that declares
      // package-manager workspaces, stray state inside a member, a registry entry
      // naming no real directory, an opaque and an illegible container registry,
      // an illegible ORDINARY ancestor with and without a stray beneath it, a
      // symlinked member, a member with no project marker, a member two levels
      // below its container, a ceiling cutting the container off, overlapping
      // entries, an opted-out member holding state, the packages/ui and
      // mercury/strategies leaks), each driven with this clause present and with
      // it absent, comparing the retention leaked-root action list and every
      // state-bearing directory's resolved root and container. Three things move:
      //
      //   1. `container`/`registry` on twelve shapes — `''`/null without the
      //      clause, the registering container with it. The point of the clause,
      //      and the only thing the old paragraph named.
      //   2. THE LEAKED-ROOT ACTION LIST, on the illegible-ancestor shape. A
      //      stray nested root under a git-merge-conflicted `.one.json` is
      //      `["repo/strategies/.traffic-one"]` without the clause and `[]` with
      //      it, and the stray's own root moves `repo` → `repo/strategies`. The
      //      LEGIBLE twin of that shape reports the leak in both builds, which is
      //      what makes it the disjunct and not the fixture.
      //   3. `root`, on the overlapping-entry shape: a directory inside a deeper
      //      registered member that is not itself onboarded resolves to `apps`
      //      without the clause and to `apps/web` with it (`deeperRegisteredMember`).
      //      It holds no state, so no sweep evaluates it — see that function's
      //      own note for why that is the whole of the moved population.
      //
      // So `root` moves for two populations and the deletion list moves for one,
      // and REVERTING ONLY THE `indeterminate` DISJUNCT is the change that moves
      // the deletion list. The clause is no longer free to delete, and the
      // sentence three lines above it — that the acceptance can only ever return
      // `current`, the answer retention reads as KEEP — remains true and is now
      // the reason the movement is in the safe direction rather than a claim that
      // there is none.
      if (!container) {
        const membership = anyAncestorHoldsState(current, ceil)
          ? workspaceMembershipOf(current, { ceiling: ceil })
          : { kind: 'not-member' as const };
        // VOUCHED BUT NOT A MEMBER — the second arm below — is a registry that
        // reaches this exact directory without naming it (a symlinked entry), or
        // that could not tell us whether it does (a transient `statSync`
        // failure). The two axes want opposite answers, and this is where they
        // are both given one:
        //
        //   DELETION. `root` is `current`, so retention's
        //   `resolveProjectRoot(dir) !== dir` says KEEP and the SessionStart
        //   sweep leaves the directory's `.one.json` alone. That matters most for
        //   the transient failure: a member matched only by identity whose stat
        //   blips — EACCES, EIO, a network mount, an antivirus hold — would
        //   otherwise become a leaked nested root and LOSE ITS STATE, which is
        //   data loss triggered by an error that says nothing about the
        //   directory. "We could not tell" is not evidence of a leak.
        //
        //   AUTHORITY. The container is reported and the registry with it, so
        //   `resolveToolScope` engages the fence, `enclosingRegisteredMember`
        //   declines the directory, and the call is REFUSED as unresolved. No
        //   plan, no run state and no role claim can be minted there. A ghost
        //   entry pointed at an unnamed directory therefore launders nothing,
        //   and it needs no privilege to try: nothing has to be overwritten.
        //
        // The hand-down is shared with the member arm rather than written twice:
        // a vouched directory is not a member, so a deeper member the registry
        // DOES name still owns everything inside it, exactly as it does under a
        // member that is only the second-deepest match.
        //
        // AND `indeterminate` IS HERE FOR THE DELETION HALF OF THE SAME
        // ARGUMENT, one level up. That verdict is an ancestor whose registry
        // could not be ENUMERATED, so the walk never asked about this
        // directory — and until it was read here, falling through meant
        // climbing to it, which is the answer retention reads as "a leaked
        // nested root" and the sweep acts on. MEASURED with the container
        // registering `api`, `api` onboarded and owning no project marker: a
        // malformed second entry, a non-string entry, an id collision, a
        // non-array registry key and a corrupt container state file each took
        // `api/.traffic-one`, on a member the registry named correctly.
        // `stat`-level indeterminacy was closed by the identity union and
        // registry-level indeterminacy was not, which left the fix covering the
        // rarer half of one hazard.
        //
        // ── THE POPULATION IS WIDER THAN "A CONTAINER", AND SAYING OTHERWISE
        // WAS THE UNDERSTATEMENT THAT HID THE REST ─────────────────────────────
        //
        // The registry reader classifies ILLEGIBILITY before it ever looks at the
        // mode — corrupt and unreadable bytes answer `illegible`, and so does a
        // file that parses to something other than a RECORD (see
        // memberRegistryOfContainer, the third shape and the one that was
        // licensing a deletion) — so `workspaceMembershipOf` answers
        // `indeterminate` for ANY ancestor whose `.one.json` cannot be read as a
        // state record, workspace or not. An ordinary project with a git-merge-
        // conflicted state file is therefore in this population, and a merge
        // conflict is the exact routine trigger the nested-retention item names.
        // MEASURED on an ordinary git project with a stray nested root: a legible
        // parent reports the leak, a conflicted parent reports none, and
        // reverting this disjunct restores the report. So the DEFAULT PATH
        // demonstrably changed, which the workspace-members test header used to
        // deny; it says so now.
        //
        // KEPT WIDE ON THE DELETION AXIS, and the reason is that the only
        // available narrowing is the data-loss direction. "Only registries that
        // actually declare a workspace" is unaskable of bytes that do not
        // parse — the mode is inside them — so narrowing here means resuming the
        // sweep under an ancestor nobody could read, which is the confident
        // negative this module refuses everywhere else. The cost is the honest
        // one and it is bounded: while an ancestor's state file is unparseable a
        // GENUINE leak beneath it is kept instead of healed, the state is kept
        // rather than lost, and the sweep heals on the first parse.
        //
        // NARROWED ON THE AUTHORITY AXIS, because there the wide answer is not
        // safe. Reporting a container makes `resolveToolScope` engage the member
        // fence, and an `illegible` registry resolves NO member, so every gated
        // call under that ancestor is refused as `workspace-member-unresolved` —
        // which for a real workspace is the invariant ("no gate may operate on a
        // root the registry cannot vouch for") and for an ordinary project under
        // an ordinary conflicted parent is a freeze with nothing on the other
        // side of it: that project is nobody's member and the ancestor is not a
        // workspace. `opaque` keeps reporting the container, because it PARSED
        // and it said `mode: 'workspace'` — that ancestor is demonstrably a
        // container with an unusable registry, and refusing its members is the
        // invariant working. `illegible` withholds the deletion and withholds
        // the container: `root` is identical on both arms, so retention's
        // `resolveProjectRoot(dir) !== dir` is unaffected either way.
        //
        // `deeperRegisteredMember` is reached on this arm too and answers null
        // by construction — `enclosingRegisteredMember` grants nothing on a
        // registry that is not `members` — so the shared call needs no guard.
        if (membership.kind === 'member'
          || membership.kind === 'vouched-not-member'
          || membership.kind === 'indeterminate') {
          const deeper = deeperRegisteredMember(membership, current, start);
          if (deeper) return handDownToMember(deeper, membership.workspaceRoot, membership.registry);
          return membership.kind === 'indeterminate' && membership.registry.kind === 'illegible'
            ? { root: current, container: '', registry: null }
            : { root: current, container: membership.workspaceRoot, registry: membership.registry };
        }
      }
      if (dirDeclaresWorkspace(current)) return { root: current, container: container ? current : '', registry: container };
      // …and a mode-bearing .one.json BELOW a workspace root is a leak, not a
      // project root: a monorepo has ONE root (the workspace), so a stray
      // packages/*/.traffic-one (the packages/ui incident) must not shadow it.
      // Keep climbing to the workspace root instead of adopting the sub-package.
      //
      // The same reasoning by MEMBERSHIP, which is what catches non-npm trees: state
      // sitting in a dir that owns no project while a real project encloses it is a
      // leak too (observed: mercury/strategies and agora/handlers/strategies each
      // accrued a full new-project state inside a Go repo). Climbing past it both
      // fixes resolution AND makes isLeakedNestedRoot report it, so the SessionStart
      // retention sweep heals it — no migration needed. A dir that owns a marker is
      // always its own root, so a real repo can never become a cleanup candidate.
      //
      // Under `membership` authority the workspace half of this test additionally
      // requires the ancestor's declaration to CLAIM `current`; the membership half
      // is untouched, so stray state inside a real repo (mercury/strategies) still
      // climbs past and still heals.
      if (nearestWorkspaceRoot(path.dirname(current), ceiling, authority === 'membership' ? current : '') === null
        && (dirOwnsProject(current)
          || projectMembershipRoot(path.dirname(current), ceiling) === null)) {
        return { root: current, container: container ? current : '', registry: container };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
  return null;
}

/**
 * The files that DECLARE members, in every ecosystem this resolver understands
 * them for. `settings.gradle(.kts)` is Gradle's spelling of npm's `workspaces`
 * glob: it is the file Gradle itself walks up to in order to find the build,
 * and its contents are a list of the modules that build contains.
 *
 * It used to be in project-membership.ts `MANIFEST_MARKERS` instead, which is
 * the exact inversion — "these are my members" registered as "I am a project" —
 * and the inversion was visible in the answers. MEASURED on two identical
 * layouts, a root declaration plus one submodule carrying its own build file:
 *
 *                                          npm            Gradle (before)
 *   resolveProjectRoot(cwd=member)         workspace root modules/api
 *   isUnclaimedWorkspaceSubPackage(member) true           false
 *
 * With the name moved here the two rows agree, which is the point: the Gradle
 * submodule is anchored at the root it belongs to and is protected by the same
 * write-side backstop as a `packages/*` sub-package. It still OWNS a project
 * through `build.gradle(.kts)`, so a submodule that is a genuine member of a
 * Traffic One workspace can still hold state.
 *
 * THE DEFINITION LIVES IN hook/workspace-declaration.ts and is re-exported here
 * under the name every caller already knows. It moved because it grew a second
 * consumer outside this module — state/normalize.ts's state-write veto, which
 * has to permit a declaration-only container to hold its own state — and
 * normalize.ts cannot import this file (paths → ../state → normalize is a
 * cycle). Keeping the filename list in one place is the point of the move: see
 * that module's header for why a veto and a resolver disagreeing about what a
 * declaration is reproduces this same defect from the other side.
 */
export { dirDeclaresWorkspace } from './workspace-declaration';

// Nearest ancestor-or-self (within the bounded walk, never above $HOME) that is a
// workspace root. Used as the project-root anchor when no ONBOARDED root exists
// yet — e.g. mid-onboarding, before the workspace root has committed `mode`.
function nearestWorkspaceRoot(startDir: string, ceiling?: string, claimant = ''): string | null {
  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → MAX_ROOT_WALK-capped */ }
  const ceil = ceiling ? path.resolve(ceiling) : '';
  let current = path.resolve(startDir);
  for (let i = 0; i < MAX_ROOT_WALK; i += 1) {
    if (home && current === home) break;
    if (isMachineConfigRoot(current)) break; // temp/config roots never anchor a workspace
    if (ceil && !isPathWithin(current, ceil)) break; // never anchor above the host workspace root
    if (dirAnchorsWorkspaceFor(current, claimant) && !hasPluginAuthoringMarkers(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// True when `cwd` is a monorepo sub-package with NO Traffic One state of its own
// that sits inside a workspace root — so it must never be materialized as its own
// project. The write-side backstop for the resolveProjectRoot anchor below
// (detectMode labels any sparse dir 'new-project', so an un-guarded converge would
// mint a stray shallow .traffic-one/.one.json into packages/* during a build).
export function isUnclaimedWorkspaceSubPackage(cwd: string): boolean {
  const dir = path.resolve(cwd);
  if (hasStateFile(dir)) return false;                      // owns state → a real root, leave it
  return nearestWorkspaceRoot(path.dirname(dir)) !== null;  // an ANCESTOR is a workspace root
}

/**
 * Whether a directory is a VALIDATED MEMBER of an enclosing Traffic One
 * workspace — and, when the answer is no, whether that is a finding or an
 * inability.
 *
 * `not-member` is a positive fact: every ancestor up to the stopping point was
 * legible and none of them registered this directory. `indeterminate` means the
 * walk passed a `.traffic-one/.one.json` it could not read or could not parse,
 * or a workspace whose registry held a malformed entry, and therefore never
 * established the answer. Folding those together is the single defect shape
 * this codebase has closed some twenty times, so they are separate here and the
 * boolean below is the place the fold is made, deliberately and in one line.
 *
 * NEAREST WINS, matching nearestOnboardedRoot's own rule for a monorepo root: the
 * first workspace root the walk meets owns the question. A workspace that
 * registers somebody else is a `not-member` answer, not a reason to keep looking
 * for a farther workspace that might say otherwise — and an ILLEGIBLE ancestor
 * stops the walk for the same reason, because a farther claim would be overruled
 * by whatever that unreadable file says.
 *
 * EXACT, unlike the redirect inside nearestOnboardedRoot, which is
 * ancestor-or-self. The resolver is asked "which project owns this file" and a
 * nested source directory must answer with its member; this is asked "is THIS
 * directory a member", and `<member>/internal` is not one. The two share
 * `enclosingRegisteredMember` and differ only in comparing its result back
 * against the input.
 *
 * PURE: a bounded sequence of reads, no lock and no write anywhere in the body,
 * so it may be asked from inside a lock body. Same contract, and the same
 * reason, as state/run-agent/ledger.ts runLedgerClaimAdmission.
 */
export type WorkspaceMembershipVerdict =
  | {
      readonly kind: 'member';
      readonly workspaceRoot: string;
      readonly memberRoot: string;
      /**
       * The registry that granted the membership — carried rather than left to
       * the caller to re-read, for the same reason `committedProjectState`
       * hands back its record: the walk opened that file to answer this
       * question and would otherwise throw the answer away. The resolution walk
       * is the consumer that cannot afford the second read.
       */
      readonly registry: WorkspaceContainerRegistry;
    }
  /**
   * A registry we COULD read reaches this exact directory, but not by naming it
   * — or could not settle the question at all. Standing on the DELETION axis
   * only: see `registryEnclosureOf`'s `vouched` and `indeterminate` arms, which
   * this arm carries both of.
   *
   * A FOURTH ARM RATHER THAN A FLAG ON `member`, because every consumer that
   * grants something reads `kind === 'member'` and must keep granting nothing
   * here. The one consumer that reads this arm is the resolution walk, and what
   * it does with it is withhold a deletion (keep the directory as its own root)
   * while still refusing it a member's authority (report the container, so the
   * fence engages and no gate operates on it).
   *
   * NOT folded into `indeterminate`, which stays what it was: a container whose
   * registry could not be READ at all. That verdict predates this arm and names
   * a different fact — this one is about THIS directory, that one is about the
   * container's file. Both withhold a deletion (see below); only this one can
   * say why in terms of the directory it was asked about.
   */
  | {
      readonly kind: 'vouched-not-member';
      readonly workspaceRoot: string;
      readonly registry: WorkspaceContainerRegistry;
      readonly why: string;
    }
  | { readonly kind: 'not-member' }
  /**
   * The walk met a container whose registry could not be ENUMERATED — the
   * `.one.json` is torn or unreadable, or it parses and holds a malformed
   * entry — so no question about any directory under it was ever answered.
   *
   * IT CARRIES THE CONTAINER, which it did not until the deletion axis was
   * measured against it. "Says nothing about this directory in particular" was
   * offered as the reason to keep it apart from `vouched-not-member`, and it is
   * exactly the reason it must not be read as a finding: the arm is an
   * INABILITY. The consumer that reads a non-member answer as licence to sweep
   * — `nearestOnboardedRoot`'s acceptance clause, through
   * `resolveProjectRoot(dir) !== dir` — was therefore taking a registered
   * member's state on the strength of a file nobody could read. MEASURED with
   * the container registering `api`, `api` onboarded and owning no project
   * marker: a malformed second entry beside the good one, a non-string entry,
   * two entries colliding on one id, a non-array `workspaceMembers`, and a
   * corrupt container state file each deleted `api/.traffic-one`. All five are
   * bytes an agent's Write tool produces.
   *
   * The container and its registry are what let that consumer withhold the
   * deletion AND still engage the fence, which is the same pair of answers the
   * arm above needs, for a different reason. `kind` stays the discriminator
   * every granting consumer reads, so nothing gains authority here.
   */
  | {
      readonly kind: 'indeterminate';
      readonly why: string;
      readonly workspaceRoot: string;
      readonly registry: WorkspaceContainerRegistry;
    };

/**
 * `readWorkspaceMemberRegistry` with the one arm the deletion axis cannot read as
 * a finding: a `.one.json` that PARSES BUT IS NOT A RECORD.
 *
 * `workspaceMemberRegistryOf` folds a non-record to `none` on its first line, and
 * `none` is a POSITIVE negative everywhere downstream — "this ancestor is legible
 * and it is not a workspace". For `"hello"`, `7` or `[1,2]` that is not what
 * happened: the bytes parsed and then said nothing about a mode, a registry, or
 * any member. Everything a registry could have vouched for is unestablished,
 * which is `illegible`'s meaning exactly.
 *
 * The cost of the fold was a DELETION, one level up. A legible nested member
 * under such a container reached the acceptance clause with `not-member`, fell
 * through, resolved to the container, and `shared/retention.ts`'s
 * `resolveProjectRoot(dir) !== dir` therefore read it as a leaked nested root and
 * swept its state — while the same member under a git-merge-CONFLICTED container
 * was correctly kept, because unparseable bytes already answer `illegible`. Two
 * shapes of the same inability, one of them licensing a deletion: the syntactic-
 * versus-semantic asymmetry retention's own isLeakedNestedRoot fixed on its side
 * and this side did not. Both shapes are bytes an agent's Write tool produces.
 *
 * ONE READ on the hot path, which is why this is not a check bolted after the
 * call: an `ok` read is classified here and an absent one answers `none` the same
 * way the delegate would. Only `corrupt` and `unreadable` read twice, and only so
 * the `why` string for each errno keeps living in one place.
 */
function memberRegistryOfContainer(dir: string): WorkspaceMemberRegistry {
  const read = readJsonResult<Rec>(path.join(dir, STATE_FILE));
  if (read.kind === 'absent') return { kind: 'none' };
  if (read.kind !== 'ok') return readWorkspaceMemberRegistry(dir);
  const record = obj(read.value);
  if (!record) return { kind: 'illegible', why: `${STATE_FILE} parses but is not a JSON object` };
  return workspaceMemberRegistryOf(record);
}

export function workspaceMembershipOf(dir: string, opts: { ceiling?: string } = {}): WorkspaceMembershipVerdict {
  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → MAX_ROOT_WALK-capped */ }
  const ceil = opts.ceiling ? path.resolve(opts.ceiling) : '';
  const target = path.resolve(dir);
  // Start at the PARENT: a workspace root is never its own member, so reading
  // the target's own state could only ever cost a syscall to learn nothing.
  let current = path.dirname(target);
  for (let i = 0; i < MAX_ROOT_WALK; i += 1) {
    if (home && current === home) break;
    if (isMachineConfigRoot(current)) break;
    if (ceil && !isPathWithin(current, ceil)) break;
    if (!hasPluginAuthoringMarkers(current)) {
      const registry = memberRegistryOfContainer(current);
      if (registry.kind === 'illegible' || registry.kind === 'opaque') {
        return { kind: 'indeterminate', why: `${current}: ${registry.why}`, workspaceRoot: current, registry };
      }
      if (registry.kind === 'members') {
        // The EXACT query, not the ancestor-or-self walk narrowed afterwards by
        // a string comparison. The two agree on the `member` arm by
        // construction — the deepest member enclosing `target` can only BE
        // `target` when `target` matches at its own depth — and the exact one
        // additionally answers the two arms a boolean could not carry: a
        // directory the registry reaches without naming it, and a directory
        // whose identity we could not establish. It is also strictly cheaper,
        // because it examines one depth instead of the whole ancestor chain.
        const enclosure = registryEnclosureOf(current, registry, target);
        if (enclosure.kind === 'member') {
          return { kind: 'member', workspaceRoot: current, memberRoot: enclosure.member, registry };
        }
        if (enclosure.kind === 'vouched' || enclosure.kind === 'indeterminate') {
          return { kind: 'vouched-not-member', workspaceRoot: current, registry, why: enclosure.why };
        }
        return { kind: 'not-member' };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { kind: 'not-member' };
}

/**
 * `workspaceMembershipOf` narrowed to the one arm that GRANTS something.
 *
 * `indeterminate` folds to false, and the fold is the whole reason the three
 * values exist above it. This boolean's consumers are the ones that would treat
 * `true` as authority — the workspace-gate item next wave reads it to decide
 * whether a member may be treated as its own project — and authority derived
 * from a file nobody could read is not authority. A caller that needs to tell
 * "no" from "could not tell", so it can say so rather than deny silently, must
 * ask for the verdict instead.
 */
export function isRegisteredWorkspaceMember(dir: string, opts: { ceiling?: string } = {}): boolean {
  return workspaceMembershipOf(dir, opts).kind === 'member';
}

// Re-exported so the resolver stays the single import surface for root
// questions (see the dirOwnsProject/projectMembershipRoot re-export at the top),
// and so a caller never has to know that the registry reader is a separate leaf.
export { WORKSPACE_PROJECT_MODE, readWorkspaceMemberRegistry } from './workspace-members';
export type { WorkspaceMemberRegistry } from './workspace-members';

// Resolve the effective Traffic One project root for a hook operating at `cwd` on
// an optional target `filePath`. Walks UP from the target file's dir (then from
// `cwd`) — deliberately NOT bounded by `cwd` (but capped by `opts.ceiling` when the
// host supplies an authoritative workspace root; see below) — to the nearest
// ancestor that is a real onboarded root, so a monorepo sub-package (`apps/web`,
// `packages/*`)
// resolves to the workspace root that holds the onboarding/lifecycle state rather
// than tripping a bogus per-package wizard or hiding maintenance phase. When no
// onboarded ancestor exists yet — e.g. mid-onboarding, before the workspace root
// has committed `mode` — anchor at the enclosing WORKSPACE root if one exists, so
// every writer (gate, server, once-markers, convergence) targets the workspace
// instead of minting a stray shallow .traffic-one into the sub-package. Falls back
// to the legacy cwd-bounded nearest-any-state-file resolution (then `cwd`) for a
// standalone project with no workspace ancestor, so its gating is unchanged.
//
// `opts.ceiling` is the host's AUTHORITATIVE workspace root (Cursor's
// workspace_roots): resolution never climbs above it. This is what keeps a hook
// that touches a path ABOVE the opened workspace — or a stray onboarded ancestor —
// from re-rooting Traffic One to the parent (the Cursor double-onboarding incident).
// Hosts that declare no workspace boundary (Claude/Codex) leave it unset, so the
// monorepo sub-package climb is unchanged.
//
// SPELLING-PRESERVING, and that is a CONTRACT, not an omission. There is no
// `realpathSync` anywhere in this file: every exit — the onboarded walk, the
// workspace anchor, all three ceiling exits below, the membership fallback and
// the legacy cwd fallback — returns an `path.resolve`d value in the caller's own
// spelling. `/tmp/proj` comes back `/tmp/proj`; shared/paths.ts's projectRoot()
// canonicalizes and would answer `/private/tmp/proj` for the same directory.
//
// Do not "align" the two. The result of THIS function is compared BY STRING
// against its own input: shared/retention.ts isLeakedNestedRoot deletes a nested
// `.traffic-one/` when `resolveProjectRoot(dir) !== dir`. Canonicalize any exit
// and every genuine, independently onboarded project reached through a
// non-canonical cwd (a symlinked checkout, a `/tmp` path on macOS, an
// `/etc/auto_home` home) stops equalling its own directory and becomes a
// DELETION candidate. The ceiling exits are the same rule: `opts.ceiling` is the
// host's own spelling of the workspace root and is handed straight back.
//
// The residual cost is in-process cache misses when one process reaches one
// project by two spellings — see the long note above projectRoot() in
// shared/paths.ts for why that is bounded, and
// shared/__tests__/path-spelling-contract.test.ts for the pins.
export function resolveProjectRoot(
  cwd: string,
  filePath?: unknown,
  opts: { ceiling?: string; workspaceAuthority?: WorkspaceAuthority } = {},
): string {
  return resolveProjectRootDetailed(cwd, filePath, opts).root;
}

/**
 * What `resolveProjectRoot` resolved, plus whether the answer is a WORKSPACE
 * CONTAINER rather than a project — and, when it is, the member registry the
 * resolution walk already read out of that root's `.one.json`.
 *
 * Split out for exactly the reason `committedProjectState` was: the walk has
 * the answer in hand and used to drop it, so a caller that needed it had to
 * re-open the same file. `resolveProjectRoot` is 200-odd call sites and stays a
 * `string`; this is the one extra fact the gate fence needs
 * (shared/tool-scope.ts workspaceMemberRefusal), delivered for ZERO additional
 * syscalls on every input, workspace or not.
 *
 * `workspaceRegistry` is non-null ONLY on the exits that read a committed
 * `mode`, which is the complete set of exits that can return a container: a
 * workspace root carries `mode: 'workspace'`, so it IS an onboarded root, so
 * nearestOnboardedRoot reaches it whenever the walk passes it, and the ceiling
 * exit below is the only other reader of a committed mode. The remaining exits
 * (the workspace-DECLARATION anchor, projectMembershipRoot, the legacy cwd
 * fallback) are reached only after nearestOnboardedRoot declined, and the
 * declaration anchor additionally requires a package-manager declaration, which
 * nearestOnboardedRoot returns on directly. The residue is one doubly-nested
 * pathology — a container with no package-manager declaration, owning no
 * project marker, itself sitting inside another declared workspace — which
 * reports null and therefore behaves exactly as it does today. Nothing writes
 * this mode yet, so that residue has no live population; it is recorded rather
 * than papered over.
 */
export interface ProjectRootResolution {
  readonly root: string;
  /** The workspace container the walk met, '' when none. Non-empty iff `workspaceRegistry` is. */
  readonly workspaceContainer: string;
  readonly workspaceRegistry: WorkspaceContainerRegistry | null;
}

const NO_WORKSPACE_CONTAINER = { workspaceContainer: '', workspaceRegistry: null } as const;

export function resolveProjectRootDetailed(
  cwd: string,
  filePath?: unknown,
  opts: { ceiling?: string; workspaceAuthority?: WorkspaceAuthority } = {},
): ProjectRootResolution {
  const ceiling = opts.ceiling ? path.resolve(opts.ceiling) : '';
  const authority = opts.workspaceAuthority ?? 'declared';
  // Relative targets still resolve against the REAL cwd; only the walk anchors
  // are lifted out of a drifted `.traffic-one/**` cwd (see stripStateDirSuffix).
  const cwdStart = stripStateDirSuffix(cwd);
  const normalized = normalizeHookTargetPath(cwd, filePath);
  const fileAbs = normalized
    ? (path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized))
    : '';
  let fileStart = fileAbs ? stripStateDirSuffix(path.dirname(fileAbs)) : '';
  // A target file OUTSIDE the authoritative workspace root is out-of-tree — never
  // let it re-root resolution to an ancestor. Drop the file hint and resolve from
  // cwd within the workspace.
  if (ceiling && fileStart && !isPathWithin(fileStart, ceiling)) fileStart = '';
  const claimant = (start: string): string => (authority === 'membership' ? start : '');
  const onboarded = (fileStart && nearestOnboardedRoot(fileStart, ceiling, authority))
    || nearestOnboardedRoot(cwdStart, ceiling, authority);
  if (onboarded) {
    return { root: onboarded.root, workspaceContainer: onboarded.container, workspaceRegistry: onboarded.registry };
  }
  const workspace = (fileStart && nearestWorkspaceRoot(fileStart, ceiling, claimant(fileStart)))
    || nearestWorkspaceRoot(cwdStart, ceiling, claimant(cwdStart));
  if (workspace) return { root: workspace, ...NO_WORKSPACE_CONTAINER };
  // Cursor can run a subagent shell with cwd under its internal metadata tree
  // (for example ~/.cursor/.../terminals), outside workspace_roots. The ceiling
  // bounded walks above correctly refuse to climb from that cwd, but falling back
  // to cwd would make Traffic One think this out-of-tree dir is a fresh project.
  if (ceiling && !isPathWithin(path.resolve(cwdStart), ceiling)) {
    // `committedProjectState` rather than `isOnboardedProjectRoot`, which IS
    // that call plus a `!== null`: the same single read now also answers
    // whether the ceiling we are about to adopt is a container.
    const ceilingState = committedProjectState(ceiling);
    if (ceilingState) {
      const ceilingRegistry = containerRegistry(workspaceMemberRegistryOf(ceilingState));
      return { root: ceiling, workspaceContainer: ceilingRegistry ? ceiling : '', workspaceRegistry: ceilingRegistry };
    }
    const workspaceAtCeiling = nearestWorkspaceRoot(ceiling, ceiling, claimant(ceiling));
    if (workspaceAtCeiling) return { root: workspaceAtCeiling, ...NO_WORKSPACE_CONTAINER };
    return { root: ceiling, ...NO_WORKSPACE_CONTAINER };
  }
  // Nothing is onboarded and no workspace is declared — so ask which project this
  // directory BELONGS to. Without this the fallback below returns `cwd` verbatim,
  // which is how a Go PACKAGE became its own project (observed: mercury/strategies
  // and agora/handlers/strategies each got a full new-project wizard, because
  // detectMode counts files in the resolved root and a small package reads as
  // `new-project`). Deliberately AFTER the workspace anchor: a monorepo sub-package
  // owns a package.json of its own, so running this first would make it a root and
  // defeat the packages/* leak rule.
  const member = (fileStart && projectMembershipRoot(fileStart, ceiling))
    || projectMembershipRoot(cwdStart, ceiling);
  if (member) return { root: member, ...NO_WORKSPACE_CONTAINER };
  return { root: findProjectRootForHookFile(cwdStart, fileAbs || filePath), ...NO_WORKSPACE_CONTAINER };
}

export function projectRelativeHookPath(cwd: string, projectRoot: string, filePath: unknown): string {
  const normalized = normalizeHookTargetPath(cwd, filePath);
  if (!normalized) return '';
  const absPath = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
  const relative = path.relative(projectRoot, absPath).replace(/\\/g, '/');
  if (relative && !relative.startsWith('..') && relative !== '.') return relative;
  return normalized;
}

export function packageJsonDeclaresWorkspace(content: string): boolean {
  if (!content || !content.trim()) return true;
  try {
    const pkg = JSON.parse(content);
    const workspaces = pkg && pkg.workspaces;
    const hasWorkspaces = Array.isArray(workspaces) || Boolean(workspaces && Array.isArray(workspaces.packages));
    const hasPnpmPackageManager = typeof pkg.packageManager === 'string' && /^pnpm@\d/.test(pkg.packageManager);
    return pkg.private === true && hasWorkspaces && hasPnpmPackageManager;
  } catch {
    return true;
  }
}
