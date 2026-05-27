'use strict';

const os = require('os');
const path = require('path');

function authStatePath(env = process.env) {
  if (env.TRAFFIC_ONE_AUTH_STATE_PATH) {
    return path.resolve(env.TRAFFIC_ONE_AUTH_STATE_PATH);
  }
  const base = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'traffic-one')
    : path.join(env.HOME || os.homedir(), '.traffic-one');
  return path.join(base, 'auth.json');
}

module.exports = { authStatePath };
