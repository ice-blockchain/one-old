// src/shared/override/reconcile.ts
// The named repair for an override record that cannot account for itself — and
// the reason that repair is not a delete.
//
// ── The problem it exists for ────────────────────────────────────────────────
// integrity.ts is fail-closed by design: an orphaned snapshot, an illegible
// ledger or a snapshot directory too big to scan all refuse certification for
// the whole project. MEASURED, all three, with no mint, no key and no counter
// involved: `echo '{}' > ~/.traffic-one/overrides/<projectKey>/snapshots/x.json`
// refuses forever; 600KB of junk in the ledger refuses forever; 300 files in the
// snapshots directory refuses forever. Anything that can write a file under the
// machine dir — which is anything that can run a shell as the user, i.e. the
// agent — can wedge a project's certification permanently, and nothing in
// retention, cleanup or reset touches that bucket.
//
// A control with no way out is a wedge, not a control. But the obvious way out
// is the attack: a supported command that removes orphan snapshots or truncates
// the ledger is exactly the capability every witness here exists to deny, handed
// over with a friendly name. So the repair is neither of those.
//
// ── What the repair IS ───────────────────────────────────────────────────────
// A RECONCILIATION: a signed statement, appended to the machine-owned one.json,
// that an operator looked at this exact anomalous state and accounted for it.
// Three properties, and all three are what make it safe:
//
//   1. AUTHENTICATED the same way a mint is — the TTY + typed-nonce route in
//      runners/doctor/unblock.ts, plus the per-install HMAC key. An agent that
//      can write junk into the bucket cannot reconcile it away THROUGH THIS
//      MODULE; the confirmation has no off switch and no test hook. What it
//      cannot claim is that the same agent cannot forge the record directly, and
//      the qualifier is not pedantry: the key is one 0600 file inside the 0700
//      directory that agent already writes, measured in
//      acknowledgedMintCounterFloor below. The MAC answers "did the doctor on
//      this install write this?" against everything that does not go and read
//      it, which is the same boundary keys.ts draws for tokens.
//   2. APPEND-ONLY. It deletes nothing, anywhere. The orphan snapshots stay on
//      disk, the ledger keeps every byte it had, an existing mint counter is
//      left exactly as it is — verifying or not, because an entry that does not
//      verify is evidence — and the reconciliation itself is appended beside any
//      earlier one rather than replacing it. Afterwards the audit trail is
//      strictly LARGER than before: it now also records who declared the gap
//      acceptable and when. The one thing it CREATES is a mint counter for a
//      project that has none, at the count the ledger currently shows; that is
//      additive, and property 3 is why it is necessary.
//   3. EXACT, and therefore not a capability — where exact means it pins the
//      witnesses the acknowledged state SUPPRESSES and not only the one that
//      fired. That distinction is the correction of a real defect, not a
//      refinement: an acknowledgement of an illegible ledger used to compare the
//      ledger's bytes alone, while the state it forgave also switched off the
//      snapshot scan, the mint comparison, and the per-run abuse guard that
//      reads the same unparseable file. MEASURED before the fix: plant junk at
//      the ledger path with no mint, no key and no counter, repair once, then
//      mint an override, use it, and copy the acknowledged bytes back — two runs
//      settled `verified`, counter at 2 against zero visible mints, no finding.
//      One signature forgave every future erasure. So an entry now pins the
//      ledger's bytes, the orphan set's contents, the file count behind an
//      unfinished scan, the counter's own deficit AND — when the ledger is
//      illegible — the snapshot file set and the counter's exact state and value.
//      One more planted file, one more appended junk byte, one more mint, one
//      more deleted ledger line, and the project refuses again. A reconciliation
//      cannot be minted in advance and it cannot be reused.
//
// ── The price, and why the repair cannot launder a hidden mint ───────────────
// Erasing a ledger line hides WHICH run was overridden, so a repair that simply
// cleared the finding would hand the attacker the run they were after. Every
// reconciliation therefore QUARANTINES: it names every run that exists in the
// project at that moment and those runs are permanently ineligible for
// `verified`/`shipped`, checked by run-settlement/io.ts from this signed record
// and from nowhere else. The run somebody wanted laundered is one of them —
// they wanted it certified, so it exists. What the project buys is a fresh
// start for work that comes AFTER the operator looked, which is the most a
// record with a hole in it can honestly offer.
//
// Three residuals, stated rather than papered over.
//
// The quarantine is a list of run directory NAMES, and that map is writable by
// anyone who can write the project: `mv runs/R runs/R2`, or a `cp -r` of it,
// gives the same working tree a run id the signed list does not hold. Deleting
// the directory before reconciling does the same. MEASURED at the real
// settlement writer, and the measurement is the reason this stays a residual
// rather than becoming a fix: the copy on its own — every artifact byte for byte,
// run ids re-pointed inside them — is REFUSED, because the verification
// contract's hash covers its own runId and the QA report binds to that hash. The
// new id certifies only once evidence is FABRICATED for it, and fabricated
// evidence certifies any run id in any project with no override and no
// reconciliation in the picture at all. Keying the quarantine on another field
// inside a tree the attacker writes would move which field they edit without
// raising that floor. This feature's deliberate boundary is that an override
// taints the RUN and not the tree, and the quarantine cannot be narrower than it.
//
// An acknowledgement IS REPLAYABLE, and the ruling not to expire it stands on a
// premise that was WRONG the first time it was written down. Nothing binds an
// entry to a moment — `reconciledAt` is signed and compared by nothing — so an
// acknowledgement forgives its state whenever that state recurs. The state it
// pins includes the mint counter, and the original ruling said the only way to
// recreate a pinned count is to restore the previously signed entry BYTES, i.e.
// an envelope rollback that erases the mint anyway. That is false, and it is
// false in one step with no key and no reused signature: DELETE this project's
// entry from `overrideMints`. `recordOverrideMint` computes
// `max(current + 1, visibleDistinctMints)`, the deletion zeroes `current`, and
// the next honest mint re-signs the counter from whatever the ledger shows.
//
// MEASURED, from three honest mints at a verified 3:
// deleting the key alone yields 4, because the ledger still shows three mints
// and floors it — but deleting the key AND cutting the ledger to one line yields
// 2, junk at the ledger path yields 1, and planting N-1 genuine lines lands the
// counter on any N the attacker names. So the count walks backwards, to a
// CHOSEN value, for an attacker who can write `one.json` and the bucket.
//
// ── The re-derivation, and the premise it is conditional on ─────────────────
// The ruling survives. It rested on an EQUALITY, that equality was attacked with
// a measurement, and the measurement found a real defect NEXT TO it rather than
// in it. Both are recorded here because the previous two versions of this
// paragraph each stated a premise a later measurement falsified.
//
// 1. A replay needs the whole pinned tuple, not the counter: ledger kind and
//    byte digest, the suppressed-snapshot digest, the orphan digest and count,
//    the snapshot count and scan flag, and the counter's state AND value. Every
//    one of those except the counter is a file the attacker writes, so the
//    counter was the only field the old ruling leaned on. It no longer holds any
//    weight, and the honest statement is that the tuple is reproducible.
// 2. What that costs is one HONEST MINT — the re-establish only happens on a
//    mint, and a mint needs the operator at a TTY (unblock.ts) to confirm. The
//    attacker cannot supply that; they can only wait for one and then restore
//    the acknowledged bytes around it.
// 3. And it buys nothing they did not already have. The same write access
//    deletes everything this project has, and a project with no ledger, no
//    snapshots, no counter and no acknowledgement reads as a clean install —
//    `absent` accuses nobody, deliberately, because an install that predates the
//    counter must not be accused (mint-counter.ts). The replay reaches a state
//    that forgives; the TOTAL wipe reaches a state with nothing to forgive.
//    Neither needs the key, and the wipe needs no mint and no saved bytes.
//
// THE WORD "TOTAL" IS THE CORRECTION, and it is the whole of what round 7
// changed here. Round 6 wrote step 3 about "the bucket", and the code was not
// checking the difference: MEASURED (the two-arm test in
// __tests__/reconcile.test.ts), from a project reconciled after three mints,
// with the acknowledgement pinning `verified/3`:
//
//   rm -rf the bucket + delete `overrideMints[projectKey]`   → CLEAR  (was)
//   …the same, plus delete `overrideReconciliations[projectKey]`  → CLEAR
//
// The first arm is a project reading `absent/absent/0` beside a signed statement,
// IN THE SAME FILE, that its counter stood at 3 — evidence the product already
// stores, that the attacker cannot forge by wiping, and that nothing compared.
// That is now a refusal (integrity.ts's
// OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK), and it was a defect on its
// own terms: findings.ts has been telling operators in so many words that "a
// counter that disappears" refuses again.
//
// It does not, however, remove the equality, and this is where the peer's
// conclusion is REFUTED rather than adopted. The equality is about the second
// arm. Deleting the acknowledgement is one more key in the file the attacker is
// already editing, it costs them nothing once the state it forgave has been
// wiped too — there is no anomaly left for it to suppress, and it takes its own
// run quarantine with it, which they WANT gone — and what it reaches is a
// project indistinguishable from a machine that never minted an override. That
// shape has to stay eligible. So the wipe is still free and still clean; what
// changed is that it now has to be complete.
//
// An expiry therefore closes nothing it did not close before. It cannot reach
// the total wipe, it cannot reach an attacker who replays inside the window, and
// it charges the one party who is certainly honest: an operator whose ledger is
// permanently illegible would re-reconcile every window, and every repeat
// permanently quarantines every run made since the last one.
//
// THE PREMISE, named so the next measurement knows where to aim: a total wipe —
// the bucket plus this project's two keys in `one.json` — is indistinguishable
// from a clean install. WHAT DEFEATS IT: an anchor outside that set. Not "any
// change that makes the wipe detectable", which is what the previous version of
// this note said and is too loose to aim at — everything this layer can reach is
// INSIDE the blast radius, including the acknowledgement (arm B measures it) and
// including the install key (see the floor below). It would take an off-machine
// record, or a monotone marker a clean install provably would not have that the
// same write access cannot remove. This product has neither, and adding one is
// not a change to this file. THE RULING DOES NOT REST ON
// `acknowledgedMintCounterFloor` any more; that claim is retracted below.
//
// ── Should a re-establish be allowed to go backwards? ────────────────────────
// Not below anything that can bound it. The ledger cannot: the attacker writes
// it, measured above. The acknowledgement bounds it only against an attacker who
// does not read one file — see acknowledgedMintCounterFloor, which states what
// it is and is not, with the measurement. Against a keyless attacker the pin
// holds twice over now: the mint takes the max against it, and the deletion that
// used to zero the counter is a REFUSAL rather than a discount to be spotted at
// the next mint.
//
// And a reconciliation is as trustworthy as the operator who typed the nonce; it
// is a record of a human decision, not a proof that the decision was right.

import * as crypto from 'crypto';
import * as os from 'os';

import { readJsonResult, writeTextFile } from '../fsjson';
import { oneSettingsPath, updateOneSettings } from '../one-settings';
import { projectRootHash, projectRootHashAliases } from '../state/local-prefs/prefs-store';
import { sha256 } from '../text';
import {
  OVERRIDE_RECONCILIATION_MAC_DOMAIN,
  ensureOverrideKey,
  overrideMac,
  overrideMacMatches,
  readOverrideKey,
} from './keys';
import { overrideQuarantineSidecarPath } from './paths';
import { readRegularFileOrThrow } from '../bounded-read';
import {
  establishOverrideMintCounter,
  readOverrideMintCounter,
  type OverrideMintCounterState,
} from './mint-counter';
import type { OverrideLedgerKind } from './token';

export const OVERRIDE_RECONCILIATION_VERSION_LEGACY = 1 as const;
export const OVERRIDE_RECONCILIATION_VERSION = 2 as const;

/** The top-level `one.json` key this module owns. Sibling of the mint counter's,
 *  and in the same envelope for the same reason: it has to survive `rm -rf` of
 *  the override bucket, which is one of the states it exists to reconcile. */
export const OVERRIDE_RECONCILE_SECTION = 'overrideReconciliations';

/**
 * One operator acknowledgement. FLAT like every other signed record here (see
 * keys.ts's macPayload), with one array of strings — arrays are order-preserving
 * under `JSON.stringify`, so unlike a nested object they sign deterministically.
 */
export interface OverrideReconciliation {
  readonly v: typeof OVERRIDE_RECONCILIATION_VERSION | typeof OVERRIDE_RECONCILIATION_VERSION_LEGACY;
  readonly projectKey: string;
  readonly reconciledAt: string;
  readonly issuedByUser: string;
  readonly issuedByHostname: string;
  readonly issuedByPid: number;
  /** The ledger read this acknowledges, and a digest of the exact bytes behind
   *  it. '' when the bytes could not be hashed — an acknowledgement with no
   *  fingerprint forgives nothing, by construction. */
  readonly ledgerKind: OverrideLedgerKind;
  readonly ledgerDigest: string;
  /**
   * The witnesses the acknowledged state SUPPRESSES, pinned so the
   * acknowledgement cannot forgive them too. Today that is one thing: an
   * illegible ledger stops the snapshot scan being asked, so the set of snapshot
   * file names is signed here (snapshots.ts's overrideSnapshotNameDigest) and a
   * snapshot appearing or disappearing under the blindfold re-refuses. '' when
   * the acknowledged state suppresses nothing.
   *
   * The counter is the other suppressed witness and is pinned by `counterState`
   * + `counterCount` below, read EXACTLY rather than as a carried deficit when
   * the ledger is illegible. See integrity.ts's excusedBy.
   */
  readonly suppressedSnapshotDigest: string;
  /** Fingerprint of the orphan set (snapshots.ts's orphanSnapshotSetDigest). */
  readonly orphanDigest: string;
  readonly orphanCount: number;
  /** Snapshot files present, and whether the scan of them finished. */
  readonly snapshotCount: number;
  readonly snapshotScanComplete: boolean;
  /** The counter as it read at that moment; -1 stands in for "no number". */
  readonly counterState: OverrideMintCounterState;
  readonly counterCount: number;
  /** Distinct vouchable mints visible then. With counterCount, this is the
   *  DEFICIT being acknowledged — carried forward, never zeroed, so a later
   *  erasure is still measured against the count the counter really reached. */
  readonly vouchableMints: number;
  /**
   * Every run in the project at that moment. Permanently ineligible.
   *
   * v1 inlined the names (capped at MAX_QUARANTINED_RUNS). v2 signs
   * `quarantinedRunsDigest` of a sidecar and resolves this array after the
   * MAC verifies. Membership is still tested against this signed list.
   */
  readonly quarantinedRuns: string[];
  /** sha256 of the sidecar's canonical bytes. Required on v2; absent on v1. */
  readonly quarantinedRunsDigest?: string;
  readonly mac: string;
}

/**
 * Offer threshold for retention pruning before reconcile, not a hard cap.
 * v1 inlined names in one.json and refused above this; v2 signs a sidecar
 * digest, so a project with more runs can still be reconciled. Doctor offers
 * the retention sweep when the on-disk count exceeds this.
 */
export const MAX_QUARANTINED_RUNS = 256;

export interface OverrideReconciliationRead {
  /** Entries this install signed, for this project. The only ones that count. */
  readonly entries: OverrideReconciliation[];
  /** Entries that are present and do not verify. Never forgive anything;
   *  reported so the doctor can say the section was written to by something
   *  that did not hold the key, or that the key was rotated. */
  readonly unverifiable: number;
}

const EMPTY: OverrideReconciliationRead = { entries: [], unverifiable: 0 };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function quarantinedRunsCanonical(runs: readonly string[]): string {
  return [...runs].map((run) => run.trim()).filter(Boolean).sort().join('\n') + (runs.length ? '\n' : '');
}

export function quarantinedRunsDigest(runs: readonly string[]): string {
  return sha256(quarantinedRunsCanonical(runs));
}

export function writeQuarantinedRunsSidecar(
  projectRoot: string,
  runs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { readonly digest: string } | null {
  const digest = quarantinedRunsDigest(runs);
  const file = overrideQuarantineSidecarPath(projectRoot, digest, env);
  if (!writeTextFile(file, quarantinedRunsCanonical(runs))) return null;
  return { digest };
}

export function readQuarantinedRunsSidecar(
  projectRoot: string,
  digest: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return null;
  try {
    const text = readRegularFileOrThrow(overrideQuarantineSidecarPath(projectRoot, digest, env));
    if (sha256(text) !== digest) return null;
    return text.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function parseReconciliation(
  value: unknown,
  acceptedKeys: ReadonlySet<string>,
  key: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): OverrideReconciliation | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (raw.v !== OVERRIDE_RECONCILIATION_VERSION && raw.v !== OVERRIDE_RECONCILIATION_VERSION_LEGACY) return null;
  if (typeof raw.projectKey !== 'string' || !acceptedKeys.has(raw.projectKey)) return null;
  if (typeof raw.ledgerKind !== 'string'
    || typeof raw.ledgerDigest !== 'string'
    || typeof raw.suppressedSnapshotDigest !== 'string'
    || typeof raw.orphanDigest !== 'string'
    || !Number.isInteger(raw.orphanCount)
    || !Number.isInteger(raw.snapshotCount)
    || typeof raw.snapshotScanComplete !== 'boolean'
    || typeof raw.counterState !== 'string'
    || !Number.isInteger(raw.counterCount)
    || !Number.isInteger(raw.vouchableMints)
    || typeof raw.reconciledAt !== 'string') return null;
  if (raw.v === OVERRIDE_RECONCILIATION_VERSION) {
    if (typeof raw.quarantinedRunsDigest !== 'string') return null;
    if (raw.quarantinedRuns !== undefined && !isStringArray(raw.quarantinedRuns)) return null;
  } else if (!isStringArray(raw.quarantinedRuns)) {
    return null;
  }
  if (!overrideMacMatches(raw, key, raw.mac, OVERRIDE_RECONCILIATION_MAC_DOMAIN)) return null;
  if (raw.v === OVERRIDE_RECONCILIATION_VERSION) {
    const runs = readQuarantinedRunsSidecar(projectRoot, raw.quarantinedRunsDigest as string, env);
    if (!runs) return null;
    return { ...raw, quarantinedRuns: runs } as unknown as OverrideReconciliation;
  }
  return raw as unknown as OverrideReconciliation;
}

/** The stored array, verbatim and unjudged — what an append has to preserve. */
function storedEntries(projectKey: string, env: NodeJS.ProcessEnv): unknown[] {
  const read = readJsonResult<Record<string, unknown>>(oneSettingsPath(env));
  if (read.kind !== 'ok') return [];
  const section = asRecord(read.value[OVERRIDE_RECONCILE_SECTION]);
  const mine = section ? section[projectKey] : null;
  return Array.isArray(mine) ? mine : [];
}

/**
 * Every reconciliation on record for this project. Never throws, never writes:
 * this runs inside settlement.
 *
 * A project with no reconciliations — every project, almost always — pays one
 * read of `one.json`, which readOverrideMintCounter has already made anyway.
 */
export function readOverrideReconciliations(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideReconciliationRead {
  const projectKey = projectRootHash(projectRoot);
  const acceptedKeys = new Set(projectRootHashAliases(projectRoot));
  acceptedKeys.add(projectKey);
  const stored = [...acceptedKeys].flatMap((alias) => storedEntries(alias, env));
  // Before the key read, not after: a project with nothing to verify must not
  // pay a stat and a read of the key file on the settlement path, and almost
  // every project has nothing to verify forever.
  if (stored.length === 0) return EMPTY;
  const key = readOverrideKey(env);
  // No key means nothing here can be vouched for. Reported as unverifiable
  // rather than absent, for the same reason token.ts reports an unvouchable
  // line: "I cannot check this" is not "there is nothing here".
  if (!key) return { entries: [], unverifiable: stored.length };
  const entries: OverrideReconciliation[] = [];
  let unverifiable = 0;
  for (const value of stored) {
    const parsed = parseReconciliation(value, acceptedKeys, key, projectRoot, env);
    if (parsed) entries.push(parsed); else unverifiable += 1;
  }
  return { entries, unverifiable };
}

/**
 * The lowest number a re-established mint counter is allowed to come back at:
 * the highest count any VERIFIED acknowledgement for this project pinned. Zero
 * when there are none, which is almost every project forever.
 *
 * ── Why a floor exists at all ────────────────────────────────────────────────
 * `recordOverrideMint` computes `max(current + 1, visibleDistinctMints)`, and an
 * attacker with no key writes BOTH arguments: deleting this project's entry from
 * `overrideMints` (a deletion, not a forgery) zeroes the first, and the ledger
 * is a file in a directory they can write. MEASURED, from three honest mints and
 * a verified counter of 3:
 *
 *   delete the counter key, mint            → verified 4   (the ledger floors it)
 *   delete it AND cut the ledger to 1 line  → verified 2   (backwards, from 4)
 *   delete it AND leave junk at the ledger  → verified 1
 *   delete it and plant N-1 genuine lines   → verified N, for any N they choose
 *
 * The ledger alone therefore bounds nothing an attacker who can write the ledger
 * cares about. THIS bound is different in one way, and the difference is
 * narrower than this docblock used to claim: to remove it they must produce a
 * verifying acknowledgement of their own, or delete the one on record — and
 * deleting it costs them the forgiveness it grants, for as long as the state it
 * forgives is still on disk.
 *
 * ── WHO IT IS A BOUND AGAINST, measured ──────────────────────────────────────
 * An attacker who cannot read one file. That is a real population — accidents,
 * and the agent that reasons its way to "I'll just write the counter myself" —
 * and it is NOT the population the bucket-writing attacker belongs to.
 * MEASURED: the install key is mode 0600 and it sits INSIDE the 0700
 * `overrides/` root that the same attacker already writes, one directory above
 * the bucket whose ledger they are editing. From three honest mints, a verified
 * counter of 3 and an acknowledgement pinning 3:
 *
 *   read install-key                                   → 64 hex, no privileges
 *   replace the acknowledgement, forgiveness intact,   → floor 3 → 1
 *     `counterCount` 1, re-MAC'd in the right domain
 *   delete the counter key, mint                       → verified 1, CLEAR
 *   re-sign the counter directly at 99 / at 0          → verified 99 / 0
 *
 * Only the last row is caught, and not by this floor: 99 trips the mint-count
 * mismatch and 0 trips the contradiction check against their own forged pin of
 * 1. An attacker with the key stays above their own pin and is not caught by
 * anything here.
 *
 * So against that attacker this is not signature-grade; it is a bound they lift
 * by reading a file they can already read, and calling the MAC a bound against
 * them would be worse than claiming nothing, because a ruling that leaned on it
 * would be leaning on nothing. (The ruling at the top of this file no longer
 * does.)
 *
 * ── And it is not fixable here ───────────────────────────────────────────────
 * A key that lives where the thing it protects lives cannot bind that thing.
 * Every property that would — an off-machine observer, an append-only record
 * this machine cannot rewrite — is outside this product. Moving the key within
 * the machine dir buys nothing: the adversary in question runs as this user.
 * keys.ts states the same residual for tokens and counters; this is that
 * residual reaching the third record, not a new one.
 *
 * ── What it does buy, stated so nobody re-derives it as a fix ────────────────
 * It does not stop a REPLAY. A replay needs the pinned count exactly, and `max`
 * with a floor of N still lands on N. Against a KEYLESS attacker it stops the
 * case below the pin: in a reconciled project the counter cannot be walked back
 * under the number the operator signed for, so the carried deficit that makes a
 * second erasure detectable cannot be zeroed by deleting one key. That case is
 * now caught twice, and the second catch is the stronger one because it does not
 * wait for an honest mint to happen: the deleted key contradicts the pin at
 * settlement (integrity.ts's OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK).
 * See the ruling at the top of this file for why the replay itself is not closed
 * here.
 */
export function acknowledgedMintCounterFloor(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  let floor = 0;
  for (const entry of readOverrideReconciliations(projectRoot, env).entries) {
    // -1 is this record's "no number"; a pin of an absent counter floors nothing.
    if (entry.counterCount > floor) floor = entry.counterCount;
  }
  return floor;
}

/**
 * Is this run named by a reconciliation? Consulted by run-settlement/io.ts on
 * the `verified` path, exactly like the abuse guard beside it, and by nothing
 * else. Run-scoped where everything else in integrity.ts is project-scoped,
 * because this is the one judgement that CAN be attributed to a run: the
 * operator named the runs themselves, under their own signature.
 */
export function runQuarantinedByOverrideReconciliation(
  projectRoot: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!runId) return false;
  return readOverrideReconciliations(projectRoot, env).entries
    .some((entry) => entry.quarantinedRuns.includes(runId));
}

/**
 * One acknowledgement reduced to the state it pins — everything a forgiveness
 * decision reads, and nothing about who signed it or what it quarantines.
 *
 * Declared here beside the record itself and consumed by integrity.ts, which is
 * the only module that judges against it. `overrideReconciliationDraft` there
 * produces the one instance this module is ever handed, so what an entry pins and
 * what settlement compares cannot drift into two lists.
 */
export type OverrideAcknowledgement = Pick<OverrideReconciliation,
  'ledgerKind' | 'ledgerDigest' | 'suppressedSnapshotDigest' | 'orphanDigest' | 'orphanCount'
  | 'snapshotCount' | 'snapshotScanComplete' | 'counterState' | 'counterCount' | 'vouchableMints'>;

export interface RecordReconciliationInput {
  readonly projectRoot: string;
  /** The state being acknowledged. `counterState`/`counterCount` are RE-READ
   *  below, after the counter is pinned, rather than taken from here: pinning is
   *  what makes them worth signing, and it can move them by exactly the entry
   *  this call creates. */
  readonly fingerprint: OverrideAcknowledgement;
  readonly quarantinedRuns: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly nowMs?: number;
}

export type RecordReconciliationResult =
  | { readonly ok: true; readonly entry: OverrideReconciliation }
  | { readonly ok: false; readonly reason: 'no-key' | 'too-many-runs' | 'write-failed' | 'sidecar-write-failed' };

/**
 * Append one reconciliation. Called by the doctor's operator command and by
 * nothing else.
 *
 * The existing entries are re-read and carried forward VERBATIM, including any
 * that no longer verify: this file's whole claim is that it never erases, and
 * dropping a record because this install cannot vouch for it would be erasing
 * exactly the evidence that the key was rotated or the section was tampered
 * with.
 *
 * The read-then-append is outside `updateOneSettings`'s lock — the same seam
 * mint-counter.ts documents. Two operators reconciling ONE project from two
 * terminals in the same instant could drop one entry; the section merge under
 * the lock keeps other projects safe, and the failure mode of the residual race
 * is a lost acknowledgement (the project keeps refusing, the operator repeats
 * the command), never a lost quarantine that grants something.
 */
export function recordOverrideReconciliation(
  input: RecordReconciliationInput,
): RecordReconciliationResult {
  const env = input.env ?? process.env;
  // `ensureOverrideKey`, not `readOverrideKey`, and this is the second and last
  // caller allowed to create one (keys.ts's docblock names the mint as the
  // first). The states most in need of reconciling are reachable with NO mint
  // ever — a planted snapshot, junk in the ledger — so on those machines there
  // is no key yet, and a repair that refused for want of one would be no repair
  // at all. Same class of caller as the mint: an operator at a terminal, never
  // a gate on the hot path.
  const key = ensureOverrideKey(env);
  if (!key) return { ok: false, reason: 'no-key' };
  const sidecar = writeQuarantinedRunsSidecar(input.projectRoot, input.quarantinedRuns, env);
  if (!sidecar) return { ok: false, reason: 'sidecar-write-failed' };
  // PIN THE COUNTER FIRST, and refuse the whole acknowledgement if it cannot be
  // pinned. An acknowledgement of an illegible ledger forgives a state in which
  // the mint comparison is not asked, so the counter is the witness holding that
  // state still (integrity.ts's excusedBy) — and `absent` is not a value that can
  // hold anything, because deleting this project's one counter key reproduces it
  // for free. Additive and monotone: an existing counter, verifying or not, is
  // left exactly as it is. See establishOverrideMintCounter.
  //
  // THIS RETURN DECIDES NOTHING and is kept for its cost, not its safety — said
  // plainly because a mutation experiment reported it as an unpinned guard and
  // the next one will too. `establishOverrideMintCounter` fails for exactly two
  // states, `unreadable` and not-`writable`, and both of them also make the
  // append at the bottom of this function throw, so removing this line changes
  // no outcome (measured: the whole override suite, including the three-wreck
  // test written for it, stays green). What it saves is a MAC and a re-read of
  // every stored entry on a path that cannot succeed. The observation that DOES
  // decide something is four lines down.
  if (!establishOverrideMintCounter(input.projectRoot, input.fingerprint.vouchableMints, env)) {
    return { ok: false, reason: 'write-failed' };
  }
  const counter = readOverrideMintCounter(input.projectRoot, env);
  // OBSERVED, like the mint's own bump: `establishOverrideMintCounter` reports
  // that its write did not throw, and a write that does not throw is not a
  // write that landed. `absent` here can only mean the pin did not take, and an
  // acknowledgement that pins `absent` pins nothing — deleting this project's
  // one counter key reproduces that state for free, which is the residual the
  // pin exists to close.
  if (counter.state === 'absent') return { ok: false, reason: 'write-failed' };
  const projectKey = projectRootHash(input.projectRoot);
  const unsigned = {
    ...input.fingerprint,
    v: OVERRIDE_RECONCILIATION_VERSION,
    projectKey,
    reconciledAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    issuedByUser: safeUser(),
    issuedByHostname: safeHostname(),
    issuedByPid: process.pid,
    // The counter AS PINNED a few lines above, not as the caller observed it —
    // those differ by exactly the entry this call just created, and an
    // acknowledgement that described the older reading would forgive nothing.
    counterState: counter.state,
    counterCount: counter.count ?? -1,
    quarantinedRunsDigest: sidecar.digest,
  };
  const stored = {
    ...unsigned,
    mac: overrideMac(unsigned, key, OVERRIDE_RECONCILIATION_MAC_DOMAIN),
  };
  const entry = {
    ...stored,
    quarantinedRuns: [...input.quarantinedRuns].sort(),
  } as OverrideReconciliation;
  try {
    updateOneSettings({
      [OVERRIDE_RECONCILE_SECTION]: {
        [projectKey]: [...storedEntries(projectKey, env), stored],
      },
    }, env);
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
  return { ok: true, entry };
}

/** An id for the operator to quote back when reporting what they reconciled.
 *  Derived from the signature, so it names one exact acknowledgement. */
export function reconciliationRef(entry: OverrideReconciliation): string {
  return crypto.createHash('sha256').update(entry.mac).digest('hex').slice(0, 12);
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
