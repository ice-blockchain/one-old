'use strict';

const path = require('path');
const { validReportId } = require('./validReportId.cjs');
const {
  ID_FILE,
  readText,
} = require('./_helpers.cjs');

function readReportIdState(cwd) {
  const idPath = path.join(cwd, ID_FILE);
  const existing = readText(idPath);
  if (existing !== null) {
    const id = existing.trim();
    return validReportId(id) ? { id, created: false } : { id, created: false, invalid: true };
  }
  return null;
}

module.exports = { readReportIdState };
