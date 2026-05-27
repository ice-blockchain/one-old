'use strict';

const { DEFAULT_ENDPOINT } = require('./_helpers.cjs');

function endpointFromEnv(env = process.env) {
  return env.TRAFFIC_ONE_MCP_KEY_ENDPOINT || DEFAULT_ENDPOINT;
}

module.exports = { endpointFromEnv };
