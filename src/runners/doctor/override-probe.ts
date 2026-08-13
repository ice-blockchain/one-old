// src/runners/doctor/override-probe.ts
// What the operator-override ledger says about this project, for the doctor
// report. Read-only, like every other probe here.
//
// This exists because several of the primitive's states are otherwise
// INVISIBLE: a token whose MAC does not verify is ignored by the gates
// (correct) and would therefore be silently ignored forever (not correct — that
// is the exact signal that says either the key was rotated or something wrote
// the ledger that had no business writing it); and a run made permanently
// ineligible for verified/shipped by a mint has no in-project marker to
// discover, by design, so doctor is the one place it can be surfaced.
//
// The completeness fields below exist for a sharper version of the same
// problem. After `rm overrides.jsonl` this probe reported `active=0
// unvouchable=0 runMinted=0` — a clean install, indistinguishable from a project
// that never minted anything, printed by the one tool an operator runs when they
// suspect something is wrong.
//
// PRODUCING those fields was never enough, and for one release it was all that
// happened: the probe returned `ledger`, `orphanSnapshots`, `mintCounter` and
// `discrepancies`, findings.ts read none of them, doctor's stdout carried no
// `overrides` key at all, and the bundle had no override section — so after
// mint-then-delete the report still said `summary: HEALTHY` while settlement
// refused the run. A refusal the operator cannot see is half a control. Every
// field here is now read by buildFindings and printed by runners/doctor/index.ts
// and bundle.ts, which is what makes "the report and the refusal cannot describe
// different machines" a fact about the product rather than about this function.

import {
  overrideEvidenceReport,
  readOverrideLedgerResult,
  runOverrideRecords,
  type OverrideEntry,
  type OverrideLedgerKind,
  type OverrideMintCounterState,
} from '../../shared/override';
import { doctorShimCommand } from '../../shared/doctor-command';

export interface OverrideProbe {
  /** Unexpired tokens for this project, whatever run they name. */
  readonly active: { readonly id: string; readonly target: string; readonly runId: string; readonly expiresAt: string }[];
  /** Lines this install cannot vouch for: bad MAC, wrong project, unparseable. */
  readonly unvouchable: number;
  /** The two halves of `unvouchable`, split because they are different stories
   *  and the report told the wrong one. `forged` is a line that parsed as a token
   *  and whose MAC does not verify — a rotated key, or something signing with the
   *  wrong secret. `malformed` is a line that is not a token at all, which is what
   *  junk written into the ledger looks like and has nothing to do with any key. */
  readonly forgedLines: number;
  readonly malformedLines: number;
  /** Overrides minted for the run doctor is reporting on, TTL ignored — the
   *  abuse guard's own input, so the report and settlement agree. */
  readonly runMinted: number;
  /** How the ledger read went. Anything but `ok`/`absent` means the lines above
   *  are not a complete account of what was minted. */
  readonly ledger: OverrideLedgerKind;
  /** Vouchable lines minus the DISTINCT mints they attest to. Non-zero means
   *  the same signed line appears more than once, which no honest mint
   *  produces — the copies count once (shared/override/token.ts), so this
   *  changes no verdict and is reported because nothing else would say it. */
  readonly duplicateLines: number;
  /** Pre-override snapshots no vouchable ledger line accounts for — the residue
   *  a deleted or edited line leaves behind. `null` when the completeness read
   *  failed: reporting the clean-install `0` there is the exact failure this
   *  probe exists to stop. */
  readonly orphanSnapshots: number | null;
  /** The signed per-project mint counter in the machine-owned one.json, or
   *  'unknown' when it could not be read at all. */
  readonly mintCounter: OverrideMintCounterState | 'unknown';
  /** The number it carries, and the distinct mints still visible in the ledger.
   *  Reported as a PAIR because the pair is the finding: a counter ahead of the
   *  lines is the only evidence left after the bucket is deleted, and printing
   *  the state word alone said `verified` for a counter three erasures ahead. */
  readonly mintCounterCount: number | null;
  readonly vouchableMints: number | null;
  /** Whether the envelope holding the counter would accept a write, judged from
   *  its CONTENTS alone — `schemaVersion: 99`, a non-object, unparseable bytes.
   *  False means the counter can never advance again while every read of it
   *  still reports a healthy, signed number, which is worth a finding of its
   *  own.
   *
   *  TRUE IS NOT A PROMISE, and the docblock here used to make one: this is not
   *  how an operator finds out beforehand, it is how they find out about the
   *  freezes that live in the bytes. WRITABILITY IS NOT COUNTABILITY. Both
   *  freezes measured in mint-counter.ts's header — a lock owner naming a pid
   *  this process may not signal, and an unwritable parent directory — leave
   *  this field `true` while every settings write throws, and a write that
   *  lands somewhere the next reader does not look leaves it `true` while
   *  nothing throws at all. Those are caught at the mint, by the OBSERVED bump,
   *  and the operator learns about them from the refusal rather than from here.
   *  Nothing refuses certification on any of it (mint-counter.ts says why). */
  readonly mintCounterWritable: boolean | null;
  /** Whether the orphan scan was ASKED. False means an illegible ledger switched
   *  that witness off — the operator is reading a report with a blindfold in it,
   *  which is worth saying out loud rather than leaving as a `0`. */
  readonly snapshotScanAsked: boolean | null;
  /** Operator reconciliations on record, and how many findings one of them is
   *  currently accounting for (shared/override/reconcile.ts). */
  readonly reconciliations: number;
  readonly excused: string[];
  /** The exact check ids settlement refuses `verified` with, or empty. Named so
   *  the report can say WHICH witness disagrees rather than that one does.
   *  Plus the one id below, which is this probe's alone. */
  readonly discrepancies: string[];
  /** The command that repairs a `discrepancies` state, runnable as printed.
   *  Carried on the probe rather than interpolated in findings.ts so the
   *  printed spelling comes from the one authority for it (doctor-command.ts)
   *  and findings.ts stays free of path resolution. */
  readonly repairCommand: string;
}

/**
 * Reported when the completeness read itself failed — a probe-only id, never
 * one settlement refuses with. The alternative is the failure mode this whole
 * lane is about: a report that could not look, printing the clean install.
 */
export const OVERRIDE_EVIDENCE_UNAVAILABLE = 'override-evidence-unavailable';

/** The repair's flag, and the one place it is spelled. Deliberately NOT in the
 *  gate-exemption grammar (shared/tool-classify.ts), which admits no flag it
 *  does not enumerate: like `--unblock`, this one writes, so an agent's tool
 *  call carrying it inherits no exemption. */
export const OVERRIDE_RECONCILE_FLAG = '--reconcile-overrides';

/** The repair command, runnable as printed. */
export function overrideReconcileCommand(): string {
  return `${doctorShimCommand()} ${OVERRIDE_RECONCILE_FLAG}`;
}

function clean(): OverrideProbe {
  return {
    active: [], unvouchable: 0, forgedLines: 0, malformedLines: 0, runMinted: 0, ledger: 'absent',
    duplicateLines: 0, orphanSnapshots: null, mintCounter: 'unknown', mintCounterCount: null,
    vouchableMints: null, mintCounterWritable: null, snapshotScanAsked: null, reconciliations: 0,
    excused: [], discrepancies: [], repairCommand: overrideReconcileCommand(),
  };
}

export function probeOverrides(projectRoot: string, runId: string | null): OverrideProbe {
  let entries: OverrideEntry[] = [];
  let ledger: OverrideLedgerKind = 'absent';
  try {
    const read = readOverrideLedgerResult(projectRoot);
    entries = read.entries;
    ledger = read.kind;
  } catch {
    // A doctor that throws on a corrupt audit file is a doctor nobody can run
    // during the incident the audit file is about — but it must not answer with
    // the clean install either. Every completeness field stays at its "we could
    // not look" value; only `ledger` is a guess, and it is the one field this
    // arm has no reading of at all.
    return { ...clean(), discrepancies: [OVERRIDE_EVIDENCE_UNAVAILABLE] };
  }
  // Separately guarded: this one lists a directory and reads the machine
  // settings envelope, so it has failure modes the ledger read does not, and
  // losing the completeness report must not cost the report its live tokens.
  let evidence;
  try {
    evidence = overrideEvidenceReport(projectRoot);
  } catch {
    evidence = null;
  }
  return {
    active: entries
      .filter((entry) => entry.outcome === 'valid' && entry.token)
      .map((entry) => ({
        id: entry.token!.id,
        target: entry.token!.target,
        runId: entry.token!.runId,
        expiresAt: entry.token!.expiresAt,
      })),
    unvouchable: entries.filter((entry) => entry.outcome === 'forged' || entry.outcome === 'malformed').length,
    forgedLines: entries.filter((entry) => entry.outcome === 'forged').length,
    malformedLines: entries.filter((entry) => entry.outcome === 'malformed').length,
    runMinted: runId ? runOverrideRecords(projectRoot, runId).length : 0,
    ledger,
    duplicateLines: evidence ? evidence.vouchableLines - evidence.vouchableMints : 0,
    // `null`/'unknown' rather than the clean-install values: two fields lying so
    // a third can be honest is the same defect one layer down.
    orphanSnapshots: evidence?.orphanSnapshots.length ?? null,
    mintCounter: evidence?.mintCounter.state ?? 'unknown',
    mintCounterCount: evidence?.mintCounter.count ?? null,
    vouchableMints: evidence?.vouchableMints ?? null,
    mintCounterWritable: evidence?.mintCounter.writable ?? null,
    snapshotScanAsked: evidence?.snapshotScanAsked ?? null,
    reconciliations: evidence?.reconciliations ?? 0,
    excused: evidence?.excused ?? [],
    discrepancies: evidence ? evidence.checks : [OVERRIDE_EVIDENCE_UNAVAILABLE],
    repairCommand: overrideReconcileCommand(),
  };
}
