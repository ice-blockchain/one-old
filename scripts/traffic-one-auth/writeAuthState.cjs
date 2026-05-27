'use strict';

const fs = require('fs');
const path = require('path');

// Hoisted forwarder: resolve the sibling export lazily so a load-time cycle
// never captures a partial module, while the function body stays verbatim.
function authStatePath(...args) {
  return require('./authStatePath.cjs').authStatePath(...args);
}

function writeAuthState(state, env = process.env) {
  const filePath = authStatePath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort; some filesystems ignore chmod.
  }
  return filePath;
}

module.exports = { writeAuthState };
