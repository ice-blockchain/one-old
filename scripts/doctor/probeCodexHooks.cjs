'use strict';

const path = require('path');

const {
  codexConfigPath,
  safeRead,
  parseCodexConfigToml,
  trustedProjectForCwd,
} = require('./_helpers.cjs');

function probeCodexHooks(cwd, env = process.env) {
  const configPath = codexConfigPath(env);
  const text = configPath ? safeRead(configPath) : null;
  if (!text) {
    return {
      host: 'codex',
      configPath,
      configExists: false,
      cwd: path.resolve(cwd),
    };
  }

  const sections = parseCodexConfigToml(text);
  const pluginSection = sections['plugins."traffic-one@traffic-one-local"'] || null;
  const hookSections = Object.entries(sections)
    .filter(([section]) => section.startsWith('hooks.state."traffic-one@traffic-one-local:hooks/hooks.json:'));
  const hookEvents = new Set();
  let hookStateEnabledCount = 0;
  let hookStateTrustedHashCount = 0;
  for (const [section, values] of hookSections) {
    const eventMatch = section.match(/hooks\/hooks\.json:([^:]+):/);
    if (eventMatch) hookEvents.add(eventMatch[1]);
    if (values && values.enabled === true) hookStateEnabledCount += 1;
    if (values && typeof values.trusted_hash === 'string' && values.trusted_hash.startsWith('sha256:')) {
      hookStateTrustedHashCount += 1;
    }
  }
  const requiredHookEvents = ['session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use'];
  const missingHookEvents = requiredHookEvents.filter((event) => !hookEvents.has(event));
  const trustedProject = trustedProjectForCwd(cwd, sections);

  return {
    host: 'codex',
    configPath,
    configExists: true,
    cwd: path.resolve(cwd),
    pluginEnabled: pluginSection ? pluginSection.enabled === true : null,
    hookStateEntryCount: hookSections.length,
    hookStateEnabledCount,
    hookStateTrustedHashCount,
    hookEvents: [...hookEvents].sort(),
    missingHookEvents,
    trustCovered: Boolean(trustedProject),
    trustedProject,
  };
}

module.exports = { probeCodexHooks };
