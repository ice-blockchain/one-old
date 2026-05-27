'use strict';

const fs   = require('fs');
const path = require('path');

// Source-file count (rough "is this a new project?" heuristic).
function countSourceFiles(cwd) {
  let count = 0;
  const sourceExts = new Set([
    '.tsx', '.ts', '.jsx', '.js',
    '.vue', '.svelte',
    '.go', '.rs', '.py', '.java', '.kt', '.kts', '.cs', '.php', '.rb',
    '.swift', '.dart', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
  ]);

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && sourceExts.has(path.extname(entry.name))) {
        count += 1;
      }
    }
  }

  walk(cwd);
  return count;
}

module.exports = { countSourceFiles };
