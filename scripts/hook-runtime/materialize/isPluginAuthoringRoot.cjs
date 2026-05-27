'use strict';

const path = require('path');

const { pluginRoot } = require('../config.cjs');
const { hasPluginAuthoringMarkers } = require('./_helpers.cjs');

function isPluginAuthoringRoot(cwd) {
  const root = path.resolve(cwd);
  return root === path.resolve(pluginRoot()) || hasPluginAuthoringMarkers(root);
}

module.exports = { isPluginAuthoringRoot };
