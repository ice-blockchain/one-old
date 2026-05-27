'use strict';

const { codexSessionsDir } = require('./_helpers.cjs');
const { resolveCodexSession } = require('./resolveCodexSession.cjs');
const { analyzeCodexSessionFile } = require('./analyzeCodexSessionFile.cjs');

function probeSessionDiagnostics(sessionId, env = process.env) {
  if (!sessionId) return null;
  const filePath = resolveCodexSession(sessionId, env);
  if (!filePath) {
    return {
      id: sessionId,
      found: false,
      sessionsDir: codexSessionsDir(env),
    };
  }
  return {
    found: true,
    ...analyzeCodexSessionFile(filePath, env),
  };
}

module.exports = { probeSessionDiagnostics };
