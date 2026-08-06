// src/runners/doctor/override-probe.ts
// What the operator-override ledger says about this project, for the doctor
// report. Read-only, like every other probe here.
//
// This exists because two of the primitive's states are otherwise INVISIBLE:
// a token whose MAC does not verify is ignored by the gates (correct) and would
// therefore be silently ignored forever (not correct — that is the exact signal
// that says either the key was rotated or something wrote the ledger that had
// no business writing it); and a run made permanently ineligible for
// verified/shipped by a mint has no in-project marker to discover, by design,
// so doctor is the one place it can be surfaced.

import {
  readOverrideLedger,
  runOverrideRecords,
  type OverrideEntry,
} from '../../shared/override';

export interface OverrideProbe {
  /** Unexpired tokens for this project, whatever run they name. */
  readonly active: { readonly id: string; readonly target: string; readonly runId: string; readonly expiresAt: string }[];
  /** Lines this install cannot vouch for: bad MAC, wrong project, unparseable. */
  readonly unvouchable: number;
  /** Overrides minted for the run doctor is reporting on, TTL ignored — the
   *  abuse guard's own input, so the report and settlement agree. */
  readonly runMinted: number;
}

export function probeOverrides(projectRoot: string, runId: string | null): OverrideProbe {
  let entries: OverrideEntry[] = [];
  try {
    entries = readOverrideLedger(projectRoot);
  } catch {
    // A doctor that throws on a corrupt audit file is a doctor nobody can run
    // during the incident the audit file is about.
    return { active: [], unvouchable: 0, runMinted: 0 };
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
    runMinted: runId ? runOverrideRecords(projectRoot, runId).length : 0,
  };
}
