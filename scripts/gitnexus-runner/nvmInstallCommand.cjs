'use strict';

const { GITNEXUS_MIN_NODE_MAJOR } = require('./_helpers.cjs');

// Single-line bash command the agent can hand to the Bash tool. Sources the
// nvm script first because nvm is a shell function, then installs + sets
// default. Bash tool permission prompt is the user's consent — the runner
// itself never executes this.
function nvmInstallCommand() {
  return (
    `bash -lc '. "$HOME/.nvm/nvm.sh" `
    + `&& nvm install ${GITNEXUS_MIN_NODE_MAJOR} `
    + `&& nvm alias default ${GITNEXUS_MIN_NODE_MAJOR} `
    + `&& nvm use default `
    + `&& npm install -g gitnexus'`
  );
}

module.exports = { nvmInstallCommand };
