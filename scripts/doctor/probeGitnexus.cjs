'use strict';

const runner = require('../gitnexus-runner.cjs');
const { which } = require('./_helpers.cjs');

function probeGitnexus() {
  const fromPath = which('gitnexus');
  const nvm22 = runner.findNvmNode22();
  return {
    onPath: fromPath,
    absoluteV22: nvm22 ? nvm22.gitnexus : null,
    // A pre-existing gitnexus living inside an OLDER nvm Node folder is
    // the "installed via --force, will crash" landmine. Flag it.
    crashRiskInOldNvm: !!(fromPath && /\/\.nvm\/versions\/node\/v(?!22)[\d.]+\/bin\/gitnexus$/.test(fromPath)),
  };
}

module.exports = { probeGitnexus };
