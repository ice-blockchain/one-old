// src/shared/override/integrity.ts
// One question, asked in one place: is this project's override record COMPLETE
// enough to certify a run against?
//
// ── The attack this answers ──────────────────────────────────────────────────
// The abuse guard (runUsedOperatorOverride) is correct and was never the weak
// half. It reads the ledger, finds the minted line, and holds the run at
// `validating`. What broke was the step after: `rm ~/.traffic-one/overrides/
// <projectKey>/overrides.jsonl` erased the only witness, the guard then read a
// clean install, and the run settled `verified` with `reason=none`. Nothing
// refused the delete — it is a file outside the project tree, and neither the
// boundary guard nor the authoring guard has an opinion about it.
//
// So the guard cannot be the only reader of that file. Three more witnesses,
// each surviving a different erasure, and all three consulted here so that
// settlement and the doctor report cannot drift into disagreeing:
//
//   1. LEGIBILITY (token.ts). "The file is not there" is a complete answer;
//      "I could not read the file" is not, and used to arrive as the same empty
//      array. An illegible ledger now refuses certification.
//   2. ORPHANED SNAPSHOTS (snapshots.ts). The snapshot is written BEFORE the
//      ledger line and survives the delete. A snapshot no vouchable line
//      accounts for is the erasure's own footprint.
//   3. THE MINT COUNTER (mint-counter.ts). Signed, monotone, and kept in the
//      machine-owned one.json, which is the only one of the three that survives
//      `rm -rf` of the whole bucket.
//
// ── Everything here is PROJECT-scoped, deliberately ──────────────────────────
// None of the three can be attributed to a run. A deleted line took its runId
// with it; a snapshot's runId is unsigned, so the edit that orphaned it can
// also point it at a run nobody is settling; the counter counts mints, not
// runs. Narrowing any of them by an attacker-chosen field would let the same
// edit that hid the mint also choose which run escapes. So a project whose
// override record is incomplete cannot certify ANY run until an operator
// RECONCILES it — a signed acknowledgement of the exact state, which quarantines
// every run that already existed (reconcile.ts). That is the intended price of
// erasing an audit trail, and it is why every check below is gated on `verified`
// and touches nothing else about the run.
//
// ── What is NOT closed, MEASURED rather than assumed ─────────────────────────
// The three witnesses close ledger-only and bucket-only erasure. They do not
// close these, and the price of each is lower than this file used to claim
// (it named `rm -rf ~/.traffic-one`, key included, which is far more than an
// attacker has to spend):
//
//   1. `rm -rf overrides/<projectKey>` PLUS deleting this project's single key
//      from `overrideMints` in one.json. Clean verdict. The install key, the
//      auth record and every other project survive. Not closable here FOR A
//      PROJECT THAT WAS NEVER RECONCILED: an absent counter entry is exactly
//      what an install that never minted looks like, and refusing on it would
//      fail every clean install in the world.
//      NARROWED, and the narrowing is measured rather than argued. A project
//      that HAS been reconciled carries a signed statement, in the same
//      envelope, that a counter entry existed and what it read — so the absent
//      counter is no longer indistinguishable from a clean install, it is a
//      contradiction inside one file. See
//      OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK. What remains open is
//      this row PLUS deleting the acknowledgement itself, which is one more key
//      in the same file and reaches a genuine clean install; reconcile.ts's
//      ruling on expiry turns on exactly that residual and states it as its
//      premise.
//   2. The same `rm -rf` plus ONE appended byte in one.json, because an
//      unparseable envelope reads as absent (mint-counter.ts states why that
//      fold survives re-examination — it is not the circular argument it was).
//   3. Restoring a copy of one.json taken before a mint, with that mint's line
//      and snapshot deleted. The counter is signed but not FRESH; nothing binds
//      it to a moment, so rolling the whole envelope back rolls it back too.
//      Out of scope here rather than closed: a rollback of a file this layer
//      does not own needs an anchor off the machine, which this product has
//      none of. See mint-counter.ts.
//   4. Pointing `XDG_STATE_HOME` at a copy of the machine dir with the bucket
//      removed. NO deletion at all — the real evidence stays on disk while
//      every witness here reads an empty store. This predates the completeness
//      checks and defeats the abuse guard identically; it is a property of
//      settlement trusting the environment that names its machine dir, and
//      relocating that trust root is a separate change with a blast radius
//      across every consumer of the directory. Named here so it can be
//      scheduled, and NOT claimed to be closed anywhere in this feature's prose.
//
//   5. Settling under a different CASE-spelling of the project directory. The
//      bucket is named by `projectRootHash`, which realpaths but does not
//      case-fold, so on a case-insensitive filesystem `/x/Proj` and `/x/proj`
//      are ONE directory with TWO override ledgers, and the second one is empty.
//      Nothing deleted, no env var, no key — strictly cheaper than 4, and
//      cheaper than 1 and 2. Honestly documented at its source (see
//      local-prefs/prefs-store.ts's projectRootHash and paths.ts, both of which
//      now state the REAL cost of the one-line fold: it relocates the live
//      bucket of anyone who has always used the miscased spelling, taking the
//      ledger and the counter with it, which is the erasure this file exists to
//      detect, shipped as an upgrade. The cost is NOT the one those notes used
//      to claim — measured, the canonical spelling hashes identically under
//      `realpathSync.native`, so tokens already in operators' hands do not move)
//      and listed HERE because this list, not those notes, is what a reviewer
//      reads.
//      REACHABILITY IS NARROWER than every other row and the probe is named
//      rather than summarised: the obvious route — an agent `cd`-ing to a
//      miscased spelling so settlement inherits it — was REFUTED, because
//      `process.cwd()` on this platform reports the canonicalised case whatever
//      spelling was used to enter the directory, so the hash lands in the true
//      bucket. What was found instead is one adjacent place where a project root
//      arrives as an untrusted argv string and is only `path.resolve`d:
//      `--project-root` in runners/qa-evidence/cli.ts. That runner publishes QA
//      reports and does not settle, so it is not a bypass of this list; it is
//      the shape that would be one if a settlement entry point ever took the
//      same argument.
//   6. The run quarantine a reconciliation imposes is a list of run directory
//      NAMES, and that map is writable by anyone who can write the project:
//      `mv runs/R runs/R2` (or `cp -r`) gives the same working tree a run id the
//      signed list does not hold. MEASURED at the real settlement writer, both
//      halves: the copy ALONE — every artifact byte for byte, run ids re-pointed
//      inside them — is REFUSED (`verification-contract-missing-or-invalid`,
//      `qa-verification-incomplete`), because the contract's hash covers its own
//      runId and the QA report binds to that hash. What certifies the new id is
//      fabricated evidence written for it, and that same fabrication certifies
//      any run id in any project with no override, no reconciliation and no
//      quarantine anywhere in the picture. So this row is a residual of the
//      product's evidence-forgery floor, not of the quarantine's keying, and
//      keying the quarantine on something else inside a tree the attacker writes
//      would move which field they edit without raising that floor. That an
//      override taints the RUN and not the tree is this feature's deliberate
//      boundary; the quarantine cannot be narrower than it.
//
//   7. THE ESCAPE HATCH ITSELF, denied per run. `doctor --unblock` refuses a run
//      whose canonical settlement reads `verified`, and `settlementHash` is an
//      unkeyed digest over a file inside the project tree — so anything that can
//      write that tree can WRITE a `verified` settlement (twenty lines,
//      MEASURED) and lock the operator out of minting an override for that run,
//      repeatedly, for each new run. Not a way to reach a green verdict, and not
//      new: it is the same evidence-forgery floor as row 6, reached from the
//      other side. What IS new is the consequence — this feature widened that
//      floor from "forge a verdict" to "forge a verdict and disable recovery" —
//      so it is carried here rather than left implied. The remedy is a fresh
//      run, which costs a session restart and can be denied again; the refusal
//      therefore names the suspicion and how to check the record
//      (runners/doctor/unblock.ts). Raising it needs a signature over the
//      settlement, which is a change to the settlement format, not to this
//      feature.
//
//   …and, underneath all seven, `rm -rf ~/.traffic-one` — key included. That one
//   really is unclosable at this layer: afterwards there is no evidence and no
//   key to have signed any, and the key is the whole trust model.

import {
  overrideLedgerDigest,
  overrideLedgerIllegible,
  readOverrideLedgerResult,
  vouchableMintIds,
  vouchableOverrideEntries,
  type OverrideEntry,
  type OverrideLedgerKind,
} from './token';
import { readOverrideMintCounter, type OverrideMintCounterRead } from './mint-counter';
import { readOverrideReconciliations, type OverrideAcknowledgement } from './reconcile';
import {
  OVERRIDE_SNAPSHOT_SCAN_NOT_ASKED,
  orphanSnapshotSetDigest,
  overrideSnapshotNameDigest,
  scanOrphanSnapshots,
  type OrphanSnapshot,
  type OverrideSnapshotScan,
} from './snapshots';

/**
 * The named refusals, in the precedence a `reason` is chosen by: most
 * fundamental first. `override-ledger-illegible` leads because when it fires
 * the other two are answering questions about bytes nobody could read.
 */
export const OVERRIDE_LEDGER_ILLEGIBLE_CHECK = 'override-ledger-illegible';
export const OVERRIDE_SNAPSHOT_ORPHANED_CHECK = 'override-snapshot-orphaned';
export const OVERRIDE_SNAPSHOT_SCAN_INCOMPLETE_CHECK = 'override-snapshot-scan-incomplete';
export const OVERRIDE_MINT_COUNT_MISMATCH_CHECK = 'override-mint-count-mismatch';
export const OVERRIDE_MINT_COUNTER_UNVERIFIABLE_CHECK = 'override-mint-counter-unverifiable';
/**
 * A verified acknowledgement pinned a counter this project no longer has, or
 * has walked back under. The one check here that reads an acknowledgement as
 * EVIDENCE rather than as forgiveness.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 * MEASURED, from a project reconciled after three mints, with the
 * acknowledgement pinning `verified/3`: `rm -rf` the bucket AND delete this
 * project's one key from `overrideMints`, and every witness reads
 * `absent/absent/0` while the signed statement that the counter stood at 3 is
 * still sitting in the same file. Certification came back CLEAR, because
 * nothing compared the two. Both values were already in hand — one read of
 * `one.json` produces both.
 *
 * ── Why the comparison is sound, and not a policy call ───────────────────────
 * The acknowledgement and the counter live in the SAME envelope, and
 * `recordOverrideReconciliation` refuses to sign an acknowledgement whose
 * counter did not get pinned — so a verified acknowledgement is proof that this
 * project had a counter entry in this file. An honest operation never removes
 * one and leaves the other: nothing in the product deletes an `overrideMints`
 * key (`deleteOneSection` reaches `auth` and `codeGraphProvider` only, and
 * `mergeRawSettings` merges that section key by key and never removes), and the
 * routes that lose the envelope lose BOTH — an unparseable `one.json` reads as
 * no acknowledgements at all, and a rotated or absent key makes the
 * acknowledgement unverifiable, at which point it forgives nothing and accuses
 * nobody either. So this is not "an honest reading that looks guilty"; it is one
 * file contradicting itself.
 *
 * ── And it is a table now, not an argument ───────────────────────────────────
 * That paragraph was spread across this constant and `counterContradicts`, and
 * an argument spread across two docblocks is re-litigated every round.
 * __tests__/innocent-states-table.test.ts DRIVES each innocent state end to end
 * through this reader — a partial append, a truncation, a merge conflict, valid
 * JSON in the wrong shape, an unparseable `one.json`, a rotated key and an
 * absent key — and records what each one actually reads, with the counter-key
 * deletion beside it as the GUILTY control so the rows cannot be satisfied by a
 * check that never fires. The four ledger states leave the counter `verified`
 * and this check silent; the envelope and key states take the acknowledgement
 * out of the verified set entirely, so there is no pin left to contradict.
 */
export const OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK = 'override-acknowledged-counter-contradicted';

export interface OverrideEvidenceReport {
  /** Empty means the record accounts for itself. Precedence-ordered. */
  readonly checks: string[];
  readonly ledger: OverrideLedgerKind;
  /** Vouchable LINES. Kept beside the mint count below because the two
   *  disagreeing is the duplicate-line signal an operator wants to see. */
  readonly vouchableLines: number;
  /** DISTINCT vouchable mints — what the counter is measured against. */
  readonly vouchableMints: number;
  readonly orphanSnapshots: OrphanSnapshot[];
  readonly snapshotScanComplete: boolean;
  /** Whether the snapshot directory was looked at at all. False on an illegible
   *  ledger, where the scan is deliberately skipped. */
  readonly snapshotScanAsked: boolean;
  readonly snapshotCount: number;
  readonly mintCounter: OverrideMintCounterRead;
  /** Operator reconciliations on record (reconcile.ts), and how many of the
   *  findings above one of them is currently accounting for. */
  readonly reconciliations: number;
  readonly unverifiableReconciliations: number;
  readonly excused: string[];
}

/**
 * COST, measured on the overwhelmingly common path (a project that never minted
 * an override, with a `one.json` present): seven filesystem calls and no file
 * over a few hundred bytes — a `stat` of the ledger that ENOENTs, a `readdir` of
 * the snapshots directory that ENOENTs, three `realpath`s behind
 * `projectRootHash`, and two reads of `one.json`, one for the counter and one
 * for the reconciliations. There IS a directory enumeration in there; it simply
 * never enumerates anything on a clean install. The per-install key is NOT read
 * on this path: with no ledger line and no reconciliation, there is nothing a
 * key could verify. Nothing here hashes anything unless an anomaly and a
 * reconciliation both exist.
 */
export function overrideEvidenceReport(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideEvidenceReport {
  const observed = observe(projectRoot, env);
  const reconciled = readOverrideReconciliations(projectRoot, env);
  const verdict = judge(observed, reconciled.entries);
  return {
    ...verdict,
    ledger: observed.ledgerKind,
    vouchableLines: observed.vouchable.length,
    vouchableMints: observed.mints.size,
    orphanSnapshots: observed.snapshots.orphans,
    snapshotScanComplete: observed.snapshots.complete,
    snapshotScanAsked: observed.snapshots.asked,
    snapshotCount: observed.snapshots.count,
    mintCounter: observed.mintCounter,
    reconciliations: reconciled.entries.length,
    unverifiableReconciliations: reconciled.unverifiable,
  };
}

/**
 * The acknowledgement the doctor's repair is ABOUT to sign, and — before it
 * signs anything — which of the current findings it would actually forgive.
 *
 * The second half is the guard. `recordOverrideReconciliation` quarantines every
 * run in the project permanently, so an acknowledgement that forgives nothing is
 * not a no-op, it is the whole bill for none of the goods: MEASURED on an
 * `unreadable` ledger and on an orphan whose file cannot be read, where the
 * fingerprint is '' by construction, the repair printed `Reconciled: …`, burned
 * every run on disk, changed no verdict, and could be run again to burn the next
 * batch. The caller refuses when `unforgiven` is non-empty, which is also how
 * SUPPORT.md's standing promise — that the repair declines a ledger that is
 * merely unreadable, since fixing the permissions loses nothing — becomes true.
 *
 * Asked through the same predicates the settlement path uses, not a second
 * transcription of them: whatever `judge` would refuse to forgive tomorrow is
 * what this refuses to charge for today.
 */
export function overrideReconciliationDraft(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): OverrideReconciliationDraft {
  const observed = observe(projectRoot, env);
  const fingerprint: OverrideAcknowledgement = {
    ledgerKind: observed.ledgerKind,
    // Only an illegible ledger is acknowledged BY ITS BYTES; a legible one is
    // accounted for by the lines themselves.
    ledgerDigest: observed.illegible ? observed.ledgerDigest() : '',
    suppressedSnapshotDigest: observed.illegible ? observed.suppressedSnapshotDigest() : '',
    orphanDigest: observed.orphanDigest(),
    orphanCount: observed.snapshots.orphans.length,
    snapshotCount: observed.snapshots.count,
    snapshotScanComplete: observed.snapshots.complete,
    counterState: observed.mintCounter.state,
    counterCount: observed.mintCounter.count ?? -1,
    vouchableMints: observed.mints.size,
  };
  // The findings are computed against the acknowledgements ALREADY ON RECORD —
  // one of the checks is a disagreement with them — while forgiveness is
  // evaluated against the entry this repair would write, and only that one.
  // Asking the stored set both questions would let an earlier acknowledgement
  // excuse a finding this repair does not actually cover.
  const findings = failingChecks(observed, readOverrideReconciliations(projectRoot, env).entries);
  const forgives = findings.filter((id) => excusedBy(observed, id, [fingerprint]));
  return {
    fingerprint,
    forgives,
    unforgiven: findings.filter((id) => !forgives.includes(id)),
  };
}

/**
 * The refusals alone. Called by run-settlement/io.ts on the `verified` path and
 * nowhere else — GATES must not consult this. An illegible ledger yields no
 * honourable token either way, so denying tool calls over one would convert a
 * bookkeeping fault into an outage while relaxing nothing.
 */
export function overrideEvidenceChecks(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return overrideEvidenceReport(projectRoot, env).checks;
}

/** The snapshot FILE NAMES a ledger line accounts for: the one it records, and
 *  the one its token id implies. Both spellings are the same string for every
 *  line token.ts has ever written; the second is kept so a line whose `snapshot`
 *  field was blanked still accounts for the file it names by id. Matched
 *  exactly, never by prefix — see scanOrphanSnapshots. */
function namedSnapshots(entries: readonly OverrideEntry[]): Set<string> {
  const named = new Set<string>();
  for (const entry of entries) {
    if (!entry.token) continue;
    named.add(`${entry.token.id}.json`);
    if (entry.token.snapshot) named.add(entry.token.snapshot);
  }
  return named;
}

// ── the one observation, and the one judgement over it ───────────────────────

export interface OverrideReconciliationDraft {
  /** What the acknowledgement would say. */
  readonly fingerprint: OverrideAcknowledgement;
  /** Current findings this fingerprint would account for. */
  readonly forgives: string[];
  /** Current findings it would NOT — non-empty means REFUSE, do not write. */
  readonly unforgiven: string[];
}

interface Observation {
  readonly illegible: boolean;
  readonly ledgerKind: OverrideLedgerKind;
  readonly vouchable: OverrideEntry[];
  readonly mints: Set<string>;
  readonly snapshots: OverrideSnapshotScan;
  readonly mintCounter: OverrideMintCounterRead;
  /** Counter minus the distinct mints still visible, or 0 when either is not a
   *  trustworthy number. Positive means lines went missing. */
  readonly deficit: number;
  /** Memoized: nothing here is hashed unless a finding and an acknowledgement
   *  both exist, which on the overwhelmingly common path is never. */
  readonly ledgerDigest: () => string;
  readonly orphanDigest: () => string;
  readonly suppressedSnapshotDigest: () => string;
}

function memo(compute: () => string): () => string {
  let cached: string | null = null;
  return () => {
    if (cached === null) cached = compute();
    return cached;
  };
}

function observe(projectRoot: string, env: NodeJS.ProcessEnv): Observation {
  const ledger = readOverrideLedgerResult(projectRoot, env);
  const illegible = overrideLedgerIllegible(ledger.kind);
  const mints = vouchableMintIds(ledger.entries);
  // Skipped when the ledger is illegible: with no trustworthy list of what the
  // lines name, every snapshot looks orphaned and the finding would be an echo
  // of the check above rather than a second witness. The substitute says "not
  // asked" rather than dressing up as a completed scan — and what an
  // acknowledgement of that state must pin instead is
  // `suppressedSnapshotDigest`, because "not asked" is a witness switched off.
  const snapshots = illegible
    ? OVERRIDE_SNAPSHOT_SCAN_NOT_ASKED
    : scanOrphanSnapshots(projectRoot, namedSnapshots(vouchableOverrideEntries(ledger.entries)), env);
  const mintCounter = readOverrideMintCounter(projectRoot, env);
  return {
    illegible,
    ledgerKind: ledger.kind,
    vouchable: vouchableOverrideEntries(ledger.entries),
    mints,
    snapshots,
    mintCounter,
    deficit: mintCounter.state === 'verified' && mintCounter.count !== null
      ? mintCounter.count - mints.size
      : 0,
    ledgerDigest: memo(() => overrideLedgerDigest(projectRoot, env)),
    orphanDigest: memo(() => orphanSnapshotSetDigest(projectRoot, snapshots.orphans, env)),
    suppressedSnapshotDigest: memo(() => overrideSnapshotNameDigest(projectRoot, env)),
  };
}

/**
 * Every check that is FAILING, in the precedence a `reason` is chosen by.
 *
 * Acknowledgements are an input rather than only a filter over the output, for
 * one check and one only: `override-acknowledged-counter-contradicted` is a
 * disagreement BETWEEN a signed acknowledgement and the live counter, so there
 * is no observation of the project alone that could produce it. Every other
 * check here is a property of the record, and the acknowledgements are asked
 * about them afterwards, in `excusedBy`.
 */
function failingChecks(
  observed: Observation,
  acknowledgements: readonly OverrideAcknowledgement[],
): string[] {
  const failing: string[] = [];
  if (observed.illegible) failing.push(OVERRIDE_LEDGER_ILLEGIBLE_CHECK);
  if (observed.snapshots.orphans.length > 0) failing.push(OVERRIDE_SNAPSHOT_ORPHANED_CHECK);
  if (!observed.snapshots.complete) failing.push(OVERRIDE_SNAPSHOT_SCAN_INCOMPLETE_CHECK);
  if (observed.mintCounter.state === 'unverifiable') failing.push(OVERRIDE_MINT_COUNTER_UNVERIFIABLE_CHECK);
  // Ahead of the deficit check below because it fires exactly where the deficit
  // check has been SILENCED: deleting the counter key takes the deficit to zero,
  // which is why that route was the cheapest documented residual.
  if (acknowledgements.some((entry) => counterContradicts(entry, observed.mintCounter))) {
    failing.push(OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK);
  }
  // Strictly greater: a counter equal to the visible mints is the healthy
  // steady state after every mint, and one BEHIND them only means a bookkeeping
  // write was refused at some point — neither is evidence of an erasure, and
  // treating either as one would fail projects that did nothing wrong.
  //
  // Compared against DISTINCT mints, not lines: two copies of one signed line
  // are one mint, and counting them twice made a deleted line free (token.ts's
  // vouchableMintIds).
  //
  // Skipped on an illegible ledger because the mint count is then zero (nothing
  // could be counted), so every counter would "exceed" it and the finding would
  // restate the check above instead of corroborating it. That suppression is
  // exactly why an acknowledgement of an illegible ledger has to pin the
  // counter's own state and value — see excusedBy.
  //
  // KNOWN TRANSIENT: the ledger and the counter are read a few lines apart, so a
  // mint landing in between — in ANOTHER run of the same project, while this one
  // settles — is counted by the second read and not the first, and this check
  // fires on a project that did nothing wrong. Recoverable rather than harmless:
  // `validating` is not terminal, so the next settlement of that run reads a
  // consistent pair and certifies. Not locked, because taking the machine-dir
  // lock on every certification to narrow a window that resolves itself is the
  // more expensive mistake.
  if (!observed.illegible && observed.deficit > 0) failing.push(OVERRIDE_MINT_COUNT_MISMATCH_CHECK);
  return failing;
}

/**
 * Does this acknowledgement's pinned counter disagree with the live one?
 *
 * Two arms, and both are one-directional — a counter that has moved UP is the
 * healthy case, since every mint moves it up and an acknowledgement is a
 * statement about a floor, not about a value that must stay put.
 *
 *   1. THE PIN IS GONE. The acknowledgement recorded a counter entry that
 *      existed (`recordOverrideReconciliation` refuses to sign otherwise, so
 *      `absent` is not a state an acknowledgement can pin), and this project has
 *      no entry now. Somebody deleted the key.
 *   2. THE PIN WAS WALKED BACK. A verified counter now reads BELOW a number the
 *      operator signed for. `recordOverrideMint` is monotone per write, so
 *      nothing honest lowers it.
 *
 * Arm 2 catches only what a keyless attacker cannot reach anyway (lowering a
 * VERIFIED count needs a signature), and is kept because it costs one
 * comparison and it is where a partial envelope restore lands. Arm 1 is the one
 * that closes a measured hole. NEITHER survives an attacker with the install
 * key, and no claim here says otherwise — see reconcile.ts's floor.
 */
function counterContradicts(
  pin: OverrideAcknowledgement,
  live: OverrideMintCounterRead,
): boolean {
  if (pin.counterState === 'absent') return false;
  if (live.state === 'absent') return true;
  return pin.counterState === 'verified'
    && live.state === 'verified'
    && live.count !== null
    && live.count < pin.counterCount;
}

/**
 * Does any of these acknowledgements account for THIS finding, in THIS state?
 *
 * ── The rule every arm below obeys ───────────────────────────────────────────
 * An acknowledgement must fingerprint the witnesses the acknowledged state
 * SUPPRESSES, not only the one that fired. The `override-ledger-illegible` arm
 * is where that was learned, and the defect is worth stating because the shape
 * of it recurs: the arm used to compare the ledger's bytes and nothing else,
 * while the state it forgave switched off the snapshot scan AND the mint
 * comparison AND — because the abuse guard reads the same unparseable file — the
 * per-run record of who was overridden. MEASURED: plant a junk ledger with no
 * mint, no key and no counter, run the supported repair once, and from then on
 * mint an override, use it, and copy the acknowledged bytes back; two runs
 * settled `verified` with the counter at 2 against zero visible mints and no
 * finding at all. One signature over one blob forgave every future erasure the
 * project would ever contain, and the wedge that made the repair necessary was
 * the setup for it.
 */
function excusedBy(
  observed: Observation,
  id: string,
  acknowledgements: readonly OverrideAcknowledgement[],
): boolean {
  if (acknowledgements.length === 0) return false;
  switch (id) {
    case OVERRIDE_LEDGER_ILLEGIBLE_CHECK: {
      const ledger = observed.ledgerDigest();
      const snapshots = observed.suppressedSnapshotDigest();
      // An `unreadable` ledger cannot be fingerprinted at all, and neither can a
      // snapshot directory that refuses to be listed. Never forgiven, and — the
      // half that used to be missing — never CHARGED for either: the repair
      // refuses up front rather than quarantining every run for an
      // acknowledgement that cannot match (overrideReconciliationDraft). The
      // repair for both is making the file readable again, which loses nothing.
      if (!ledger || !snapshots) return false;
      return acknowledgements.some((entry) => entry.ledgerKind === observed.ledgerKind
        && entry.ledgerDigest === ledger
        // The snapshot file set as it was when the operator looked. A mint under
        // the blindfold writes a new snapshot, and the erasure that hides the
        // mint has to remove it again — either way this moves.
        && entry.suppressedSnapshotDigest === snapshots
        // And the counter EXACTLY, not by carried deficit: the deficit check is
        // not being asked in this state, so its input is what the
        // acknowledgement has to hold still. A mint bumps it, deleting this
        // project's counter key drops it to `absent`, and both are a mismatch.
        // reconcile.ts writes a counter when there is none, so `absent` here is
        // not a state an acknowledgement can be minted against.
        && entry.counterState === observed.mintCounter.state
        && entry.counterCount === (observed.mintCounter.count ?? -1));
    }
    case OVERRIDE_SNAPSHOT_ORPHANED_CHECK: {
      const digest = observed.orphanDigest();
      return digest !== '' && acknowledgements.some((entry) => entry.orphanDigest === digest);
    }
    case OVERRIDE_SNAPSHOT_SCAN_INCOMPLETE_CHECK:
      return acknowledgements.some((entry) => !entry.snapshotScanComplete
        && observed.snapshots.count <= entry.snapshotCount);
    case OVERRIDE_MINT_COUNTER_UNVERIFIABLE_CHECK:
      return acknowledgements.some((entry) => entry.counterState === 'unverifiable'
        && entry.counterCount === (observed.mintCounter.count ?? -1));
    case OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK:
      // ANY acknowledgement the live counter still honours clears it, which is
      // what keeps the repair from being a wedge: an operator who looks at the
      // loss and signs for it establishes a counter (mint-counter.ts's
      // `establishOverrideMintCounter`) and pins the number it came back at, so
      // the new entry is honoured while the old, higher pin is not — and every
      // later mint moves the counter further above the new pin rather than back
      // under it. Without this arm the second reconciliation would clear the
      // finding for exactly one reading and re-refuse on the next honest mint.
      //
      // It is not a way in: an acknowledgement is signed with the install key,
      // so an attacker who can add one has already lost this argument
      // elsewhere. What it does hand a KEY-HOLDING attacker is a cheaper
      // spelling of a capability they already have, and reconcile.ts's floor
      // section states that residual rather than pretending the MAC bounds it.
      return acknowledgements.some((entry) => !counterContradicts(entry, observed.mintCounter));
    case OVERRIDE_MINT_COUNT_MISMATCH_CHECK:
      // Carried forward, never zeroed: the acknowledged gap stays subtracted, so
      // a LATER erasure is still measured against the count the counter really
      // reached rather than against a reset baseline.
      return acknowledgements.some((entry) => entry.counterState === 'verified'
        && entry.counterCount >= 0
        && observed.deficit <= entry.counterCount - entry.vouchableMints);
    default:
      return false;
  }
}

function judge(
  observed: Observation,
  acknowledgements: readonly OverrideAcknowledgement[],
): { readonly checks: string[]; readonly excused: string[] } {
  const checks: string[] = [];
  const excused: string[] = [];
  for (const id of failingChecks(observed, acknowledgements)) {
    if (excusedBy(observed, id, acknowledgements)) excused.push(id); else checks.push(id);
  }
  return { checks, excused };
}
