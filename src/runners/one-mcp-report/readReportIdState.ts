// src/runners/one-mcp-report/readReportIdState.ts
// Reads the persisted report id from `.one.json` → one-uid (migrating the legacy
// .one-mcp-id file once if present). Returns null when no id exists yet. Ported
// 1:1 from one-mcp-report/readReportIdState.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { LEGACY_ID_FILE, ONE_UID_FIELD } from '../../config/reporting';
import { readProjectState, readText, writeProjectState } from './lib';
import { validReportId } from './validReportId';

export interface ReportIdState {
  id: string;
  created: false;
  invalid?: boolean;
  migrated?: boolean;
}

export function readReportIdState(cwd: string): ReportIdState | null {
  const state = readProjectState(cwd);
  if (state && typeof state === 'object') {
    const raw = state[ONE_UID_FIELD];
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id) {
      return validReportId(id) ? { id, created: false } : { id, created: false, invalid: true };
    }
  }

  const idPath = path.join(cwd, LEGACY_ID_FILE);
  const existing = readText(idPath);
  if (existing !== null) {
    const id = existing.trim();
    if (validReportId(id)) {
      state[ONE_UID_FIELD] = id;
      writeProjectState(cwd, state);
      try {
        fs.rmSync(idPath, { force: true });
      } catch {
        // best-effort legacy cleanup
      }
      return { id, created: false, migrated: true };
    }
    return { id, created: false, invalid: true };
  }
  return null;
}
