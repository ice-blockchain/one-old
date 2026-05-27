'use strict';

const fs = require('fs');

// Hoisted forwarder: resolve the sibling export lazily so a load-time cycle
// never captures a partial module, while the function body stays verbatim.
function authStatePath(...args) {
  return require('./authStatePath.cjs').authStatePath(...args);
}

function deleteAuthState(env = process.env) {
  try {
    fs.rmSync(authStatePath(env), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { deleteAuthState };
