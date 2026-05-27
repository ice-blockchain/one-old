'use strict';

const path = require('path');
const fs = require('fs');
const { validReportId } = require('./validReportId.cjs');
const {
  ONE_UID_FIELD,
  LEGACY_ID_FILE,
  readText,
  readProjectState,
  writeProjectState,
} = require('./_helpers.cjs');

function readReportIdState(cwd) {
  const state = readProjectState(cwd);
  if (state && typeof state === 'object') {
    const id = typeof state[ONE_UID_FIELD] === 'string' ? state[ONE_UID_FIELD].trim() : '';
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

module.exports = { readReportIdState };
