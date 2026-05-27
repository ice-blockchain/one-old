'use strict';

function hasWorkspaces(pkg) {
  return Boolean(pkg.workspaces) || Object.prototype.hasOwnProperty.call(pkg, 'pnpm');
}

module.exports = { hasWorkspaces };
