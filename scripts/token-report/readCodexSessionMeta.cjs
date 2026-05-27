'use strict';

const { readFirstLine, codexSessionIdFromFile } = require('./_helpers.cjs');

function readCodexSessionMeta(filePath) {
  const line = readFirstLine(filePath).trim();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || parsed.type !== 'session_meta') return null;
    const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
    return {
      id: typeof payload.id === 'string' ? payload.id : codexSessionIdFromFile(filePath),
      startedAt: payload.timestamp || parsed.timestamp || null,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
      originator: typeof payload.originator === 'string' ? payload.originator : 'Codex Desktop',
      source: typeof payload.source === 'string' ? payload.source : null,
      modelProvider: typeof payload.model_provider === 'string' ? payload.model_provider : null,
      model: typeof payload.model === 'string' ? payload.model : 'codex',
    };
  } catch {
    return null;
  }
}

module.exports = { readCodexSessionMeta };
