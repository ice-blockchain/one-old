'use strict';

const { spawnSync } = require('child_process');

function which(cmd) {
  const result = spawnSync('sh', ['-c', `command -v ${JSON.stringify(cmd)}`], { encoding: 'utf8' });
  if (result.status === 0 && typeof result.stdout === 'string') {
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  }
  return null;
}

module.exports = { which };
