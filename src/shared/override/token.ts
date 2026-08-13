// src/shared/override/token.ts
// The operator override token: its shape, its per-install HMAC, its TTL, and
// the two operations on it — MINT (doctor, once, interactively) and READ
// (gates, settlement, doctor's report). There is no third operation: nothing
// updates a token, nothing marks one "used", nothing extends one. That is not
// minimalism, it is the property the design rests on — a token is a signed
// statement about a fixed (project, run, target, window), so the only way to
// change any of those is to mint another one, which writes another audit line.
//
// The per-install HMAC itself, and the key it uses, live in keys.ts — the mint
// counter in the machine-owned one.json signs with the same key and must not
// have to import this file to do it.
//
// ── The one thing this file's READ cannot promise ────────────────────────────
// That the ledger is COMPLETE. Nothing here can tell a project that never
// minted an override from one whose ledger was deleted a second ago, because
// both are an absent file. What this file does instead is refuse to launder the
// difference: `readOverrideLedgerResult` reports HOW the read went, so a caller
// that is about to certify a run (integrity.ts, consumed by settlement) can
// treat "I could not read the record" as something other than "there is nothing
// to read".

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { appendTextFile, writeJson, writeTextFile } from '../fsjson';
import { withMachineFileLock } from '../one-settings';
import { errnoOf } from '../state/state-write-log';
import { projectRootHash } from '../state/local-prefs/prefs-store';
import { ensureOverrideKey, overrideMac, overrideMacMatches, readOverrideKey } from './keys';
import { readOverrideMintCounter, recordOverrideMint } from './mint-counter';
// Runtime import, and it does not close a cycle: reconcile.ts's only reference
// back to this file is `import type { OverrideLedgerKind }`, which is erased.
import { acknowledgedMintCounterFloor } from './reconcile';
import {
  overrideLedgerPath,
  overrideProjectDir,
  overrideProjectPaths,
  overrideRoot,
  overrideSnapshotPath,
} from './paths';
import { readRegularBytesOrThrow, readRegularFileOrThrow } from '../bounded-read';

export {
  ensureOverrideKey,
  overrideMac,
  overrideMacMatches,
  readOverrideKey,
} from './keys';

/**
 * The two things an override may relax — ONE token type, per the plan's
 * "do not ship two overrides with different trust models".
 *
 *   'gate'     — a `gateId` whose deny the pipeline may skip (today's
 *                `doctor --unblock <gateId>`).
 *   'evidence' — a named verification/QA check a run may settle without. NOT
 *                yet minted by anything: this is the slot Phase 5's evidence
 *                waiver occupies, declared here so that item is a new `target`
 *                vocabulary rather than a second mechanism with its own key,
 *                its own audit trail and its own trust model.
 *
 * Both scopes already carry the abuse guard, because it keys on the ledger
 * line, not on the scope (see runOverrideRecords / run-settlement/io.ts).
 */
export type OverrideScope = 'gate' | 'evidence';

export const OVERRIDE_TOKEN_VERSION = 1 as const;

/**
 * Deliberately FLAT — every field a string or a number, no nested objects.
 * The MAC is computed over "every own key except `mac`" (see macPayload), and
 * a nested object would make that payload depend on JSON key order, i.e. on
 * something no format guarantees. Flat also means the audit file is readable
 * with `grep`, at the moment someone is reading it because something went
 * wrong.
 */
export interface OverrideToken {
  readonly v: typeof OVERRIDE_TOKEN_VERSION;
  readonly id: string;
  readonly scope: OverrideScope;
  /** The gateId (scope 'gate') or check id (scope 'evidence') being relaxed. */
  readonly target: string;
  /** projectRootHash of the project — the same key the prefs bucket uses. */
  readonly projectKey: string;
  /** The absolute project root, for the human reading this file. Signed, so it
   *  cannot be re-pointed, but `projectKey` is what matching compares. */
  readonly projectRoot: string;
  /** Always pinned, never null: see mintOverride for why `--run` being optional
   *  on the command line does not make the token project-wide. */
  readonly runId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuedByUser: string;
  readonly issuedByHostname: string;
  readonly issuedByPid: number;
  /** File name (not a path) of the pre-override snapshot beside this ledger. */
  readonly snapshot: string;
  readonly mac: string;
}

export type OverrideEntryOutcome = 'valid' | 'expired' | 'forged' | 'malformed';

export interface OverrideEntry {
  readonly outcome: OverrideEntryOutcome;
  /** Present for every outcome except 'malformed' (nothing parsed to report). */
  readonly token?: OverrideToken;
  /** The raw line, bounded, for a 'forged'/'malformed' report. */
  readonly raw: string;
}

export const OVERRIDE_DEFAULT_TTL_MS = 30 * 60 * 1000;
// A token is a hole in enforcement that nothing closes early, so the window has
// to be bounded by something other than the operator's typing. 24h is the point
// past which "I am fixing this right now" stops being the true description.
export const OVERRIDE_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** `30m`, `90s`, `2h`. No bare numbers: `--ttl 30` is ambiguous enough that
 *  guessing minutes would eventually guess wrong in the permissive direction. */
export function parseOverrideTtl(value: string): number | null {
  const match = /^([1-9]\d{0,5})(s|m|h)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] === 's' ? 1000 : match[2] === 'm' ? 60_000 : 3_600_000;
  const ms = amount * unit;
  return ms > 0 && ms <= OVERRIDE_MAX_TTL_MS ? ms : null;
}

// ── parsing + reading ────────────────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseToken(value: unknown): OverrideToken | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== OVERRIDE_TOKEN_VERSION) return null;
  if (raw.scope !== 'gate' && raw.scope !== 'evidence') return null;
  if (!isNonEmptyString(raw.id)
    || !isNonEmptyString(raw.target)
    || !isNonEmptyString(raw.projectKey)
    || !isNonEmptyString(raw.projectRoot)
    || !isNonEmptyString(raw.runId)
    || !isNonEmptyString(raw.issuedAt)
    || !isNonEmptyString(raw.expiresAt)
    || !isNonEmptyString(raw.mac)) return null;
  if (!Number.isFinite(Date.parse(raw.expiresAt))) return null;
  return raw as unknown as OverrideToken;
}

const MAX_LEDGER_BYTES = 512 * 1024;
const MAX_RAW_LINE = 400;

/**
 * What a ledger read FOUND — the thing the `OverrideEntry[]` return below
 * structurally cannot say, because it answers "the file is not there" and "I
 * could not read the file" with the same empty array.
 *
 * The vocabulary is `readJsonResult`'s (shared/fsjson.ts), deliberately, rather
 * than a second taxonomy for the same distinction: `ok`, `absent`, `corrupt`,
 * `unreadable`, and the one kind a JSON read has no equivalent for.
 *
 *   'ok'         — every non-empty line parsed into a token record.
 *   'absent'     — ENOENT, and the ONLY non-`ok` kind that is LEGIBLE: "nothing
 *                  was ever minted here" is a complete answer, and it is the
 *                  overwhelmingly common one. A clean install must never be
 *                  accused, which is why this is not folded in with the rest.
 *   'corrupt'    — the bytes were read, but at least one non-empty line is not
 *                  a token. The lines that DID parse are still returned (a
 *                  garbage line appended next to a genuine one must not make
 *                  the genuine one disappear); what is lost is the guarantee
 *                  that the file enumerates every mint.
 *   'unreadable' — EACCES/EISDIR/EIO: the file is there and we were refused.
 *   'oversized'  — past MAX_LEDGER_BYTES. Not `unreadable`: nothing failed, we
 *                  declined. Kept distinct because it is the one illegible kind
 *                  an operator can act on by looking at the file.
 */
export type OverrideLedgerKind = 'ok' | 'absent' | 'corrupt' | 'unreadable' | 'oversized';

export interface OverrideLedgerRead {
  readonly kind: OverrideLedgerKind;
  /** Everything that parsed. Empty for every kind except `ok` and `corrupt`. */
  readonly entries: OverrideEntry[];
  /** The errno behind `unreadable`, for the doctor report. */
  readonly errno?: string;
}

/**
 * Can this read be trusted to enumerate every mint? `absent` can — nothing is
 * there. Nothing else can.
 *
 * GATES do not consult this: an illegible ledger yields no honourable token
 * either way, and denying tool calls because an audit file is unreadable would
 * turn a bookkeeping fault into an outage. Only CERTIFICATION consults it
 * (integrity.ts → run-settlement), because a certificate is a claim about
 * evidence and an unreadable record of overrides is not evidence that none
 * were minted.
 */
export function overrideLedgerIllegible(kind: OverrideLedgerKind): boolean {
  return kind !== 'ok' && kind !== 'absent';
}

/**
 * Every line of one project's ledger, each classified, plus how the read went.
 * Never throws, never writes: this runs inside a pre-tool gate's deny path and
 * inside settlement.
 *
 * Reads the WHOLE file rather than tailing it, and is therefore bounded: a
 * ledger past MAX_LEDGER_BYTES is refused outright rather than half-parsed,
 * because a half-parsed audit trail could drop exactly the line that makes a
 * run ineligible.
 */
export function readOverrideLedgerResult(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideLedgerRead {
  const { ledger: file, key: projectKey } = overrideProjectPaths(projectRoot, env);
  let text: string;
  try {
    if (fs.statSync(file).size > MAX_LEDGER_BYTES) return { kind: 'oversized', entries: [] };
    // Read here rather than through `readText`, whose catch-all `null` is the
    // very collapse this function exists to undo: the errno is what tells an
    // absent ledger from one we were refused.
    text = readRegularFileOrThrow(file);
  } catch (error) {
    const errno = errnoOf(error);
    return errno === 'ENOENT'
      ? { kind: 'absent', entries: [] }
      : { kind: 'unreadable', entries: [], errno: errno ?? 'unknown' };
  }
  const key = readOverrideKey(env);
  const now = Date.now();
  const entries: OverrideEntry[] = [];
  let corrupt = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const raw = trimmed.slice(0, MAX_RAW_LINE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      entries.push({ outcome: 'malformed', raw });
      corrupt = true;
      continue;
    }
    const token = parseToken(parsed);
    if (!token) {
      entries.push({ outcome: 'malformed', raw });
      corrupt = true;
      continue;
    }
    // No key, wrong project, or a MAC that does not verify are ONE outcome on
    // purpose. All three mean "this install cannot vouch for this line", and a
    // consumer that treated them differently would have to decide which kind of
    // unvouchable line to trust.
    //
    // NOT `corrupt`: the line is perfectly legible, we simply cannot vouch for
    // it. The completeness question it does raise — a line whose MAC was edited
    // no longer accounts for its snapshot, and no longer counts toward the mint
    // counter — is answered by integrity.ts, which is where every judgement
    // about the record as a WHOLE lives.
    if (!key
      || token.projectKey !== projectKey
      || !overrideMacMatches(parsed as Record<string, unknown>, key, token.mac)) {
      entries.push({ outcome: 'forged', token, raw });
      continue;
    }
    // THREE conditions, not one, and the two additions are both about the same
    // thing: the TTL is a bound the MINT applies off a local clock nothing
    // authenticates, and it was never re-checked afterwards.
    //
    //   - the WINDOW must still be within OVERRIDE_MAX_TTL_MS. Makes that
    //     constant true of tokens as they are READ rather than only of tokens as
    //     they are written, for one subtraction.
    //   - the token must not have been issued in the FUTURE. This is the one that
    //     matters, because the window alone does not catch it: a machine whose
    //     clock reads a year ahead stamps a perfectly well-formed 24-hour token
    //     that is live for a year of real time, and the far-end comparison calls
    //     it fresh for every day of it. MEASURED at a year. A clock corrected
    //     BACKWARDS after an honest mint lands here too and the token stops being
    //     honoured — the right direction, and the operator can re-mint.
    //
    // `expired` rather than `forged` in both cases: the MAC verifies, the line is
    // genuine and the mint really happened, so it must keep counting toward the
    // abuse guard and the mint counter. What it must not do is relax a gate.
    const window = Date.parse(token.expiresAt) - Date.parse(token.issuedAt);
    const live = Date.parse(token.expiresAt) > now
      && Date.parse(token.issuedAt) <= now
      && window > 0 && window <= OVERRIDE_MAX_TTL_MS;
    entries.push({ outcome: live ? 'valid' : 'expired', token, raw });
  }
  return { kind: corrupt ? 'corrupt' : 'ok', entries };
}

/**
 * The classified lines alone — `readJson`'s relationship to `readJsonResult`,
 * for the same reason and with the same shape. Every caller that only asks a
 * question OF the lines (the gate lookup, the abuse guard, the unvouchable
 * report) reads this; the one caller that must not confuse "no record" with "no
 * readable record" reads the result above.
 */
export function readOverrideLedger(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideEntry[] {
  return readOverrideLedgerResult(projectRoot, env).entries;
}

/**
 * Lines this install can vouch for: minted here, for this project, MAC intact.
 * The population a snapshot must be named by to count as accounted for.
 *
 * LINES, not mints — see vouchableMintIds below for the difference and why the
 * mint counter must be compared against that one instead.
 */
export function vouchableOverrideEntries(entries: readonly OverrideEntry[]): OverrideEntry[] {
  return entries.filter((entry) => entry.outcome === 'valid' || entry.outcome === 'expired');
}

/**
 * The DISTINCT mints those lines attest to, by token id — the population the
 * mint counter is measured against.
 *
 * Counting lines was a hole, and a cheap one. MEASURED: mint the override you
 * want hidden, mint a throwaway second one, write the second one's bytes into
 * the ledger TWICE and delete the first line plus its snapshot. Two lines, both
 * verifying, counter at 2, nothing orphaned — `verified` reachable, with no key,
 * no access to one.json, and no forgery. The same bytes verify as many times as
 * they are copied, because a MAC says "this install issued this record", never
 * "this install issued it once".
 *
 * `id` collapses those copies for three reasons, all of which have to hold:
 *   - it is INSIDE the MAC (keys.ts's macPayload signs every own key except
 *     `mac`), so a copy cannot be given a fresh id without invalidating itself,
 *     and a line with an unfamiliar id and a valid MAC is one this install
 *     really did issue;
 *   - it is unique per mint by construction — 96 bits from `crypto.randomBytes`
 *     (mintOverride), so two honest mints colliding needs ~2^48 of them;
 *   - the only way to obtain a SECOND signed line carrying an id already on
 *     record is to hold the key, and an attacker with the key does not need any
 *     of this (keys.ts states that residual).
 *
 * Duplicates are therefore counted once rather than refused, and the reason is
 * the wedge rather than the retry the earlier note claimed. There IS no retry:
 * `mintOverride` appends once, and a short write completes on the same `O_APPEND`
 * fd instead of re-appending the line, so "an honest append can produce a
 * duplicate" was fiction. What is true is that REFUSING on duplicates would hand
 * anything that can write that file a permanent wedge — copy a line, and the
 * project can never certify again — which is the same one-file denial of service
 * reconcile.ts exists for, bought for free. Counting them once takes the payoff
 * away instead. integrity.ts REPORTS how many it saw, which is what an operator
 * needs, without turning it into a verdict.
 */
export function vouchableMintIds(entries: readonly OverrideEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of vouchableOverrideEntries(entries)) {
    if (entry.token) ids.add(entry.token.id);
  }
  return ids;
}

// Past this, a ledger is not fingerprinted at all. Ten times the size at which
// the reader above declines to parse: the point of hashing an ILLEGIBLE ledger
// is to let an operator pin the exact bytes they reconciled (reconcile.ts), and
// a bound is what stops that read being a way to make settlement read a file of
// any size somebody chose.
const MAX_LEDGER_DIGEST_BYTES = 10 * MAX_LEDGER_BYTES;

/**
 * A content fingerprint of this project's ledger, or '' when there is nothing
 * to fingerprint (absent, refused, or past the bound above).
 *
 * Only the reconciliation path reads this — an operator acknowledging an
 * illegible ledger is acknowledging THESE bytes, and a digest is what keeps the
 * acknowledgement from also covering whatever is appended to the file later.
 * Never called on the clean-install path.
 */
export function overrideLedgerDigest(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const file = overrideLedgerPath(projectRoot, env);
  try {
    if (fs.statSync(file).size > MAX_LEDGER_DIGEST_BYTES) return '';
    return crypto.createHash('sha256').update(readRegularBytesOrThrow(file)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * The live token covering (run, scope, target), or null.
 *
 * The read every GATE does. Expiry is applied here and nowhere else, which is
 * what makes "a token past its TTL is treated as absent" true by construction
 * rather than by every caller remembering to check.
 */
export function activeOverrideToken(
  projectRoot: string,
  runId: string | null,
  scope: OverrideScope,
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideToken | null {
  if (!runId || !target) return null;
  for (const entry of readOverrideLedger(projectRoot, env)) {
    if (entry.outcome !== 'valid' || !entry.token) continue;
    if (entry.token.scope !== scope || entry.token.target !== target) continue;
    if (entry.token.runId !== runId) continue;
    return entry.token;
  }
  return null;
}

/**
 * Every override ever minted for this run, TTL IGNORED.
 *
 * The read SETTLEMENT does, and the difference from activeOverrideToken is the
 * whole abuse guard: an override expiring restores enforcement, it does not
 * restore the run's eligibility for `verified`/`shipped`. Otherwise waiting out
 * 30 minutes would launder the run.
 *
 * Keyed on MINTING, not on a gate observing the token in use, because gates are
 * read-only here — a "used" flag would need a gate to write, on the hot path,
 * to a file the same operator could then edit. Minting is also the honest event
 * to punish: an operator who mints an override for a run has declared that the
 * run's enforcement record is no longer complete, whether or not the token
 * happened to fire.
 */
export function runOverrideRecords(
  projectRoot: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideToken[] {
  if (!runId) return [];
  return readOverrideLedger(projectRoot, env)
    .filter((entry) => (entry.outcome === 'valid' || entry.outcome === 'expired') && entry.token?.runId === runId)
    .map((entry) => entry.token as OverrideToken);
}

/** Lines this install cannot vouch for. Never affects a verdict; exists so the
 *  doctor report can say so out loud, which is the only way anyone finds out. */
export function unvouchableOverrideEntries(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideEntry[] {
  return readOverrideLedger(projectRoot, env)
    .filter((entry) => entry.outcome === 'forged' || entry.outcome === 'malformed');
}

// ── minting ──────────────────────────────────────────────────────────────────

export interface MintOverrideInput {
  readonly projectRoot: string;
  readonly runId: string;
  readonly scope: OverrideScope;
  readonly target: string;
  readonly ttlMs?: number;
  /** The pre-override state this token will let past, captured by the caller
   *  (runners/doctor/unblock.ts) — a plain JSON value, written verbatim. */
  readonly snapshot: unknown;
  readonly env?: NodeJS.ProcessEnv;
  readonly nowMs?: number;
}

export type MintOverrideFailure =
  | 'no-key'
  | 'counter-unwritable'
  /** The counter's own file is FINE and something else is writing it right now
   *  (mint-counter.ts's `'locked'`). Separate from `counter-unwritable` because
   *  the refusal built on that one names three causes that live in the
   *  envelope's contents, and a contended lock is none of them — it is a retry,
   *  not a repair. MEASURED as a live wrong answer before the split: an honest
   *  mint against a settings lock left by a killed process was refused with
   *  `counter-unwritable`, i.e. with an accusation about a file that parsed
   *  perfectly. */
  | 'counter-locked'
  | 'snapshot-write-failed'
  | 'ledger-write-failed';

export type MintOverrideResult =
  | { readonly ok: true; readonly token: OverrideToken; readonly snapshotPath: string }
  | { readonly ok: false; readonly reason: MintOverrideFailure };

/**
 * Write the token + its snapshot. A pure library call: the INTERACTIVITY
 * requirement ("minted only interactively") lives in the doctor CLI that calls
 * this, not here.
 *
 * That split is deliberate and is what keeps the confirmation un-bypassable.
 * The alternative — enforcing the TTY inside this function — would need an
 * escape hatch for its own tests, and a test-only escape hatch in a security
 * primitive is a bypass with a comment on it. Here the tests call the library
 * and the confirmation has no off switch at all.
 *
 * Snapshot BEFORE ledger, deliberately: a crash between the two leaves a
 * snapshot with no token rather than a live token whose "what did this let
 * past" evidence never landed. That orphan file used to be inert. It is not any
 * more — integrity.ts counts it, because a snapshot the ledger cannot account
 * for is the exact residue that `rm overrides.jsonl` leaves behind, and nothing
 * on disk distinguishes the two. A mint interrupted at that instant therefore
 * costs the project's runs their eligibility for `verified`, which is the
 * fail-closed side of a distinction that cannot be made.
 *
 * A ledger append that FAILS is a different case from a crash, and is now
 * handled rather than left to look like one. `appendTextFile` routes through
 * fsjson's `act()`, which rethrows every errno except ELOOP, so this function
 * used to PROPAGATE where its own type says it returns `ledger-write-failed` —
 * MEASURED with a directory at the ledger path: EISDIR escaped `mintOverride`,
 * `runUnblock` has no catch, and the operator got exit 1 with no message while
 * the snapshot written a few lines above stayed on disk and blocked
 * certification for the whole project, permanently, for a mint that never
 * happened. The append is caught and the snapshot is removed on failure, so a
 * refused mint leaves the project exactly as it found it.
 *
 * The MINT COUNTER is bumped LAST, after the ledger line is durable, and the
 * order is not negotiable: a counter that ran AHEAD of the ledger would accuse
 * a project of an erasure that never happened, permanently, so the bump cannot
 * be hoisted above the append to make its failure cheaper to handle.
 *
 * ITS FAILURE IS NO LONGER SWALLOWED, and that is the correction of a real
 * hole rather than a tightening. `recordOverrideMint` returns whether the
 * number MOVED — it re-reads it — and this function refuses the mint when it
 * did not, taking back the ledger line and the snapshot it just wrote. The
 * argument for swallowing it was that "behind only means detects less", which
 * is true of a counter that falls behind ONCE for a transient reason and false
 * of one that can never advance again: the second is detection switched off,
 * and it is reachable from a clean install by planting one file (mint-counter.ts
 * measures both routes). Neither is visible to a caller that only asks whether
 * the envelope's bytes parse, which is why the pre-flight below is a pre-flight
 * and the observed bump is the guarantee.
 *
 * THE ROLLBACK IS BOUNDED AND ITS FAILURE IS DOCUMENTED. Removing the line this
 * call just appended is not erasing an audit trail — no token is returned, no
 * gate will ever honour one, and the line is matched by the id minted a few
 * lines above. If the rewrite itself fails, the mint still refuses, and what is
 * left behind is a signed line whose counter never moved: the counter is BEHIND,
 * which is the safe direction, and the abuse guard still holds that run at
 * `validating` for a token the operator was told they did not get. The
 * alternative — returning success because cleanup failed — would hand out the
 * mint the counter cannot account for, which is the whole defect.
 *
 * AND IT IS SERIALISED AGAINST OTHER MINTS, which the by-id matching alone did
 * not achieve. The append, the count, the bump and the take-back run under one
 * hold of the ledger lock; see the transaction comment in the body for the two
 * measured ways a concurrent mint used to turn this refusal into a project-wide
 * certification block, and for the lock order.
 */
export function mintOverride(input: MintOverrideInput): MintOverrideResult {
  const env = input.env ?? process.env;
  const key = ensureOverrideKey(env);
  if (!key) return { ok: false, reason: 'no-key' };
  const projectRoot = path.resolve(input.projectRoot);
  // PRE-FLIGHT, not the guarantee. A `one.json` whose CONTENTS refuse writes —
  // `schemaVersion` set to an unknown integer, a directory in its place — is
  // knowable before anything is written, and refusing here saves writing a
  // snapshot and a ledger line only to take them back below. It does not, and
  // cannot, cover an envelope that parses and still will not accept a write; the
  // observed bump at the bottom of this function is what covers that.
  //
  // Refused at the MINT rather than reported at settlement, because the mint is
  // the only moment a frozen counter can buy anything: retrospective detection
  // still works (the counter that was already signed still exceeds the lines
  // that remain), and refusing certification on a frozen envelope would strand
  // every project on a machine whose settings file went unsupported for its own
  // reasons. The operator is at a terminal and the refusal names the file, so
  // this is a fix instruction rather than a wedge.
  if (!readOverrideMintCounter(projectRoot, env).writable) {
    return { ok: false, reason: 'counter-unwritable' };
  }

  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs && input.ttlMs > 0
    ? Math.min(input.ttlMs, OVERRIDE_MAX_TTL_MS)
    : OVERRIDE_DEFAULT_TTL_MS;
  const id = crypto.randomBytes(12).toString('hex');

  try {
    fs.mkdirSync(overrideRoot(env), { recursive: true, mode: 0o700 });
    fs.mkdirSync(overrideProjectDir(projectRoot, env), { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, reason: 'ledger-write-failed' };
  }

  const snapshotPath = overrideSnapshotPath(projectRoot, id, env);
  if (!writeJson(snapshotPath, input.snapshot)) return { ok: false, reason: 'snapshot-write-failed' };

  const unsigned = {
    v: OVERRIDE_TOKEN_VERSION,
    id,
    scope: input.scope,
    target: input.target,
    projectKey: projectRootHash(projectRoot),
    projectRoot,
    runId: input.runId,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    issuedByUser: safeUser(),
    issuedByHostname: safeHostname(),
    issuedByPid: process.pid,
    snapshot: path.basename(snapshotPath),
  };
  const token: OverrideToken = { ...unsigned, mac: overrideMac(unsigned, key) };

  // ── ONE TRANSACTION, one lock hold ──────────────────────────────────────────
  // Append, count, bump, and (if the bump did not land) take the line back. The
  // append alone is `O_APPEND` and needs no lock; everything after it does, and
  // MEASURING THE HALF-MEASURE IS WHY THE HOLD SPANS ALL FOUR. Locking only the
  // two ledger writes made the take-back's stated guarantee true — the
  // concurrent line survives, measured — and left a second way for an honest
  // concurrent mint to block the project: it appends after our line, counts
  // THREE distinct mints including the one we are about to withdraw, signs the
  // counter at 3, and our take-back then leaves two lines under a counter of
  // three. `override-mint-count-mismatch` fires and refuses `verified` for
  // every run in the project — the same outcome as the destroyed line, reached
  // by counting instead of by overwriting.
  //
  // No other writer of this ledger exists, so the hold is exhaustive rather
  // than merely wide: a concurrent mint now observes the ledger only from
  // before our append or from after our take-back, and neither view contains a
  // line that is about to vanish.
  //
  // LOCK ORDER, since the counter bump takes `one.json`'s lock inside this one:
  // ledger before settings, always. Nothing takes the ledger lock while holding
  // the settings lock — the ledger lock is taken in this file and nowhere else,
  // at this one site — so the cycle that would deadlock cannot be formed. The
  // hold is now as long as a settings write, and a mint that cannot take the
  // lock inside `ONE_SETTINGS_NESTED_LOCK_TIMEOUT_MS` is REFUSED rather than
  // queued; that refusal is visible, retryable, and strictly better than the two
  // silent corruptions above. THE WAITER'S BUDGET IS FOUR TIMES THE INNER ONE
  // rather than equal to it, which is not a tuning choice: a hold that contains
  // a settings write can outlast a wait of one settings-lock budget every time,
  // so with the two equal an honest concurrent mint was refused by arithmetic.
  // Measured, both numbers, in one-settings.ts's constant.
  let outcome: MintOverrideResult;
  try {
    outcome = withOverrideLedgerLock(projectRoot, env, (): MintOverrideResult => {
      if (!appendTextFile(overrideLedgerPath(projectRoot, env), `${JSON.stringify(token)}\n`)) {
        return { ok: false, reason: 'ledger-write-failed' };
      }
      // DISTINCT mints, not lines: adopting a line count lets an attacker pad
      // the ledger with copies of a signed line before a legitimate mint and
      // walk the counter somewhere the real history can never reach again —
      // which would then read as the counter being permanently BEHIND, i.e. as
      // detection quietly switched off. See vouchableMintIds.
      //
      // OBSERVED. The boolean says the number moved, read back from disk; a
      // mint whose counter did not move is a mint no witness outside the
      // override bucket can ever account for, so it is refused rather than
      // reported.
      const recorded = recordOverrideMint(
        projectRoot,
        Math.max(
          vouchableMintIds(readOverrideLedgerResult(projectRoot, env).entries).size,
          // The ledger is not the only floor available, and on its own it is not
          // one: an attacker who deletes this project's counter key writes the
          // ledger too. See acknowledgedMintCounterFloor — including what that
          // bound is NOT, which is a bound against anyone who reads the key.
          acknowledgedMintCounterFloor(projectRoot, env),
        ),
        env,
      );
      if (recorded !== 'recorded') {
        revokeUnmintedLine(projectRoot, id, snapshotPath, env);
        // The cause travels, because the two have opposite fixes: a contended
        // settings lock is waited out, a refused envelope is repaired.
        return { ok: false, reason: recorded === 'locked' ? 'counter-locked' : 'counter-unwritable' };
      }
      return { ok: true, token, snapshotPath };
    });
  } catch {
    // Every errno except ELOOP arrives here rather than as `false`; see the
    // docblock. A lock we could not take within its deadline throws here too,
    // and lands in the same place for the same reason: no line was written, so
    // the mint is refused and the snapshot below is removed. Appending anyway
    // would put the line back inside the window this exists to close.
    outcome = { ok: false, reason: 'ledger-write-failed' };
  }
  if (!outcome.ok && outcome.reason === 'ledger-write-failed') {
    // The snapshot is now evidence of a mint that did not happen, and the
    // orphan scan cannot tell it from evidence of one that was erased. Removing
    // it is not erasing an audit trail: no token was issued, no gate will ever
    // honour one, and nothing else on disk refers to this id.
    try { fs.unlinkSync(snapshotPath); } catch { /* already gone, or never landed */ }
  }
  return outcome;
}

/**
 * Take back the line and the snapshot of a mint that is being REFUSED — the one
 * write in this feature that removes something, and the reason it is not an
 * erasure is that nothing ever held the token: `mintOverride` returns a failure
 * on the same path, no gate is offered the line, and the id is one this call
 * generated microseconds earlier.
 *
 * Matched by ID rather than by truncating to the pre-append length. The append
 * is `O_APPEND`, so a concurrent mint in another run of the same project can
 * land a line after ours, and a truncation would eat that project's genuine
 * audit record to clean up ours.
 *
 * BY-ID WAS NOT ENOUGH ON ITS OWN, and the gap was the whole distance between
 * the guarantee and the code. The removal is a read-modify-write: the read used
 * to precede a concurrent `O_APPEND`, and the write then replaced the file
 * without it. MEASURED, with a genuinely signed second line appended between
 * the two: the line was destroyed, its snapshot was left in the bucket, and
 * `overrideEvidenceReport` fired `override-snapshot-orphaned` at once — which
 * refuses `verified` for EVERY run in the project. So an honest concurrent mint
 * produced a project-wide certification block, which is a worse outcome than
 * the truncation this design was chosen over.
 *
 * Closed by SERIALISING every writer of this file on one lock rather than by
 * narrowing the claim. CALLED WITH THAT LOCK ALREADY HELD — `mintOverride`
 * takes it once around the whole append/count/bump/take-back transaction, so
 * this function must NOT take it again: the lock is not reentrant and a second
 * acquisition would spin to its own deadline and then skip the take-back,
 * turning a refused mint into the orphaned line this exists to remove. There is
 * exactly one caller and it is thirty lines up.
 *
 * Best-effort, and the caller refuses either way: see mintOverride's docblock
 * for what a failed rollback leaves and why that is the safe side of the
 * failure. A ledger this cannot READ is left entirely alone for the same
 * reason: rewriting a file we could not parse would turn a refused mint into
 * the erasure this module exists to detect.
 */
function revokeUnmintedLine(
  projectRoot: string,
  tokenId: string,
  snapshotPath: string,
  env: NodeJS.ProcessEnv,
): void {
  try { fs.unlinkSync(snapshotPath); } catch { /* already gone, or never landed */ }
  const file = overrideLedgerPath(projectRoot, env);
  let text: string;
  try {
    text = readRegularFileOrThrow(file);
  } catch {
    return;
  }
  const kept: string[] = [];
  let found = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.trim());
    } catch {
      kept.push(line);
      continue;
    }
    const id = (parsed as Record<string, unknown> | null)?.id;
    if (id === tokenId) { found = true; continue; }
    kept.push(line);
  }
  if (!found) return;
  writeTextFile(file, kept.length > 0 ? `${kept.join('\n')}\n` : '');
}

/**
 * The one lock the audit ledger has, taken at ONE site: the mint transaction.
 * Every writer of this file is inside that hold — the append and the take-back
 * are the only two, counted rather than assumed (`appendTextFile` and
 * `writeTextFile` against this path appear nowhere else in the module, and the
 * reconciliations write `one.json` under that file's own lock).
 *
 * The machine-dir lock protocol from one-settings.ts, not a second copy of it:
 * it is the hardened one (atomic publication, token-addressed reaping, EPERM
 * read as `not-ours`, and every owner read BOUNDED), and its `not-ours`
 * argument needs the lock to sit under a 0700 per-user directory — which is
 * exactly where `overrideProjectDir` puts this bucket, `mkdir`ed 0700 by the
 * mint a few lines above.
 *
 * THE FOURTH PROPERTY WAS ASSERTED HERE BEFORE IT WAS TRUE, and this lane's own
 * ledger lock is where it was measured false: a FIFO named `owner-<hex>.json`
 * in the directory below made `withMachineFileLock` at THIS path never return —
 * driven, SIGKILLed at 12 011 ms with a 2 ms control, through both of that
 * file's readers — so `traffic-one override` hung with no deadline, no log and
 * no verdict, and every `updateOneSettings` caller on the machine inherited it.
 * It rests on shared/bounded-read.ts, which the three readers now go through: an
 * allowlist that opens non-blocking and decides on the DESCRIPTOR whether it has
 * a regular file. What it does NOT bound is the medium — a regular owner file on
 * an unresponsive mount still blocks in the kernel.
 *
 * ACROSS PROCESSES, which is the only scale that matters here: two mints are
 * two `runUnblock` invocations at two terminals, not two calls in one process.
 * Nothing in one process re-enters it, and the mint is the only entry.
 *
 * ITS DEADLINE IS THE NESTED ONE, and it has to be: this hold CONTAINS a
 * settings write that may itself wait a full settings-lock budget, so a waiter
 * given the same budget could never get in — not because the policy refuses it
 * but because the arithmetic does. Both were 500ms, and the hold was measured
 * at 534–561ms with the inner write contended. `withMachineFileLock` defaults
 * to ONE_SETTINGS_NESTED_LOCK_TIMEOUT_MS for exactly this caller; the default is
 * taken rather than restated so the two cannot be edited apart.
 */
function withOverrideLedgerLock<T>(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  body: () => T,
): T {
  return withMachineFileLock(overrideLedgerPath(projectRoot, env), body);
}

function safeUser(): string {
  try {
    return os.userInfo().username || '';
  } catch {
    return '';
  }
}

function safeHostname(): string {
  try {
    return os.hostname() || '';
  } catch {
    return '';
  }
}
