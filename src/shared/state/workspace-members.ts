// src/shared/state/workspace-members.ts
// The WRITE half of the Traffic One workspace members registry. The read half —
// and the long note on which of this tree's five "workspace" senses this is —
// lives in shared/hook/workspace-members.ts, which is a leaf so the resolution
// walk can reach it; this side needs the state lock and the write fence, so it
// lives here instead of closing a state → hook/paths → state cycle.

import * as path from 'path';

import {
  WORKSPACE_MEMBERS_KEY,
  WORKSPACE_PROJECT_MODE,
  validateMemberPath,
} from '../hook/workspace-members';
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
  | { readonly outcome: 'written'; readonly members: readonly string[] }
  | { readonly outcome: 'rejected'; readonly why: string }
  | { readonly outcome: 'refused'; readonly why: string };

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
 */
export function writeWorkspaceMemberRegistry(
  workspaceRoot: string,
  memberDirs: readonly string[],
): WorkspaceMemberRegistryWrite {
  const root = path.resolve(workspaceRoot);
  const members: string[] = [];
  for (const memberDir of memberDirs) {
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
    const validated = validateMemberPath(rel);
    if (validated === null) return { outcome: 'rejected', why: `${memberDir} is not a member path this reader accepts` };
    if (!members.includes(validated)) members.push(validated);
  }
  const entries = members.map((member) => ({ path: member }));
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
  return { outcome: 'written', members };
}
