// src/runners/one-mcp-report/report-id-mint.ts
// Mints (or reads) the persisted report id. Ported 1:1 from createReportId /
// ensureReportId (one-mcp-report/_helpers.cjs). Kept separate from lib.ts to
// keep the import tree acyclic (readReportIdState imports lib).

import { ONE_UID_FIELD } from '../../config/reporting';
import { readProjectState, writeProjectState } from './lib';
import { readReportIdState, type ReportIdState } from './readReportIdState';
import { uuidV7 } from './uuidV7';

export interface MintedReportId {
  id: string;
  created: boolean;
  invalid?: boolean;
  migrated?: boolean;
}

export function createReportId(cwd: string): MintedReportId {
  const existing = readReportIdState(cwd);
  if (existing) return existing as MintedReportId;
  const id = uuidV7();
  const state = readProjectState(cwd);
  state[ONE_UID_FIELD] = id;
  writeProjectState(cwd, state);
  return { id, created: true };
}

export function ensureReportId(cwd: string): MintedReportId {
  return (readReportIdState(cwd) as ReportIdState | null) || createReportId(cwd);
}
