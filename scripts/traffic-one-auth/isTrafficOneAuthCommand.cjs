'use strict';

function isTrafficOneAuthCommand(command) {
  return /\bscripts\/traffic-one-auth\.cjs\b/.test(String(command || ''))
    && /\b(login|refresh|status|logout)\b/.test(String(command || ''));
}

module.exports = { isTrafficOneAuthCommand };
