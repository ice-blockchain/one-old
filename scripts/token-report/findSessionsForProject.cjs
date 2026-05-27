'use strict';

const fs = require('fs');
const path = require('path');
const { findClaudeProjectsDir } = require('./_helpers.cjs');

function findSessionsForProject(projectSlug) {
  const projectsDir = findClaudeProjectsDir();
  const projectDir = path.join(projectsDir, projectSlug);
  if (!fs.existsSync(projectDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    const id = e.name;
    const parentJsonl = path.join(projectDir, `${id}.jsonl`);
    if (!fs.existsSync(parentJsonl)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(parentJsonl).mtimeMs; } catch { mtime = 0; }
    sessions.push({ id, dir: path.join(projectDir, id), parentJsonl, mtimeMs: mtime });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  return sessions;
}

module.exports = { findSessionsForProject };
