'use strict';

const path = require('path');

const {
  codexSessionsDir,
  walkJsonlFiles,
  readFirstJsonlObject,
} = require('./_helpers.cjs');

function resolveCodexSession(sessionId, env = process.env) {
  const root = codexSessionsDir(env);
  const files = walkJsonlFiles(root);
  const direct = files.find((filePath) => path.basename(filePath).includes(sessionId));
  if (direct) return direct;
  for (const filePath of files) {
    const first = readFirstJsonlObject(filePath);
    const payload = first && first.payload && typeof first.payload === 'object' ? first.payload : {};
    if (payload.id === sessionId) return filePath;
  }
  return null;
}

module.exports = { resolveCodexSession };
