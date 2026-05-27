'use strict';

const { prepareReport } = require('./prepareReport.cjs');

function maybeStartOneMcpReport(cwd, options = {}) {
  try {
    return prepareReport(cwd, options);
  } catch (error) {
    return { started: false, reason: 'error', error };
  }
}

module.exports = { maybeStartOneMcpReport };
