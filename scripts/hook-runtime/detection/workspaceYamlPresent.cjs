'use strict';

const fs   = require('fs');
const path = require('path');

function workspaceYamlPresent(cwd) {
  return (
    fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml')) ||
    fs.existsSync(path.join(cwd, 'pnpm-workspace.yml'))
  );
}

module.exports = { workspaceYamlPresent };
