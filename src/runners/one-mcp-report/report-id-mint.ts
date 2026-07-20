// src/runners/one-mcp-report/report-id-mint.ts
// Mints (or reads) the persisted report id. The shared project-state lock also
// covers every canonical `.one.json` writer, so the durable winner cannot be
// erased by a stale whole-state rewrite after this transaction commits.

import { ONE_UID_FIELD } from '../../config/reporting';
import { withProjectStateLock } from '../../shared/state/project-state-lock';
import { readProjectState, writeProjectState } from './lib';
import { readReportIdState } from './readReportIdState';
import { uuidV7 } from './uuidV7';

export interface MintedReportId {
  id: string;
  created: boolean;
  invalid?: boolean;
}

export function createReportId(cwd: string): MintedReportId {
  return withProjectStateLock(cwd, () => {
    const existing = readReportIdState(cwd);
    if (existing) return existing as MintedReportId;
    const id = uuidV7();
    const state = readProjectState(cwd);
    state[ONE_UID_FIELD] = id;
    // Atomic write + fsync completes before the sole winner receives
    // `created: true`, which is the authorization to spawn the report worker.
    writeProjectState(cwd, state);
    return { id, created: true };
  });
}

export function ensureReportId(cwd: string): MintedReportId {
  return createReportId(cwd);
}
