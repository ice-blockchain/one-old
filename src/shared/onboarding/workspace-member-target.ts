// src/shared/onboarding/workspace-member-target.ts
// `--set-tech <container> --project=<memberId>`: turn the selector into the
// member DIRECTORY the classification is about, registering it if this is the
// first time anyone has run setup on it.
//
// REGISTRATION HAPPENS HERE AND ONLY HERE, because this is the only place a
// PERSON has named a member. That is the whole shape of the product ruling: a
// container with an empty registry is a refusal, not a prompt — onboarding may
// not enumerate the directories it can see and register them, because only the
// person knows which of them was meant and registering the rest would mint
// Traffic One state into folders a team may have deliberately excluded. A
// selector on the command line is that person saying which one.
//
// It follows that this module never widens a selector. It resolves an EXACT id
// or an EXACT relative path; there is no nearest-match, no prefix, no
// "did you mean", and a selector naming a directory that does not exist is a
// refusal rather than an invitation to create one.

import * as fs from 'fs';
import * as path from 'path';

import { registerWorkspaceMember } from '../state/workspace-members';
import {
  inheritWorkspacePrefsToMember,
  memberBySelector,
  workspaceContainerView,
  type MemberPrefsInheritance,
} from './workspace-inherit';

export type WorkspaceMemberTarget =
  | {
    readonly kind: 'member';
    readonly containerRoot: string;
    readonly memberRoot: string;
    readonly id: string;
    /** True only when THIS call added it to the registry. */
    readonly registered: boolean;
    /** Reported, not asserted: a member whose bucket refused the copy is still the target. */
    readonly inheritance: MemberPrefsInheritance;
  }
  | { readonly kind: 'refused'; readonly why: string };

/**
 * Resolve `selector` against `containerRoot`, registering the member when it is
 * not there yet.
 *
 * The order is REGISTERED-FIRST, and it is not an optimization: an id is minted
 * by the registry and only exists once a member is in it, so a selector can
 * only be an id if the lookup finds one. Everything else is read as a path,
 * which is also why `--project=api` works before `api` is registered — a
 * single-segment path and a derived id are spelled the same, so the shorthand
 * people will actually type keeps working in both directions.
 */
export function resolveWorkspaceMemberTarget(
  containerRoot: string,
  selector: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceMemberTarget {
  const container = path.resolve(containerRoot);
  const wanted = selector.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!wanted) return { kind: 'refused', why: '--project= was given no member to select' };

  const view = workspaceContainerView(container);
  if (view.why) {
    return {
      kind: 'refused',
      why: `${container} carries a workspace member registry that could not be read (${view.why}) — `
        + 'repair or remove it before registering members, so nothing here overwrites entries it never saw',
    };
  }

  const existing = memberBySelector(view.identities, wanted);
  // The opt-out check belongs on BOTH branches, and this is the branch where
  // forgetting it costs the ruling: `registerWorkspaceMember` refuses an
  // opted-out entry, but an entry that is ALREADY in the registry never reaches
  // it — so a selector naming an excluded member would have been admitted, its
  // preference bucket seeded from the container, and a stack stamped into a
  // directory the repository said this workspace does not manage. Caught by
  // "running setup on an opted-out member refuses instead of re-enabling it".
  if (existing?.optOut) {
    return {
      kind: 'refused',
      why: `${existing.path} is recorded in ${container}'s member registry as opted out, and that exclusion is `
        + 'committed to the repository. Running setup on it does not withdraw it — remove the entry there if the '
        + 'exclusion no longer applies.',
    };
  }
  if (existing) return admit(container, existing.path, existing.id, false, env);

  // A path this reader cannot verify is a directory is not a member. Registering
  // one would publish a registry entry whose target does not exist, and the
  // registry reader treats a bad entry as poisoning the whole list — so the next
  // read would report the container unenumerable rather than one member missing.
  const candidate = path.join(container, ...wanted.split('/'));
  let isDir = false;
  try { isDir = fs.statSync(candidate).isDirectory(); } catch { isDir = false; }
  if (!isDir) {
    return {
      kind: 'refused',
      why: `${wanted} is neither a registered member of ${container} nor a directory inside it`
        + (view.members.length > 0 ? ` — registered members: ${view.members.join(', ')}` : ''),
    };
  }

  const registration = registerWorkspaceMember(container, wanted);
  if (registration.outcome === 'opted-out') return { kind: 'refused', why: registration.why };
  if (registration.outcome === 'rejected' || registration.outcome === 'refused') {
    return { kind: 'refused', why: registration.why };
  }
  return admit(container, registration.member.path, registration.member.id, registration.outcome === 'registered', env);
}

// Seed the member's preference bucket from the container BEFORE the caller
// classifies it. This is the second of the two inheritance write sites (the
// first is a shared answer at the container fanning out); together they cover
// both orders — container answered first, or member registered first.
function admit(
  container: string,
  memberPath: string,
  id: string,
  registered: boolean,
  env: NodeJS.ProcessEnv,
): WorkspaceMemberTarget {
  const memberRoot = path.join(container, ...memberPath.split('/'));
  return {
    kind: 'member',
    containerRoot: container,
    memberRoot,
    id,
    registered,
    inheritance: inheritWorkspacePrefsToMember(container, memberRoot, env),
  };
}
