'use strict';

const { composeRuleManifest } = require('./composeRuleManifest.cjs');

function stackSpecForState(state) {
  return composeRuleManifest(state);
}

module.exports = { stackSpecForState };
