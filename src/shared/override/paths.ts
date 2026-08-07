// src/shared/override/paths.ts
// Where the operator override lives on disk. Everything here is OUTSIDE any
// project tree, under the per-user machine dir, and that is the whole point:
// the primitive's threat model is "an agent with write access to the project
// must not be able to mint, forge, extend or erase an override", and a file
// inside `<project>/.traffic-one/` fails all four at once.
//
// The machine dir is resolved through globalTrafficOneDir() — the existing
// resolver (state/traffic-one-paths.ts), the same one the per-project prefs
// bucket and the consent answer use. Not a second one: a store that disagreed
// with the consent fence about where the machine dir is would land under a
// project's state dir on exactly the machines that relocate their state, and
// the fence would then refuse to write it.
//
// NOTE for whoever adds the next machine-dir entry: `overrides` had to be
// added to MACHINE_OWNED_ENTRIES in state/plugin-use.ts. Without it, the
// default layout ($HOME/.traffic-one, XDG_STATE_HOME unset) makes every path
// here look like state belonging to the "$HOME project", so the consent fence
// governs it by that project's unanswered use-plugin question — i.e. minting
// an override from a home-rooted session would be silently refused.

import * as path from 'path';

import { projectRootHash } from '../state/local-prefs/prefs-store';
import { globalTrafficOneDir } from '../state/traffic-one-paths';

/** The machine dir entry this module owns; also the MACHINE_OWNED_ENTRIES key. */
export const OVERRIDE_DIR_NAME = 'overrides';

export function overrideRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalTrafficOneDir(env), OVERRIDE_DIR_NAME);
}

/**
 * The per-install HMAC key. One key per machine dir, never per project: it
 * authenticates "this token was minted by the doctor running on this install",
 * and a per-project key would live wherever that project's operator could most
 * easily be tricked into pointing it.
 */
export function overrideKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(overrideRoot(env), 'install-key');
}

/**
 * Keyed by the SAME project hash the per-user prefs bucket uses
 * (local-prefs/prefs-store.ts's projectRootHash — realpath, then sha256), so a
 * project reachable by two spellings has one override ledger, exactly as it has
 * one consent answer. Re-deriving the hash here would let the two disagree on a
 * symlinked checkout.
 *
 * It inherits that function's documented CASE asymmetry too, and this is the
 * consumer that makes the asymmetry expensive to repair: an override token
 * carries the bucket name as its `projectKey` (token.ts), so relocating buckets
 * invalidates tokens already in operators' hands. Read projectRootHash's note
 * before changing how the name is derived.
 */
export function overrideProjectDir(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(overrideRoot(env), projectRootHash(projectRoot));
}

/**
 * The append-only audit ledger: one JSON object per line, one line per minted
 * token. This file IS the audit record — the token and the evidence that it was
 * issued are deliberately the same artefact, so there is no way to hold a valid
 * token whose issuance went unrecorded.
 */
export function overrideLedgerPath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(overrideProjectDir(projectRoot, env), 'overrides.jsonl');
}

/** The pre-override snapshot for one token, beside its ledger line. */
export function overrideSnapshotPath(
  projectRoot: string,
  tokenId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(overrideProjectDir(projectRoot, env), 'snapshots', `${tokenId}.json`);
}
