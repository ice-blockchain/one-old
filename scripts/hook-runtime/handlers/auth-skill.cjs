'use strict';

// scripts/hook-runtime/handlers/auth-skill.cjs
// Reads the auth-client directive markdown and extracts the per-branch
// directive text the auth gate emits. This is the bridge that lets the auth
// FLOW WORDING live in a non-user-visible markdown file while the deterministic
// decision + enforcement stays in auth.cjs.
//
// The directive file carries the verbatim text inside fenced markers:
//   <!-- T1AUTH:BEGIN <name> -->
//   ...exact text, may contain {{PLACEHOLDER}} tokens...
//   <!-- T1AUTH:END <name> -->
// `authSkillBlock(name, vars, fallback)` returns that text with placeholders
// substituted. If the skill file or block is missing/malformed it returns the
// supplied fallback (the gate stays functional and enforcement is unaffected,
// since blocking lives in auth.cjs, not here).

const fs = require('fs');
const path = require('path');

const { pluginRoot } = require('../config.cjs');

// This file is intentionally outside `skills/`, so the auth gate remains
// available even if user-visible skills are disabled or hidden.
const AUTH_DIRECTIVE_REL_PATH = path.join('scripts', 'traffic-one-auth', 'auth-gate.md');

let cachedSource;

function authSkillSource() {
  if (cachedSource !== undefined) return cachedSource;
  try {
    cachedSource = fs.readFileSync(path.join(pluginRoot(), AUTH_DIRECTIVE_REL_PATH), 'utf8');
  } catch {
    cachedSource = '';
  }
  return cachedSource;
}

// Extract the verbatim text between the BEGIN/END markers for `name`. Strips
// exactly one newline immediately after BEGIN and one immediately before END
// (the marker-adjacent line breaks), leaving the authored block body intact.
function extractBlock(source, name) {
  const begin = `<!-- T1AUTH:BEGIN ${name} -->`;
  const end = `<!-- T1AUTH:END ${name} -->`;
  const startIdx = source.indexOf(begin);
  if (startIdx === -1) return null;
  const bodyStart = startIdx + begin.length;
  const endIdx = source.indexOf(end, bodyStart);
  if (endIdx === -1) return null;
  return source.slice(bodyStart, endIdx).replace(/^\n/, '').replace(/\n$/, '');
}

function applyVars(text, vars) {
  let out = text;
  for (const [key, value] of Object.entries(vars || {})) {
    out = out.split(`{{${key}}}`).join(value == null ? '' : String(value));
  }
  return out;
}

function commonVars(source) {
  return {
    MCP_TOOL_WARNING: extractBlock(source, 'common-mcp-tool-warning') || '',
  };
}

function authSkillBlock(name, vars = {}, fallback = '') {
  const source = authSkillSource();
  const body = source ? extractBlock(source, name) : null;
  return applyVars(body == null ? fallback : body, {
    ...(source ? commonVars(source) : {}),
    ...vars,
  });
}

module.exports = {
  AUTH_DIRECTIVE_REL_PATH,
  authSkillBlock,
  authSkillSource,
  commonVars,
  extractBlock,
};
