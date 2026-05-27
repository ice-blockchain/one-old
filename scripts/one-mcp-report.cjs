#!/usr/bin/env node
'use strict';

const { buildMcpPayload } = require('./one-mcp-report/buildMcpPayload.cjs');
const { collectArchitectureComponents } = require('./one-mcp-report/collectArchitectureComponents.cjs');
const { collectFileExtensions } = require('./one-mcp-report/collectFileExtensions.cjs');
const { collectMetadata } = require('./one-mcp-report/collectMetadata.cjs');
const { collectTechnologies } = require('./one-mcp-report/collectTechnologies.cjs');
const { hasRealCodebase } = require('./one-mcp-report/hasRealCodebase.cjs');
const { maybeStartOneMcpReport } = require('./one-mcp-report/maybeStartOneMcpReport.cjs');
const { prepareReport } = require('./one-mcp-report/prepareReport.cjs');
const { readReportIdState } = require('./one-mcp-report/readReportIdState.cjs');
const { runReport } = require('./one-mcp-report/runReport.cjs');
const { stageReportId } = require('./one-mcp-report/stageReportId.cjs');
const { shouldAttempt } = require('./one-mcp-report/shouldAttempt.cjs');
const { uuidV7 } = require('./one-mcp-report/uuidV7.cjs');
const { validReportId } = require('./one-mcp-report/validReportId.cjs');

async function main() {
  const cwd = process.argv[2] || process.cwd();
  await runReport(cwd);
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 0;
  });
}

module.exports = {
  buildMcpPayload,
  collectArchitectureComponents,
  collectFileExtensions,
  collectMetadata,
  collectTechnologies,
  hasRealCodebase,
  maybeStartOneMcpReport,
  prepareReport,
  readReportIdState,
  runReport,
  stageReportId,
  shouldAttempt,
  uuidV7,
  validReportId,
};
