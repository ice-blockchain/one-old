'use strict';

const { spawnSync } = require('child_process');
const {
  ID_FILE,
} = require('./_helpers.cjs');

function stageReportId(cwd) {
  try {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: 2000,
    });
    if (inside.status !== 0) return false;
    const added = spawnSync('git', ['add', '--', ID_FILE], {
      cwd,
      encoding: 'utf8',
      stdio: 'ignore',
      timeout: 2000,
    });
    return added.status === 0;
  } catch {
    return false;
  }
}

module.exports = { stageReportId };
