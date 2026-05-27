'use strict';

const { authChoiceFallbackStatePath } = require('./_helpers.cjs');

// Hoisted forwarder: resolve the sibling export lazily so a load-time cycle
// never captures a partial module, while the function body stays verbatim.
function authChoiceStatePath(...args) {
  return require('./authChoiceStatePath.cjs').authChoiceStatePath(...args);
}

function authChoiceStatePaths(env = process.env) {
  const primary = authChoiceStatePath(env);
  const fallback = authChoiceFallbackStatePath(env);
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

module.exports = { authChoiceStatePaths };
