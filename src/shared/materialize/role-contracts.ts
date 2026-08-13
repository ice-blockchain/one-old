// src/shared/materialize/role-contracts.ts
// The one writer every host's per-role contract files go through — and the one
// place the filesystem is allowed to say no.
//
// ── the defect this replaces ─────────────────────────────────────────────────
// Six writers (cursor, copilot, kilo, codex, windsurf, opencode) each carried a
// byte-identical
//
//     try { fs.mkdirSync(dir, { recursive: true }); } catch { return written; }
//
// and returned a plain `number` that materialize.ts folded into a success count
// with `written += writeXAgentFiles(...)`. Three separate things were wrong with
// that, and only the first is the obvious one:
//
//   1. AN INABILITY REPORTED AS A SUCCESS. Measured end to end on a complete
//      project with an 'installed' plugin root, host cursor, with `.cursor/agents`
//      planted as a plain file (mkdir EEXIST), as a dangling symlink (ENOENT) and
//      with `.cursor` at mode 0500 (EACCES): all three returned 0 role contracts
//      on disk while `materializeProjectFromState` reported status `materialized`
//      with the systemMessage "project-local rules/skills materialized", stamped
//      `materializedAt`, and — because hasMaterializedProjectAssets checks only
//      rules/skills/AGENTS.md/CLAUDE.md — made the NEXT hook return null. Healthy
//      baseline in the same harness: written 102, six contracts on disk; each
//      planted shape: written 96, ZERO contracts, every other reported field
//      identical.
//
//      The absence used to be PERMANENT for the life of that plugin build,
//      because nothing asked again. It is not any more, and the fix is not in
//      this file: role-contract-status.ts answers the same question from DISK,
//      materializeProjectIfNeeded (converge.ts) carries that answer as a
//      convergence term, and onboarding-gate/handler.ts refuses file-changing
//      work while the directory is refused. Reporting the inability is what made
//      all three possible; it is not by itself what heals.
//
//   2. A COUNT OF DELETIONS RETURNED AS A COUNT OF WRITES. `written` was seeded
//      from `cleanupGeneratedAgents`, so whatever the sweep removed was returned
//      as though it had been written. Not reachable through the mkdir catch —
//      measured: `mkdirSync(dir, {recursive:true})` on an EXISTING directory
//      always succeeds, so every shape that makes it throw also leaves the sweep
//      with nothing to remove — but reachable through the per-file catch, where
//      one stale sweep plus unwritable role paths returned 2 for 1 file on disk.
//      Splitting `written` from `removed` here is what closes it; the
//      `unwritable` variant below carries NO `written` field at all, so a caller
//      cannot re-add a write count to the path where nothing was written without
//      failing to compile.
//
//   3. NOWHERE TO PUT THE ANSWER. A `number` cannot say "the directory could not
//      be created" — the same reason shared/fs-identity.ts's `FsIdentity` and
//      fsjson.ts's `JsonRead` are unions rather than nullable values. This
//      follows those two: "wrote nothing because there was nothing to write" and
//      "wrote nothing because the filesystem refused" are different facts and
//      only one of them is evidence about the project.
//
// ── why this is a shared primitive rather than six fixes ────────────────────
// The six copies were identical; patching each is a denylist of spellings that a
// seventh host reintroduces silently. Here the mkdir, the per-file write and the
// failure accounting are ONE body, and the return type is what forces a caller
// to face the failure.
//
// TWO guards keep a SEVENTH host from re-opening the hole, and the pair matters
// because the first one alone was defeated by adding a file:
//
//   - THE TYPE. `RoleContractOutcome` is SEALED (the brand below): no module
//     outside this file can spell a value of it, so a new writer cannot invent
//     `{ kind: 'complete', written: <its sweep count> }` — the exact defect this
//     replaces — or any other variant, at any severity. It must call
//     `writeRoleContracts` or `roleContractsSwept`, and both keep the sweep count
//     in `removed`. That is a compiler property rather than a scan, so it holds
//     for a file nobody has thought to list; the `@ts-expect-error` rows in
//     __tests__/role-contract-seal.test.ts are what keep it honest.
//   - THE DIRECTORY. __tests__/role-contract-swallow.test.ts refuses a raw
//     `mkdir` in ANY non-test file under `shared/materialize/**` except a short
//     exemption list checked for EQUALITY, so an unlisted new file is covered on
//     the day it is added rather than on the day someone remembers to list it.
//     The previous rule enumerated the six writers by filename and a review
//     added a seventh (`zed-agents.ts`) that passed it while carrying the
//     original swallow.
//
// It does NOT throw. This code runs inside the hook runtime, where an escaping
// error becomes a fail-closed deny that can wedge a session — a defect this repo
// has taken before. It reports, and the caller decides.

import * as fs from 'fs';
import * as path from 'path';

import { writeTextIfChanged } from '../fs-text';
import { errnoOf } from '../state/state-write-log';

/** The path the filesystem refused, and the errno it refused with. */
export interface RoleContractFailure {
  readonly path: string;
  readonly errno: string;
}

/** One role contract to write: an absolute path and its full body. */
export interface RoleContractFile {
  readonly path: string;
  readonly content: string;
}

/**
 * WHICH host's contracts are missing, HOW badly, and the exact paths refused.
 *
 * The host is carried because the answer depends on it: `.cursor/agents/`,
 * `.github/agents/`, `.kilo/agents/`, `.traffic-one/agents/`,
 * `.devin/agents/<role>/` and OpenCode's global profile dir are six different
 * places, and an operator who is told "role contracts could not be written"
 * without being told where cannot check anything.
 *
 * Declared here rather than in materialize.ts (which re-exports it) because it
 * is also what role-contract-status.ts reports from a plain disk read, with no
 * materialization involved.
 */
export interface RoleContractShortfall {
  readonly host: string;
  readonly kind: 'unwritable' | 'partial';
  readonly failures: readonly RoleContractFailure[];
}

/**
 * The seal. `RoleContractOutcome` carries a property whose key is a symbol this
 * module does not export, so no other module can construct one — the whole
 * point being that the one thing a writer must not do (report its DELETION
 * count as a write count) is unspellable rather than merely discouraged.
 *
 * Round 1 relied on `unwritable` carrying no `written` field, which is true and
 * is not enough: `partial` and `complete` both carry one, so the identical
 * defect was still expressible one severity down. It is the CONSTRUCTIBILITY
 * that had to close, not one field of one variant.
 *
 * `declare const` means there is no runtime value, so the three constructors
 * below cast once each and nothing is added to the object at run time. A caller
 * determined to lie can still write `as RoleContractOutcome`; that is a
 * deliberate act in the caller's own diff rather than the accident this closes,
 * and the directory scan in __tests__/role-contract-swallow.test.ts fails on it.
 */
declare const ROLE_CONTRACT_SEAL: unique symbol;
interface Sealed {
  readonly [ROLE_CONTRACT_SEAL]: true;
}

/**
 * What the write attempt achieved.
 *
 * `unwritable` deliberately carries no `written`: the directory never existed,
 * so there is no write count to report and no way to spell one by accident.
 * `removed` rides on every variant because a sweep that ran before the failure
 * still happened and its count is still true — it is just not a write.
 */
export type RoleContractOutcome =
  | (Sealed & { readonly kind: 'complete'; readonly written: number; readonly removed: number })
  | (Sealed & {
    readonly kind: 'partial';
    readonly written: number;
    readonly removed: number;
    readonly failures: readonly RoleContractFailure[];
  })
  | (Sealed & { readonly kind: 'unwritable'; readonly removed: number; readonly failure: RoleContractFailure });

function seal<T>(outcome: T): T & Sealed {
  return outcome as T & Sealed;
}

/**
 * Nothing to write, and a sweep that ran anyway.
 *
 * The shape every "this host writes no contracts in this configuration" return
 * needs — OpenCode's main-agent mode is the live one (opencode-assets.ts). It is
 * a CONSTRUCTOR rather than an object literal at each site because the sealed
 * type cannot be spelled elsewhere, and that is the point: the sweep count can
 * only reach `removed`, never `written`.
 */
export function roleContractsSwept(removed: number): RoleContractOutcome {
  return seal({ kind: 'complete' as const, written: 0, removed });
}

/** The write count, for the two variants that have one. Zero for `unwritable`. */
export function roleContractsWritten(outcome: RoleContractOutcome): number {
  return outcome.kind === 'unwritable' ? 0 : outcome.written;
}

/** Every path this attempt could not write, whether the directory or the files. */
export function roleContractFailures(outcome: RoleContractOutcome): readonly RoleContractFailure[] {
  if (outcome.kind === 'complete') return [];
  return outcome.kind === 'unwritable' ? [outcome.failure] : outcome.failures;
}

/**
 * Create `dir` and write every contract in `files`, reporting what the
 * filesystem allowed.
 *
 * `removed` is the caller's own sweep count, passed through rather than
 * recomputed: the sweep runs before this (it decides which stale contracts to
 * delete from host-specific file naming) and its result must survive a failure
 * here without being mistaken for a write.
 *
 * The per-file `mkdirSync` covers the one host whose contracts are nested
 * (`.devin/agents/<role>/AGENT.md`); for the flat hosts it is a no-op on a
 * directory that already exists.
 */
export function writeRoleContracts(
  dir: string,
  removed: number,
  files: readonly RoleContractFile[],
): RoleContractOutcome {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return seal({ kind: 'unwritable' as const, removed, failure: { path: dir, errno: errnoOf(error) ?? 'unknown' } });
  }

  let written = 0;
  const failures: RoleContractFailure[] = [];
  for (const file of files) {
    try {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      if (writeTextIfChanged(file.path, file.content)) written += 1;
    } catch (error) {
      failures.push({ path: file.path, errno: errnoOf(error) ?? 'unknown' });
    }
  }
  return failures.length > 0
    ? seal({ kind: 'partial' as const, written, removed, failures })
    : seal({ kind: 'complete' as const, written, removed });
}
