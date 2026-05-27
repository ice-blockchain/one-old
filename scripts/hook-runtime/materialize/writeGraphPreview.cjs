'use strict';

const fs = require('fs');
const path = require('path');

const { generateGraphPreview } = require('./generateGraphPreview.cjs');

// Idempotent: writes .traffic-one/graph-preview.md when the graph artefact
// exists. Returns true on successful write, false when no graph or write fails.
function writeGraphPreview(cwd, provider) {
  const body = generateGraphPreview(cwd, provider);
  if (!body) return false;
  const dst = path.join(cwd, '.traffic-one', 'graph-preview.md');
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, body, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { writeGraphPreview };
