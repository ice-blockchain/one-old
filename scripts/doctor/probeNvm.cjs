'use strict';

const fs = require('fs');
const path = require('path');

const runner = require('../gitnexus-runner.cjs');
const { safeRead } = require('./_helpers.cjs');

function probeNvm() {
  const home = process.env.HOME || '';
  const installed = runner.nvmPresent();
  if (!installed) return { installed: false };
  const nvmRoot = path.join(home, '.nvm');
  const defaultAlias = (safeRead(path.join(nvmRoot, 'alias', 'default')) || '').trim();
  let versions = [];
  try {
    versions = fs.readdirSync(path.join(nvmRoot, 'versions', 'node'))
      .filter((n) => /^v\d+\.\d+\.\d+$/.test(n))
      .sort();
  } catch { /* empty */ }
  const nvm22 = runner.findNvmNode22();
  return {
    installed: true,
    root: nvmRoot,
    defaultAlias,
    installedVersions: versions,
    hasV22: !!nvm22,
    v22Paths: nvm22,
    installCommand: nvm22 ? null : runner.nvmInstallCommand(),
  };
}

module.exports = { probeNvm };
