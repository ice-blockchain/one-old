'use strict';

function buildMcpPayload(toolName, args = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };
}

module.exports = { buildMcpPayload };
