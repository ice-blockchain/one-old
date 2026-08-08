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
  /**
   * The id was minted in memory and is NOT on disk. Two causes, one channel:
   * `.one.json` could not be READ, so there was no base to patch it onto, or the
   * fenced writer DECLINED the path (a symlink at it, a resolved location
   * outside the project's state dir, or a project whose use-plugin question is
   * unanswered). Both leave nothing registered and nothing destroyed, which is
   * the only distinction this flag has to carry — and distinct from
   * `created: false` alone, which means somebody else's id IS registered.
   */
  unpersisted?: boolean;
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
    // A refused write must not carry that authorization: the id is nowhere, so
    // the worker it would spawn reads no id and the next hook mints again.
    if (!writeProjectState(cwd, state)) return { id, created: false, unpersisted: true };
    return { id, created: true };
  });
}

export function ensureReportId(cwd: string): MintedReportId {
  return createReportId(cwd);
}
