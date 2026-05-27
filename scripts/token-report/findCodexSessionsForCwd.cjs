'use strict';

const fs = require('fs');
const { readCodexSessionMeta } = require('./readCodexSessionMeta.cjs');
const { walkCodexSessionFiles, pathsRelated, findCodexSessionsDir } = require('./_helpers.cjs');

function findCodexSessionsForCwd(cwd, sessionsDir = findCodexSessionsDir()) {
  const sessions = [];
  for (const filePath of walkCodexSessionFiles(sessionsDir)) {
    const meta = readCodexSessionMeta(filePath);
    if (!meta || !pathsRelated(cwd, meta.cwd)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { mtime = 0; }
    sessions.push({
      id: meta.id,
      jsonl: filePath,
      mtimeMs: mtime,
      ...meta,
    });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

module.exports = { findCodexSessionsForCwd };
