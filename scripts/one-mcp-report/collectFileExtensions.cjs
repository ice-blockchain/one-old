'use strict';

const {
  walkFiles,
  extensionFor,
  readText,
  countLines,
} = require('./_helpers.cjs');

function collectFileExtensions(cwd) {
  const totals = {};
  walkFiles(cwd, (absPath, relPath) => {
    const ext = extensionFor(relPath);
    if (!ext) return;
    const text = readText(absPath);
    if (text === null || text.includes('\u0000')) return;
    totals[ext] = (totals[ext] || 0) + countLines(text);
  });
  return Object.fromEntries(
    Object.entries(totals)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 50),
  );
}

module.exports = { collectFileExtensions };
