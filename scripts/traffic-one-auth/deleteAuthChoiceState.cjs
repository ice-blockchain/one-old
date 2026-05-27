'use strict';

const fs = require('fs');

// Hoisted forwarder: resolve the sibling export lazily so a load-time cycle
// never captures a partial module, while the function body stays verbatim.
function authChoiceStatePaths(...args) {
  return require('./authChoiceStatePaths.cjs').authChoiceStatePaths(...args);
}

function deleteAuthChoiceState(env = process.env) {
  let ok = true;
  for (const filePath of authChoiceStatePaths(env)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      ok = false;
    }
  }
  return ok;
}

module.exports = { deleteAuthChoiceState };
