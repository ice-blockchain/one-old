// src/shared/hook/paths.ts
// Project-root resolution from a hook tool's file path + new-project monorepo
// predicates. Ported 1:1 from scripts/hook-runtime/handlers/_helpers.cjs.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { STATE_DIR, STATE_FILE } from '../../config/paths';
import { hasPluginAuthoringMarkers, isMachineConfigRoot } from '../authoring-root';
import { readJson, readJsonResult } from '../fsjson';
import { dirOwnsProject, projectMembershipRoot } from '../project-membership';
import { isNativeState } from '../state';
import { hasStateFile } from '../tool-classify';
import { workspaceClaimsDescendant } from './workspace-declaration';
import {
  WORKSPACE_PROJECT_MODE,
  type WorkspaceMemberRegistry,
  enclosingRegisteredMember,
  readWorkspaceMemberRegistry,
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
      if (member) return { root: member, container: current, registry: containerRegistry(registry) };
      // An onboarded root that is ITSELF a workspace root is the monorepo root —
      // the NEAREST such root wins, even when a farther ancestor also declares
      // workspaces (a project nested inside an unrelated umbrella repo must not
      // resolve to the umbrella — the tests/claude/3 digests-at-parent incident).
      const container = containerRegistry(registry);
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

// A directory is a WORKSPACE ROOT when it declares workspaces — npm/yarn/bun
// `workspaces` in package.json, or a pnpm-workspace.yaml. Lenient by design: the
// cost of a false positive is resolving up one level; the cost of a miss is a
// stray .traffic-one minted into a sub-package (see resolveProjectRoot below).
//
// It never reads the declared PATTERNS, and under `declared` authority it still
// does not — this is the resolution hot path and it stays at two existsSync
// calls plus one readJson. The pattern read lives in hook/workspace-declaration.ts
// and is reached only through `membership` authority, so a directory that claims
// nothing still anchors resolution exactly as it always has. The invariant that
// binds the two — a declaration that CLAIMS a descendant is always a declaration
// — is pinned in ../__tests__/workspace-declaration.test.ts rather than assumed.
function dirDeclaresWorkspace(dir: string): boolean {
  if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) || fs.existsSync(path.join(dir, 'pnpm-workspace.yml'))) {
    return true;
  }
  const pkg = readJson<Rec>(path.join(dir, 'package.json'), {} as Rec);
  const ws = pkg ? (pkg as Rec).workspaces : undefined;
  if (Array.isArray(ws)) return ws.length > 0;
  if (ws && typeof ws === 'object') return Array.isArray((ws as Rec).packages);
  return false;
}

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
  | { readonly kind: 'member'; readonly workspaceRoot: string; readonly memberRoot: string }
  | { readonly kind: 'not-member' }
  | { readonly kind: 'indeterminate'; readonly why: string };

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
      const registry = readWorkspaceMemberRegistry(current);
      if (registry.kind === 'illegible' || registry.kind === 'opaque') {
        return { kind: 'indeterminate', why: `${current}: ${registry.why}` };
      }
      if (registry.kind === 'members') {
        const member = enclosingRegisteredMember(current, registry, target);
        return member !== null && path.resolve(member) === target
          ? { kind: 'member', workspaceRoot: current, memberRoot: member }
          : { kind: 'not-member' };
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
