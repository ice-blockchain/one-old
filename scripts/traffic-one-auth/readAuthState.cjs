'use strict';

const { readJson } = require('./_helpers.cjs');

// Hoisted forwarder: resolve the sibling export lazily so a load-time cycle
// never captures a partial module, while the function body stays verbatim.
function authStatePath(...args) {
  return require('./authStatePath.cjs').authStatePath(...args);
}

function readAuthState(env = process.env) {
  return readJson(authStatePath(env), null);
}

module.exports = { readAuthState };
