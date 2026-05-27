'use strict';

const { mcpConfigPath, safeRead, safeJsonParse } = require('./_helpers.cjs');

function probeMcpAuth(env = process.env) {
  const configPath = mcpConfigPath();
  const raw = safeRead(configPath);
  const config = raw ? safeJsonParse(raw, null) : null;
  const server = config
    && config.mcpServers
    && typeof config.mcpServers === 'object'
    ? config.mcpServers['mcp-auth']
    : null;
  const bearerTokenEnvVar = server && typeof server.bearer_token_env_var === 'string'
    ? server.bearer_token_env_var
    : null;
  const envPresent = bearerTokenEnvVar
    ? typeof env[bearerTokenEnvVar] === 'string' && env[bearerTokenEnvVar].trim() !== ''
    : false;
  return {
    configPath,
    configExists: Boolean(raw),
    configured: Boolean(server),
    type: server && typeof server.type === 'string' ? server.type : null,
    url: server && typeof server.url === 'string' ? server.url : null,
    bearerTokenEnvVar,
    envPresent,
  };
}

module.exports = { probeMcpAuth };
