// src/runners/one-mcp-report/readReportIdState.ts
// Reads the persisted report id from `.one.json` → one-uid. Pre-release file
// formats are intentionally not migrated.

import { ONE_UID_FIELD } from '../../config/reporting';
import { readProjectState } from './lib';
import { validReportId } from './validReportId';

export interface ReportIdState {
  id: string;
  created: false;
  invalid?: boolean;
}

function reportIdInState(state: Record<string, unknown>): ReportIdState | null {
  const raw = state[ONE_UID_FIELD];
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return null;
  return validReportId(id) ? { id, created: false } : { id, created: false, invalid: true };
}

export function readReportIdState(cwd: string): ReportIdState | null {
  return reportIdInState(readProjectState(cwd));
}
