'use strict';

const runner = require('../gitnexus-runner.cjs');
const { which } = require('./_helpers.cjs');

function probeNode() {
  return {
    runningMajor: runner.currentNodeMajor(),
    runningVersion: process.versions.node,
    onPath: which('node'),
    requiredMajor: runner.GITNEXUS_MIN_NODE_MAJOR,
  };
}

module.exports = { probeNode };
