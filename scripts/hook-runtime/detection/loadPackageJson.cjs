'use strict';

const path = require('path');

const { safeReadJson } = require('../state/state.cjs');

function loadPackageJson(cwd) {
  return safeReadJson(path.join(cwd, 'package.json'), {});
}

module.exports = { loadPackageJson };
