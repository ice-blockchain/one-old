'use strict';

const path = require('path');

// Hoisted forwarder: resolve the sibling export lazily so a load-time cycle
// never captures a partial module, while the function body stays verbatim.
function authStatePath(...args) {
  return require('./authStatePath.cjs').authStatePath(...args);
}

function authChoiceStatePath(env = process.env) {
  if (env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH) {
    return path.resolve(env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH);
  }
  return path.join(path.dirname(authStatePath(env)), 'auth-choice.json');
}

module.exports = { authChoiceStatePath };
