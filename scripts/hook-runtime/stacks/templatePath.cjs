'use strict';

// 'rules/foo/bar.md' (logical) → 'rules-templates/foo/bar.md' (on-disk source)
function templatePath(relPath) {
  if (typeof relPath !== 'string') return relPath;
  return relPath.replace(/^rules\//, 'rules-templates/');
}

module.exports = { templatePath };
