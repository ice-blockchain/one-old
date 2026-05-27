'use strict';

const { parseJsonlFile } = require('./parseJsonlFile.cjs');
const { discoverSubagents } = require('./discoverSubagents.cjs');

function aggregateSession(session) {
  const parent = parseJsonlFile(session.parentJsonl);
  const subagents = discoverSubagents(session.dir).map((s) => ({
    ...s,
    stats: parseJsonlFile(s.jsonl),
  }));
  return { source: 'claude', session, parent, subagents };
}

module.exports = { aggregateSession };
