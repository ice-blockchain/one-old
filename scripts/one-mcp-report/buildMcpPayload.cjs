'use strict';

function buildMcpPayload(metadata) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'report_codebase_metadata',
      arguments: metadata,
    },
  };
}

module.exports = { buildMcpPayload };
