// src/shared/onboarding/workspace-inherit.ts
// The half of workspace onboarding that makes the wizard's "answer the shared
// steps once, at the container" promise TRUE rather than merely stated.
//
// WHY ANYTHING IS NEEDED AT ALL. The shared answers do not live in the
// container's committed `.one.json`; they live in the per-user preference
// bucket `~/.traffic-one/projects/<sha256(realpath(cwd))>/preferences.json`
// (state/local-prefs/prefs-store.ts). The bucket name is a hash of the
// DIRECTORY, so a member and its container are two unrelated buckets that share
// nothing — `readEffectiveState(<member>)` sees none of the container's
// answers. Measured on a two-member container whose root had answered the whole
// wizard: the member's bucket did not exist, its effective state carried no
// `performance`, no `team` and no `openCode`, `computeOnboarding(<member>)`
// returned step `open-code` (the wizard, from the top), and
// `buildRunModelPolicy(<member>, …)` returned null — `resolvedRunPolicyInputs`
// refuses to freeze a run policy without the member's OWN `performance.level`,
// so the member could never reach a runnable state no matter how the container
// was answered.
//
// WHAT IS AND IS NOT INHERITED, and the list is short because most of the
// wizard is already in the right place:
//
//   openCode  — a PROJECT_PREF_KEY, per directory. Inherited. It is also the
//               FIRST step `nextLocalPreferenceStep` returns, so without it a
//               member re-opens the wizard at question one.
//   hosts     — `hosts.<host>.performance` / `.team`, the HOST_PREF_KEYS. These
//               are what the run-policy freeze reads. Inherited whole, every
//               host the container has answered on, because "which host will
//               this member be opened in" is not knowable here.
//   the code-graph provider — NOT inherited, and needs no mechanism: it is
//               MACHINE-wide (`~/.traffic-one/one.json`, see
//               local-prefs/index.ts writeGlobalCodeGraphProvider), not a
//               per-project preference. Measured: the member's effective state
//               already carried `codeGraphProvider: 'gitnexus'` from the
//               container's answer, with nothing copied anywhere.
//   originalPrompt, toolchain, agentActivity, the graph-run timestamps — NOT
//               inherited. The prompt is the user's words about the CONTAINER
//               and is the one field deliberately kept out of committed state
//               for privacy; the toolchain stamps record what is installed for
//               a given project and the install task is idempotent, so a member
//               re-running it costs a fast no-op rather than a wrong answer.
//
// WRITE-TIME, NOT READ-TIME, and that is a cost decision worth stating because
// the other design reads better. Inheriting inside `readEffectiveState` would
// need a `workspaceMembershipOf` walk — N state-file reads — on EVERY effective
// -state read in the product, which is the per-call cost the resolution walk
// goes to some length to avoid (see the "zero additional syscalls" contract on
// resolveProjectRootDetailed). Propagating once per answer, and once per
// registration, costs nothing on any read path. The price is that the two write
// sites are the complete set: a shared answer at the container fans out here,
// and a member joining later is seeded here, so BOTH orders are covered.
//
// THE CONTAINER WINS for the inherited keys. In the workspace branch a member's
// wizard never OFFERS these steps, so the only way a member can hold its own
// value is from before it joined; once it is a member the container is the one
// place they are answered, and a re-pick at the container has to reach it.

import * as path from 'path';

import { type Rec } from '../obj';
import {
  readWorkspaceMemberRegistry,
  type WorkspaceMemberIdentity,
} from '../hook/workspace-members';
import { mergeProjectPrefs, readProjectPrefs } from '../state';

/**
 * The preference keys a member takes from its container.
 *
 * Named as a constant rather than inlined because the projection and the
 * VERIFICATION below must agree about the list — a copy that inherited three
 * keys and then checked two would report success over a dropped answer.
 */
export const WORKSPACE_INHERITED_PREF_KEYS = ['openCode', 'hosts'] as const;

/**
 * Keys a member is SEEDED with and then owns — copied only when the member has
 * recorded nothing of its own.
 *
 * `pluginUse` is the whole list, and it is separate from the keys above because
 * it is the only inherited value that can be a REFUSAL. The container-wins rule
 * is right for a preference (the container is where the question is asked, so a
 * re-pick there must reach the member); it is wrong for a "no". A member where
 * someone answered "don't use Traffic One here" has already had its artifacts
 * swept by `removeDeclinedProjectArtifacts`, and a later yes at the container
 * would silently reverse that person's answer and start writing into the
 * directory again. Same posture as the committed member opt-out: the enclosing
 * yes does not overrule the narrower no.
 *
 * Seeding it at all is what keeps `--set-tech --project=` working: consent is a
 * per-DIRECTORY pref, so without this a member registered from a container that
 * has already consented would answer `consent-missing` to
 * `applyAgentTechClassification` under ASK_USE_PLUGIN_FIRST — the person would
 * be asked to consent to a workspace they just consented to.
 */
export const WORKSPACE_SEEDED_PREF_KEYS = ['pluginUse'] as const;

/** What one member's seeding did. Never a boolean: two of the three are failures. */
export type MemberPrefsInheritance =
  | { readonly outcome: 'inherited'; readonly member: string; readonly keys: readonly string[] }
  /** The container has answered none of the shared steps yet — nothing to copy. */
  | { readonly outcome: 'nothing-to-inherit'; readonly member: string }
  /**
   * The merge ran and the values are NOT on disk afterwards. Reported, never
   * swallowed: `updateProjectPrefs` declines to CREATE a bucket for a directory
   * that owns no manifest inside an enclosing repository, and it declines by
   * returning the unchanged prefs rather than by throwing. Measured: of the
   * four container/member shapes, exactly one — a member with no manifest of
   * its own inside a container that owns the `.git` — lands here.
   */
  | { readonly outcome: 'refused'; readonly member: string; readonly why: string };

export interface WorkspacePrefsFanOut {
  readonly root: string;
  readonly results: readonly MemberPrefsInheritance[];
}

/**
 * The container's answers, projected to the inheritable keys — or null when it
 * has answered nothing yet.
 *
 * Read through `readProjectPrefs`, the same normalizing reader every other
 * consumer uses, so a container whose bucket holds a retired or malformed key
 * hands its member the normalized value rather than the raw bytes.
 */
export function workspaceInheritablePrefs(
  workspaceRoot: string,
  memberDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Rec | null {
  const prefs = readProjectPrefs(workspaceRoot, env);
  const projected: Rec = {};
  for (const key of WORKSPACE_INHERITED_PREF_KEYS) {
    const value = prefs[key];
    if (value !== undefined && value !== null) projected[key] = value;
  }
  // Read the member's own bucket ONCE, and only for the seeded keys — the
  // container-wins keys above need no such read, and paying for one on every
  // fan-out member would make the cheap half of this cost the same as the
  // careful half.
  const own = readProjectPrefs(memberDir, env);
  for (const key of WORKSPACE_SEEDED_PREF_KEYS) {
    const value = prefs[key];
    if (value === undefined || value === null) continue;
    if (own[key] !== undefined && own[key] !== null) continue;
    projected[key] = value;
  }
  return Object.keys(projected).length > 0 ? projected : null;
}

// Did the merge actually LAND? `mergeProjectPrefs` returns the value it
// computed, not the value on disk, and its store declines some creations
// silently — so success is decided from a fresh read, the same rule
// `plugin:sync` follows for host installs.
function inheritedKeysPresent(memberDir: string, expected: Rec, env: NodeJS.ProcessEnv): string[] {
  const after = readProjectPrefs(memberDir, env);
  return Object.keys(expected).filter((key) => JSON.stringify(after[key]) === JSON.stringify(expected[key]));
}

/**
 * Give ONE member the container's shared answers.
 *
 * Idempotent: re-running writes the same values and re-reports `inherited`.
 */
export function inheritWorkspacePrefsToMember(
  workspaceRoot: string,
  memberDir: string,
  env: NodeJS.ProcessEnv = process.env,
): MemberPrefsInheritance {
  const member = path.resolve(memberDir);
  const projected = workspaceInheritablePrefs(workspaceRoot, member, env);
  if (!projected) return { outcome: 'nothing-to-inherit', member };
  mergeProjectPrefs(member, projected, env);
  const landed = inheritedKeysPresent(member, projected, env);
  if (landed.length !== Object.keys(projected).length) {
    const missing = Object.keys(projected).filter((key) => !landed.includes(key));
    return {
      outcome: 'refused',
      member,
      why: `${member} did not accept the inherited preference${missing.length === 1 ? '' : 's'} `
        + `${missing.join(', ')} — its per-user preference bucket could not be created or written`,
    };
  }
  return { outcome: 'inherited', member, keys: landed };
}

/**
 * Fan the container's shared answers out to every member it MANAGES.
 *
 * Opted-out members are absent from `registry.members` by construction (see
 * MEMBER_OPT_OUT_KEY), so this writes nothing inside a directory the repository
 * excluded — the same property that makes opting out cost the resolver nothing
 * makes it cost this nothing.
 *
 * A container that is not a workspace, or whose registry could not be
 * enumerated, fans out to nobody and says so with an empty result list rather
 * than an exception: every caller is a wizard answer or a runner step whose own
 * outcome must not turn on this.
 */
export function inheritWorkspacePrefsToMembers(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkspacePrefsFanOut {
  const root = path.resolve(workspaceRoot);
  const registry = readWorkspaceMemberRegistry(root);
  if (registry.kind !== 'members') return { root, results: [] };
  return {
    root,
    results: registry.members.map((member) => (
      inheritWorkspacePrefsToMember(root, path.join(root, ...member.split('/')), env)
    )),
  };
}

/**
 * The wizard steps whose answers a member takes from its container.
 *
 * `code-graph` is deliberately absent — it writes machine-wide state, so a
 * member already sees it and a fan-out would be a copy of a value that is not
 * per-project in the first place.
 */
const SHARED_ANSWER_STEPS = new Set(['open-code', 'performance', 'team-confirmation']);

export function isSharedWorkspaceAnswerStep(step: string): boolean {
  return SHARED_ANSWER_STEPS.has(step);
}

/**
 * Whether `dir` is a workspace CONTAINER, and which members it manages.
 *
 * A thin projection of the registry reader, kept here so the flow and the
 * runner ask the question one way. `members` is empty for a container that has
 * registered nobody, which is a REFUSAL state elsewhere and never a licence for
 * this module to enumerate the directory and register what it finds.
 */
export interface WorkspaceContainerView {
  readonly isContainer: boolean;
  readonly members: readonly string[];
  readonly identities: readonly WorkspaceMemberIdentity[];
  /** Non-empty when the registry exists but could not be enumerated. */
  readonly why: string;
}

export function workspaceContainerView(dir: string): WorkspaceContainerView {
  const registry = readWorkspaceMemberRegistry(path.resolve(dir));
  if (registry.kind === 'members') {
    return { isContainer: true, members: registry.members, identities: registry.identities, why: '' };
  }
  if (registry.kind === 'opaque') {
    return { isContainer: true, members: [], identities: [], why: registry.why };
  }
  // `illegible` is NOT reported as a container: the bytes could not be read at
  // all, so nothing establishes that this directory carries the workspace mode.
  // `none` is the ordinary answer for every project that exists today.
  return { isContainer: false, members: [], identities: [], why: registry.kind === 'illegible' ? registry.why : '' };
}

/** The member entry whose id or path matches `selector`, or null. */
export function memberBySelector(
  identities: readonly WorkspaceMemberIdentity[],
  selector: string,
): WorkspaceMemberIdentity | null {
  const wanted = selector.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!wanted) return null;
  // Id first, path second, and never the other way round: the id is the durable
  // identity a rename preserves, so a selector that matches one member's id and
  // a DIFFERENT member's path must resolve to the id. (The reader already
  // guarantees ids are unique within a workspace, so the first match is the
  // only match.)
  return identities.find((entry) => entry.id === wanted)
    ?? identities.find((entry) => entry.path === wanted)
    ?? null;
}