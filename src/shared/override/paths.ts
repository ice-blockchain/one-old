// src/shared/override/paths.ts
// Where the operator override lives on disk. Everything here is OUTSIDE any
// project tree, under the per-user machine dir, and that is the whole point:
// the primitive's threat model is "an agent with write access to the project
// must not be able to mint, forge, extend or erase an override", and a file
// inside `<project>/.traffic-one/` fails all four at once.
//
// The machine dir is resolved BESIDE THE SETTINGS FILE — `dirname(
// oneSettingsPath(env))` — which is the rule shared/auth/machine-sidecar.ts
// states in general terms: "the same override (TRAFFIC_ONE_STATE_PATH) that
// relocates the record these files are ABOUT must relocate them too". Under both
// default layouts this is byte-identical to `globalTrafficOneDir(env)`, since
// that is where `oneSettingsPath` puts one.json.
//
// IT WAS `globalTrafficOneDir` DIRECTLY, and that is one resolver too many —
// which this note used to argue against while being the second resolver. The two
// disagree on exactly one input: `oneSettingsPath` honours
// TRAFFIC_ONE_STATE_PATH (README documents it, and six test files use it to
// isolate one.json) and `globalTrafficOneDir` reads XDG_STATE_HOME › HOME only.
// So one.json — which holds the mint counter AND the reconciliation
// acknowledgement — relocated while the bucket holding the ledger, the snapshots
// and the install key did not.
//
// WHAT THAT COST, DRIVEN end to end (load 11.31) rather than derived: an orphan
// snapshot, reconciled, verdict CLEAR (`checks: []`, one reconciliation on
// record, counter `verified`). Relocate the settings file and nothing else — no
// file moved, no byte changed — `override-snapshot-orphaned` comes back,
// reconciliations reads 0 and the counter reads `absent`. A project that WAS
// reconciled reads as never reconciled, and `verified` is refused for every run
// in it, for as long as the variable is set.
//
// THE RESIDUAL, stated because it is the reason the old spelling looked safe: a
// relocated bucket is exempt from the consent fence only while its path holds no
// `.traffic-one` segment (state/plugin-use.ts's `projectRootForStatePath`
// returns null otherwise, and `machineOwnedStatePath` only exempts entries under
// `globalTrafficOneDir`). An operator who points TRAFFIC_ONE_STATE_PATH INSIDE a
// project's own state dir therefore gets a bucket that project's pending
// use-plugin question governs. That is not a new exposure: the relocated
// one.json and its two auth sidecars already sit there under the identical rule,
// so the bucket is now exactly as exposed as the file it must stay correlated
// with — and the alternative is the silent certification loss measured above.
//
// NOTE for whoever adds the next machine-dir entry: `overrides` had to be
// added to MACHINE_OWNED_ENTRIES in state/plugin-use.ts. Without it, the
// default layout ($HOME/.traffic-one, XDG_STATE_HOME unset) makes every path
// here look like state belonging to the "$HOME project", so the consent fence
// governs it by that project's unanswered use-plugin question — i.e. minting
// an override from a home-rooted session would be silently refused.

import * as path from 'path';

import { oneSettingsPath } from '../one-settings';
import { projectRootHash } from '../state/local-prefs/prefs-store';

/** The machine dir entry this module owns; also the MACHINE_OWNED_ENTRIES key. */
export const OVERRIDE_DIR_NAME = 'overrides';

export function overrideRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(oneSettingsPath(env)), OVERRIDE_DIR_NAME);
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
 * consumer that makes the asymmetry expensive to repair — though NOT for the
 * reason this note used to give. "Relocating buckets invalidates tokens already
 * in operators' hands" is false for the obvious one-line change (switching to
 * `realpathSync.native`): MEASURED, the canonical spelling hashes identically
 * under both implementations, so a token minted under a project's true spelling
 * keeps matching and only MISCASED buckets move. The cost is that a machine
 * which has only ever used the miscased spelling has its LIVE bucket there, and
 * moving it takes the ledger and the mint counter to a fresh empty pair — an
 * erasure of this feature's own audit trail, shipped as an upgrade. Read
 * projectRootHash's note before changing how the name is derived.
 */
export function overrideProjectDir(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return overrideProjectPaths(projectRoot, env).dir;
}

export interface OverrideProjectPaths {
  /** The bucket name, and the value a token's `projectKey` is checked against. */
  readonly key: string;
  readonly dir: string;
  readonly ledger: string;
  readonly snapshots: string;
}

/**
 * Every path one project's override state lives at, from ONE resolution of the
 * project root. `projectRootHash` realpaths, so a reader that needs both a file
 * here and the key that names the bucket (token.ts's ledger read does: it
 * checks every line's `projectKey`) otherwise pays for the same lookup twice
 * and — the part that is not about cost — could in principle resolve it to two
 * different buckets.
 */
export function overrideProjectPaths(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideProjectPaths {
  const key = projectRootHash(projectRoot);
  const dir = path.join(overrideRoot(env), key);
  return { key, dir, ledger: path.join(dir, 'overrides.jsonl'), snapshots: path.join(dir, 'snapshots') };
}

/**
 * The append-only audit ledger: one JSON object per line, one line per minted
 * token. This file IS the audit record — the token and the evidence that it was
 * issued are deliberately the same artefact, so there is no way to hold a valid
 * token whose issuance went unrecorded.
 */
export function overrideLedgerPath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return overrideProjectPaths(projectRoot, env).ledger;
}

/**
 * Where the pre-override snapshots live. A directory rather than an
 * implementation detail of the path below because it is ENUMERATED: a snapshot
 * whose ledger line has gone missing is the residue an erasure leaves, and
 * integrity.ts can only find it by listing this directory (shared/override/
 * snapshots.ts).
 */
export function overrideSnapshotDir(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return overrideProjectPaths(projectRoot, env).snapshots;
}

/** The pre-override snapshot for one token, beside its ledger line. */
export function overrideSnapshotPath(
  projectRoot: string,
  tokenId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(overrideSnapshotDir(projectRoot, env), `${tokenId}.json`);
}
