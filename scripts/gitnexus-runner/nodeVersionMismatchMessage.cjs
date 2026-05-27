'use strict';

const { GITNEXUS_MIN_NODE_MAJOR } = require('./_helpers.cjs');

// Beginner-friendly upgrade message. Single source of truth so the runner,
// the post-build banner, and the post-stack-setup warning all use the same
// wording.
function nodeVersionMismatchMessage(major) {
  const have = major === null ? 'an unknown Node version' : `Node ${major}`;
  return (
    `GitNexus requires Node >=${GITNEXUS_MIN_NODE_MAJOR} (you have ${have}). `
    + 'Upgrade once, then relaunch Claude Code:\n'
    + `  nvm install ${GITNEXUS_MIN_NODE_MAJOR}\n`
    + `  nvm alias default ${GITNEXUS_MIN_NODE_MAJOR}\n`
    + `  nvm use default\n`
    + 'Or pick the `graphify` provider instead (Python; works on any Node) '
    + 'by editing `.traffic-one/.one.json` -> `codeGraphProvider: "graphify"`.'
  );
}

module.exports = { nodeVersionMismatchMessage };
