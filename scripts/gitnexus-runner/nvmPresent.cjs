'use strict';

const fs = require('fs');
const path = require('path');

// Detect whether nvm is installed at all (looks for `~/.nvm/nvm.sh` — the
// canonical nvm script). nvm is a shell function, not a binary, so we can't
// `which` it; the script's presence is the reliable signal.
function nvmPresent() {
  const home = process.env.HOME || '';
  if (!home) return false;
  return fs.existsSync(path.join(home, '.nvm', 'nvm.sh'));
}

module.exports = { nvmPresent };
