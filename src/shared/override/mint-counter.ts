// src/shared/override/mint-counter.ts
// A signed, monotone, per-project count of how many overrides this install has
// minted — kept in the machine-owned `one.json`, NOT in the override bucket.
//
// ── Why it exists at all, given the ledger IS the audit record ───────────────
// Because the ledger can be deleted. `rm -rf ~/.traffic-one/overrides/<hash>`
// takes the lines AND the snapshots with it, and every remaining check then
// reads a clean install: no token, nothing unvouchable, nothing orphaned. The
// counter is the one witness that lives somewhere the erasure does not reach,
// so `count > lines we can still see` is the only evidence left that something
// was removed.
//
// ── What it deliberately does NOT do ─────────────────────────────────────────
// An ABSENT counter is never an accusation. There is no counter on an install
// that predates this code, none on a machine where nothing was ever minted, and
// none if `one.json` itself is deleted — and those three are indistinguishable
// from each other. Refusing on absence would fail every clean install in the
// world to close a hole that deleting one more file reopens, so absence is
// silent and only a counter that EXISTS speaks: it must verify, and it must not
// exceed the distinct mints the ledger still shows.
//
// ── What the counter actually buys, measured ─────────────────────────────────
// It closes BUCKET-ONLY erasure — `rm -rf ~/.traffic-one/overrides/<hash>` — and
// nothing wider. The residual is not `rm -rf ~/.traffic-one`, which this file
// used to claim; that is far more than an attacker has to spend. Two cheaper
// moves reach a clean verdict with the install key, the auth record and every
// other project intact:
//
//   - the same `rm -rf` plus deleting this project's one key from the
//     `overrideMints` object. Not closable: the result is byte-identical to an
//     install that never minted, and that shape has to stay eligible.
//   - the same `rm -rf` plus one appended byte in `one.json`, because an
//     unparseable envelope folds into absent below.
//
// Both are RETROSPECTIVE: they cost the attacker a move after the mint they
// want hidden. What used to be worse was the PROSPECTIVE version — freeze the
// counter once and every later mint is free. `schemaVersion: 99` makes
// `updateOneSettings` throw on every write while every read below still returns
// `verified` with a signed, trustworthy number, so the witness reported perfect
// health and could never advance again; a directory at the `one.json` path
// across the mint, removed afterwards, reaches the same place.
//
// That class is closed at the MINT rather than here, and it is closed by a
// WRITE THAT IS OBSERVED rather than by an opinion about bytes. `writable`
// below is a content predicate — it asks whether the envelope PARSES against
// the schema `updateOneSettings` enforces — and a content predicate cannot see
// an envelope that will not accept a write for a reason that is not in its
// contents. Two of those were measured from a clean install, and both left the
// old pre-check answering `writable: true` while every write threw:
//
//   - an owner file planted in `one.json.lock/` naming pid 1. The owner reader
//     accepts it, `kill(1, 0)` answers EPERM, and a liveness check that read
//     EPERM as "alive" never reaped it, so every settings write ran to the
//     500ms deadline and threw. (Closed on its own terms too — see
//     one-settings.ts's `ownerLiveness`: EPERM means "not mine to ask about",
//     which for a lock under a 0700 per-user machine dir is not a holder.)
//   - the directory holding `one.json` made unwritable. The writer stages a
//     temp file beside the target and renames, and lock acquisition mkdirs in
//     the same directory, so both fail — while the override bucket, a
//     SUBDIRECTORY, keeps accepting the ledger append and the snapshot.
//
// So `recordOverrideMint` bumps, RE-READS, and reports whether the number
// actually moved, and `mintOverride` refuses the mint and takes back what it
// wrote when it did not. `writable` survives as the cheap pre-flight (it
// refuses before anything is written, and it is what the doctor reports so an
// operator learns before they need the hatch), not as the guarantee.
//
// Both wrecks above also make the write THROW, measured — so those two are
// refused twice over, and the re-read is not what earns them. What the re-read
// earns is the case the throw cannot see: a write that LANDS somewhere the next
// reader does not look, or lands and is replaced before anyone reads it. The
// envelope is machine-scoped and rewritable by anything running as the user, so
// "updateOneSettings returned" and "the counter a later reader will consult
// moved" are different facts, and only the second one is worth anything. Pinned
// as its own case in integrity.test.ts, including the number that is high
// enough but signed by nobody.
//
// Refusing CERTIFICATION on a frozen envelope would still strand every project
// on a machine whose settings file went unsupported for reasons of its own — a
// plugin downgrade is enough — to deter an attacker whose mint no longer lands.
//
// ── The `unreadable` fold, re-argued without the circle ──────────────────────
// The old justification was that an attacker willing to corrupt the envelope
// could delete it instead — which is circular, since deleting it IS the attack.
// The fold survives on a different argument. Refusing on `unreadable` would
// strand EVERY project on a machine whose settings file went unparseable for
// reasons of its own, including projects that never minted anything, to deter
// an attacker whose cheaper option is the bullet above: delete this project's
// single counter key, which is quieter (it does not break auth for the whole
// machine), and which must stay silent under any policy that keeps a clean
// install eligible. So the refusal costs honest machines and buys nothing
// against the erasure. Reported, so the doctor can say so, and never a verdict.
//
// ── And what it does NOT survive: a rollback ─────────────────────────────────
// The record is signed but not FRESH — nothing in it binds it to a moment.
// MEASURED: copy `one.json`, mint, delete the new line and its snapshot, put
// the copy back. Clean verdict. "Monotone" is true of the WRITE path (the bump
// below never lowers the number it stores); it is not true of the stored value,
// which is only as durable as the file holding it. Closing that needs an anchor
// this layer does not have — anything monotone it could bind to lives in the
// same envelope and rolls back with it, so a rollback of the whole envelope is
// OUT OF SCOPE here rather than defended against.
//
// ── Why one.json and not a sidecar ───────────────────────────────────────────
// It has to survive deletion of the override bucket, which rules out living
// beside the ledger; and it has to be written under the same lock as everything
// else in that file, which rules out a raw-`fs` sidecar racing one-settings.ts's
// read-merge-write. `updateOneSettings` re-reads under its lock and merges this
// section KEY BY KEY (see mergeRawSettings), so two projects minting at once
// cannot drop each other's counter.

import { readJsonResult } from '../fsjson';
import {
  isOneSettingsLockTimeout,
  oneSettingsPath,
  oneSettingsSchemaError,
  updateOneSettings,
} from '../one-settings';
import { projectRootHash } from '../state/local-prefs/prefs-store';
import { OVERRIDE_MINT_COUNTER_MAC_DOMAIN, overrideMac, overrideMacMatches, readOverrideKey } from './keys';

export const OVERRIDE_MINT_COUNTER_VERSION = 1 as const;

/** The top-level `one.json` key this module owns. */
export const OVERRIDE_MINT_SECTION = 'overrideMints';

/**
 * 'absent'       — no envelope, no section, or no entry for this project. The
 *                  clean-install case, and the pre-existing-install case. Never
 *                  a refusal.
 * 'verified'     — the entry exists and its MAC checks out against this
 *                  install's key. `count` is trustworthy.
 * 'unverifiable' — the entry exists and does not verify: no MAC, a wrong MAC, a
 *                  wrong shape, or no key to check it with. Someone edited it,
 *                  or the key was rotated; either way this install cannot use
 *                  it and cannot pretend it is not there.
 * 'unreadable'   — `one.json` exists and could not be parsed. Treated as
 *                  ABSENT for the verdict, on purpose — see this file's header
 *                  for the argument, which is that the refusal strands honest
 *                  machines while the attacker's cheaper move (deleting this
 *                  project's one counter key) stays silent regardless.
 *                  Reported so the doctor can say so.
 */
export type OverrideMintCounterState = 'absent' | 'verified' | 'unverifiable' | 'unreadable';

export interface OverrideMintCounterRead {
  readonly state: OverrideMintCounterState;
  /**
   * The integer the file carries, whatever the state — trustworthy ONLY when
   * `state === 'verified'`. The untrusted value is still returned because the
   * bump below has to be monotone against it: a counter edited DOWN must not be
   * a way to make the next mint start over.
   */
  readonly count: number | null;
  /**
   * Whether the envelope's CONTENTS would be accepted by a write —
   * `schemaVersion: 99`, a non-object, unparseable bytes. Derived from the read
   * this function has already done, so it costs nothing.
   *
   * A CONTENT PREDICATE, AND ONLY THAT, which is the correction of a claim this
   * field used to carry. It says nothing about whether the write can LAND: a
   * planted lock owner and an unwritable parent directory both leave it `true`
   * while every write throws (this file's header measures both). `mintOverride`
   * therefore refuses on the OBSERVED bump — `recordOverrideMint` re-reads and
   * reports whether the number moved — and asks this only as a pre-flight, so
   * the common freeze is refused before a snapshot and a ledger line are
   * written and then taken back.
   *
   * Not a verdict: a frozen envelope is not evidence that anything was erased,
   * and refusing certification on it would strand every project on a machine
   * whose settings file went unsupported for reasons of its own (a downgrade is
   * enough). It is a REFUSAL TO MINT and a doctor finding — the mint is the only
   * moment at which the freeze could buy anything.
   */
  readonly writable: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function countOf(entry: Record<string, unknown>): number | null {
  return Number.isInteger(entry.count) && Number(entry.count) >= 0 ? Number(entry.count) : null;
}

interface CounterEnvelope {
  readonly section: Record<string, unknown> | null | 'unreadable';
  /** Whether `updateOneSettings` would accept a write to this envelope. */
  readonly writable: boolean;
}

function counterEnvelope(env: NodeJS.ProcessEnv): CounterEnvelope {
  // `readJsonResult`, not `readOneSettings`: this runs inside settlement, must
  // never throw, and must tell an absent envelope from an illegible one —
  // exactly the distinction the typed reader's fallback folds away.
  const read = readJsonResult<Record<string, unknown>>(oneSettingsPath(env));
  // An absent file is written from scratch by the first bump, so it is writable.
  if (read.kind === 'absent') return { section: null, writable: true };
  if (read.kind !== 'ok') return { section: 'unreadable', writable: false };
  // The same predicate `updateOneSettings` throws on, asked off this read
  // instead of a second one. See one-settings.ts's oneSettingsSchemaError.
  const writable = oneSettingsSchemaError(read.value) === null;
  const section = read.value[OVERRIDE_MINT_SECTION];
  if (section === undefined || section === null) return { section: null, writable };
  return { section: asRecord(section) ?? 'unreadable', writable };
}

export function readOverrideMintCounter(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideMintCounterRead {
  const { section, writable } = counterEnvelope(env);
  if (section === 'unreadable') return { state: 'unreadable', count: null, writable };
  if (section === null) return { state: 'absent', count: null, writable };
  const projectKey = projectRootHash(projectRoot);
  const raw = section[projectKey];
  if (raw === undefined || raw === null) return { state: 'absent', count: null, writable };
  const entry = asRecord(raw);
  if (!entry) return { state: 'unverifiable', count: null, writable };
  const count = countOf(entry);
  const key = readOverrideKey(env);
  if (!key
    || entry.v !== OVERRIDE_MINT_COUNTER_VERSION
    || entry.projectKey !== projectKey
    || count === null
    || !overrideMacMatches(entry, key, entry.mac, OVERRIDE_MINT_COUNTER_MAC_DOMAIN)) {
    return { state: 'unverifiable', count, writable };
  }
  return { state: 'verified', count, writable };
}

/**
 * Advance this project's counter past both what it already claimed and what the
 * ledger currently shows. Called once, by `mintOverride`, after the audit line
 * is on disk.
 *
 * MONOTONE PER WRITE: the number this call stores is never below the number it
 * read, and it adopts `visibleDistinctMints` when that is larger. Adopting
 * matters twice: on the first mint after this code ships, where an install may
 * already have a history the counter has never seen (starting at 1 there would
 * license deleting every older line), and after an edit that walked the counter
 * backwards, where re-signing at the ledger's own length is what stops the edit
 * from becoming a discount on the next erasure.
 *
 * NOT monotone in the strong sense, and the earlier claim that it was is worth
 * correcting twice over. The value is computed HERE, outside the lock;
 * `updateOneSettings` only re-reads and merges the section under it
 * (one-settings.ts's mergeRawSettings), so two mints racing in one project can
 * both read N and the loser can persist N+1 over the winner's N+2. Safe in the
 * direction it fails — one short is "detects one erasure less", never an
 * accusation — which is why the lock is not widened to cover the read. And the
 * stored value is only as monotone as the file: restoring an older `one.json`
 * restores an older number (see this file's header).
 *
 * DISTINCT MINTS, not ledger lines. Adopting a line count let an attacker
 * duplicate a signed line before a legitimate mint and push the counter to a
 * number the true history can never reach, permanently parking this witness in
 * its silent "behind" state.
 *
 * REPORTS WHETHER THE NUMBER MOVED, not whether the write threw, and the
 * difference is the whole of a bypass. `updateOneSettings` returning without
 * throwing is not evidence that the counter advanced — the mint has to read the
 * number back and see it, because everything an attacker can do to stop the
 * write is invisible to the caller that only asks whether the bytes parsed. So
 * this re-reads and requires a VERIFIED counter at or past the value it aimed
 * for. `mintOverride` refuses on a `false` here and takes back what it wrote.
 *
 * At or PAST, not exactly at: a mint racing in another run of the same project
 * can push the number higher between the write and the read, and that is the
 * witness working, not failing.
 *
 * AND IT SAYS WHICH FAILURE IT WAS, which is the difference between a refusal
 * an operator can act on and one that sends them to the wrong file. `'locked'`
 * is a transient the caller can retry into; `'not-observed'` is everything
 * else. See the type below.
 */
export function recordOverrideMint(
  projectRoot: string,
  visibleDistinctMints: number,
  env: NodeJS.ProcessEnv = process.env,
): OverrideMintCounterWrite {
  const current = readOverrideMintCounter(projectRoot, env);
  const target = Math.max((current.count ?? 0) + 1, visibleDistinctMints);
  const wrote = writeCounter(projectRoot, target, env);
  if (wrote !== 'recorded') return wrote;
  const observed = readOverrideMintCounter(projectRoot, env);
  return observed.state === 'verified' && observed.count !== null && observed.count >= target
    ? 'recorded'
    : 'not-observed';
}

/**
 * 'recorded'     — the number moved, read back from disk.
 * 'locked'       — the settings lock could not be taken inside its deadline.
 *                  A CONTENDED FILE, not a broken one: another writer holds it
 *                  right now, or (before the reap in one-settings.ts) a crashed
 *                  holder's leftovers did. Distinguished because the refusal
 *                  built on it used to name three causes that live in the
 *                  envelope's CONTENTS — an unsupported `schemaVersion`,
 *                  unparseable JSON, something other than a file at that path —
 *                  and a lock is none of them. Those three are also refused
 *                  BEFORE anything is written, by `mintOverride`'s pre-flight,
 *                  so by the time this function can fail they are the least
 *                  likely explanation rather than the three offered.
 * 'not-observed' — the write threw for any other reason, or it returned and the
 *                  number the next reader finds is not the one we aimed for.
 *                  This is the case the re-read earns; see the docblock above.
 */
export type OverrideMintCounterWrite = 'recorded' | 'locked' | 'not-observed';

/**
 * Make sure this project HAS a counter, without touching one it already has.
 * Called by the operator reconciliation (reconcile.ts) and by nothing else.
 *
 * ── Why the repair pins this number ──────────────────────────────────────────
 * An acknowledgement of an ILLEGIBLE ledger forgives a state in which the mint
 * comparison is not asked (integrity.ts says why: with nothing parsed, every
 * counter would "exceed" a count of zero). So the acknowledgement has to pin the
 * counter it saw instead, and a counter that does not exist yet pins nothing —
 * `absent` is also what the cheapest documented residual produces (delete this
 * project's one key from `overrideMints`), which would let the attacker restore
 * the acknowledged tuple after every mint. Writing the counter at the count the
 * ledger currently shows turns that residual into a refusal for as long as the
 * acknowledgement is in force: the number can then only go UP, and up is a
 * mismatch.
 *
 * ADDITIVE, never corrective — the reason this is not `recordOverrideMint` with
 * a different argument. An entry that exists and does not verify is EVIDENCE
 * that something wrote it, and overwriting it with a freshly signed one would be
 * the only place in this feature that erases something. So a counter in any
 * state but `absent` is left exactly as it is, and the acknowledgement pins that
 * state instead; a later mint re-signs it and the pin catches that too.
 */
export function establishOverrideMintCounter(
  projectRoot: string,
  visibleDistinctMints: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const current = readOverrideMintCounter(projectRoot, env);
  if (current.state === 'unreadable' || !current.writable) return false;
  if (current.state !== 'absent') return true;
  return writeCounter(projectRoot, visibleDistinctMints, env) === 'recorded';
}

function writeCounter(
  projectRoot: string,
  count: number,
  env: NodeJS.ProcessEnv,
): OverrideMintCounterWrite {
  const key = readOverrideKey(env);
  if (!key) return 'not-observed';
  const projectKey = projectRootHash(projectRoot);
  const unsigned = { v: OVERRIDE_MINT_COUNTER_VERSION, projectKey, count };
  try {
    updateOneSettings({
      [OVERRIDE_MINT_SECTION]: {
        [projectKey]: { ...unsigned, mac: overrideMac(unsigned, key, OVERRIDE_MINT_COUNTER_MAC_DOMAIN) },
      },
    }, env);
    return 'recorded';
  } catch (error) {
    // An unwritable HOME, a malformed envelope, a lock we could not take — and
    // the last of those is separated out rather than folded in, because it is
    // the only one whose fix is "wait, or find the other writer". See
    // recordOverrideMint's docblock: behind is a safe place for this number to
    // be — and mintOverride refuses BEFORE writing anything when the envelope
    // is the reason, because a counter that can never advance is detection
    // switched off rather than detection running late.
    return isOneSettingsLockTimeout(error) ? 'locked' : 'not-observed';
  }
}
