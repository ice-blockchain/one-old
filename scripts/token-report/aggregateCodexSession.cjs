'use strict';

const { parseCodexJsonlFile } = require('./parseCodexJsonlFile.cjs');

function aggregateCodexSession(session) {
  const parsed = parseCodexJsonlFile(session.jsonl);
  return {
    source: 'codex',
    session: { ...session, ...parsed.session },
    parent: parsed.stats,
    subagents: [],
    trafficOne: parsed.trafficOne,
  };
}

module.exports = { aggregateCodexSession };
