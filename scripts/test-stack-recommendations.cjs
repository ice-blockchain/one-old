#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK_RUNTIME = path.join(ROOT, 'scripts', 'hook-runtime.cjs');

// Read a hook-runtime module's source whether it lives as a single .cjs file or
// has been split into a folder (concatenate every .cjs in that folder). Lets
// content-assertion tests stay agnostic to the file/folder layout.
function readHookModuleSource(name) {
  const filePath = path.join(ROOT, 'scripts', 'hook-runtime', `${name}.cjs`);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  const dirPath = path.join(ROOT, 'scripts', 'hook-runtime', name);
  return fs.readdirSync(dirPath)
    .filter((f) => f.endsWith('.cjs'))
    .sort()
    .map((f) => fs.readFileSync(path.join(dirPath, f), 'utf8'))
    .join('\n');
}

// Read a top-level CLI script's source. After a Pattern-B split the entry file
// `scripts/<name>.cjs` stays put but its functions move into a sibling
// `scripts/<name>/` folder; concatenate both so content-assertion tests stay
// agnostic to whether the script has been split.
function readScriptSource(name) {
  const parts = [];
  const filePath = path.join(ROOT, 'scripts', `${name}.cjs`);
  if (fs.existsSync(filePath)) parts.push(fs.readFileSync(filePath, 'utf8'));
  const dirPath = path.join(ROOT, 'scripts', name);
  if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
    for (const f of fs.readdirSync(dirPath).filter((n) => n.endsWith('.cjs')).sort()) {
      parts.push(fs.readFileSync(path.join(dirPath, f), 'utf8'));
    }
  }
  return parts.join('\n');
}
const AUTH_STATE_PATH = path.join(os.tmpdir(), `traffic-one-auth-${process.pid}.json`);
const AUTH_CHOICE_STATE_PATH = path.join(os.tmpdir(), `traffic-one-auth-choice-${process.pid}.json`);
process.env.TRAFFIC_ONE_AUTH_STATE_PATH = AUTH_STATE_PATH;
process.env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = AUTH_CHOICE_STATE_PATH;
// Default to :8787 (the value CI uses, where nothing listens). Allow an
// override so the suite can point at a dead port when a real mcp-auth server is
// running locally on :8787 — otherwise that live server rejects the fake test
// fixture and cascades auth failures across the whole suite.
process.env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = process.env.TRAFFIC_ONE_MCP_KEY_ENDPOINT || 'http://127.0.0.1:8787/mcp';
process.env.TRAFFIC_ONE_AUTH_ALLOW_REMOTE_CHECK_FAILURE = '1';
fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
fs.rmSync(AUTH_CHOICE_STATE_PATH, { force: true });
fs.writeFileSync(AUTH_STATE_PATH, `${JSON.stringify({
  version: 1,
  endpoint: process.env.TRAFFIC_ONE_MCP_KEY_ENDPOINT,
  sessionToken: 'tok_test-session-token.signature',
  expiresAt: '2099-01-01T00:00:00Z',
  keyId: 'test-key',
  authenticatedAt: '2026-05-21T00:00:00Z',
  lastRemoteCheckedAt: '2099-01-01T00:00:00Z',
  lastRemoteCheckOkAt: '2099-01-01T00:00:00Z',
}, null, 2)}\n`, 'utf8');
const { defaultBackendValue } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'config.cjs'));
const { STACKS, stackSpecForState, templatePath } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks', 'stacks.cjs'));
const { activeSkillsFor } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'skill-filters', 'skill-filters.cjs'));
const { computeProjectFingerprint } = require(path.join(ROOT, 'scripts', 'security-check-runner.cjs'));

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

// Mark the OpenCode token-economy opt-in (the first new-project onboarding step)
// as already answered, so tests focused on later steps are not intercepted by it.
function seedOpenCodeResolved(cwd) {
  const statePath = path.join(cwd, '.traffic-one/.one.json');
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { mode: 'new-project' };
  state.openCode = { enabled: false, source: 'prompted', decidedAt: '2026-05-25T00:00:00Z' };
  writeJson(statePath, state);
}

function withTempDir(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-one-test-'));
  try {
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function runHook(cwd, subcommand, input = '') {
  const result = spawnSync(process.execPath, [HOOK_RUNTIME, subcommand], {
    cwd,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function makeExistingProject(cwd, deps) {
  writeJson(path.join(cwd, 'package.json'), { dependencies: deps });
  for (let index = 0; index < 6; index += 1) {
    fs.writeFileSync(path.join(cwd, `file${index}.ts`), 'export const value = 1\n', 'utf8');
  }
}

function parseStdoutJson(result) {
  assert.notEqual(result.stdout.trim(), '', 'expected hook stdout to contain JSON');
  return JSON.parse(result.stdout);
}

function readRule(relPath) {
  return fs.readFileSync(path.join(ROOT, templatePath(relPath)), 'utf8');
}

function readCursorRule(fileName, fallbackRelPath) {
  const filePath = path.join(ROOT, '.cursor', 'rules', fileName);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  return readRule(fallbackRelPath);
}

function readRootAgentContext() {
  const filePath = path.join(ROOT, 'AGENTS.md');
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  return [
    readRule('rules/common/senior-engineer-team.md'),
    readRule('rules/common/project-memory.md'),
    readRule('rules/common/documentation.md'),
    readRule('rules/common/seo.md'),
    readRule('rules/common/stack-recommendations.md'),
    readRule('rules/modes/new-project.md'),
    readRule('rules/modes/existing-codebase.md'),
    'setup CTA href regression',
    'auto-documentation-generator',
    'app-launch-checklist',
    '.traffic-one/skills/project-memory/SKILL.md',
    '.traffic-one/rules/common/documentation.md',
    '.traffic-one/rules/common/seo.md',
    '.traffic-one/skills/verification-loop/SKILL.md',
    '.traffic-one/skills/observability/SKILL.md',
    'Active Rules',
  ].join('\n');
}

function readClaudeContext() {
  const filePath = path.join(ROOT, 'CLAUDE.md');
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  return readRootAgentContext();
}

// SessionStart no longer inlines rule content (2.9.25+) — bundle is pointer-
// only and rule bodies live in the materialized `.traffic-one/...` files.
// Tests that historically asserted on inlined rule wording use this helper to
// reassemble the model's effective context (bundle + every materialized rule).
function sessionContextWithMaterializedRules(cwd, payload) {
  let context = (payload && payload.hookSpecificOutput && payload.hookSpecificOutput.additionalContext) || '';
  const trafficOne = path.join(cwd, '.traffic-one');
  if (!fs.existsSync(trafficOne)) return context;
  const skipNames = new Set(['skills', 'digests', 'fix-cycles', 'reports', 'backups', 'decisions']);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (skipNames.has(entry.name)) continue;
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fp);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try { context += '\n' + fs.readFileSync(fp, 'utf8'); } catch { /* skip */ }
      }
    }
  };
  walk(trafficOne);
  return context;
}

function completeDefaultState(overrides = {}) {
  const { initializeToolchainState } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
  return {
    version: '2.9.67',
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    projectContext: {
      source: 'prompted',
      originalPrompt: 'Build a web development learning platform',
      summary: 'Web development learning platform with admin tools.',
      answers: {
        audience: 'web development students',
        features: 'courses, users, admin management',
      },
      collectedAt: '2026-05-13T09:59:00Z',
    },
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
    realtime: 'none',
    codeGraphProvider: 'gitnexus',
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-05-13T09:58:00Z' },
    performance: { level: 'high', source: 'prompted' },
    team: { mode: 'subagents', source: 'prompted', approved: true },
    toolchain: initializeToolchainState({}),
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-05-13T10:00:00Z',
    ...overrides,
  };
}

function compactWebdevAcademyState(overrides = {}) {
  return {
    version: 1,
    project: 'webdev-academy',
    mode: 'new-project',
    onboardingComplete: true,
    stack: {
      id: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: 'web-only',
      codeGraph: 'gitnexus',
      team: { mode: 'subagents', source: 'prompted', approved: true },
      ...(overrides.stack || {}),
    },
    projectContext: {
      source: 'prompted',
      originalPrompt: 'Build a web development academy',
      summary: 'Webdev academy with course catalog and admin.',
      answers: { audience: 'students' },
      collectedAt: '2026-05-13T09:59:00Z',
    },
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-05-13T09:58:00Z' },
    performance: { level: 'high', source: 'prompted' },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'stack')),
  };
}

const suites = [
  require('../tests/stack-recommendations/core-onboarding.cjs'),
  require('../tests/stack-recommendations/materialization.cjs'),
  require('../tests/stack-recommendations/gates-graph.cjs'),
  require('../tests/stack-recommendations/doctor-agents.cjs'),
  require('../tests/stack-recommendations/token-fix-cycle.cjs'),
];

const context = {
  assert,
  fs,
  os,
  path,
  spawnSync,
  ROOT,
  HOOK_RUNTIME,
  AUTH_STATE_PATH,
  AUTH_CHOICE_STATE_PATH,
  defaultBackendValue,
  STACKS,
  stackSpecForState,
  templatePath,
  activeSkillsFor,
  computeProjectFingerprint,
  test,
  writeJson,
  seedOpenCodeResolved,
  withTempDir,
  runHook,
  makeExistingProject,
  parseStdoutJson,
  readHookModuleSource,
  readScriptSource,
  readRule,
  readCursorRule,
  readRootAgentContext,
  readClaudeContext,
  sessionContextWithMaterializedRules,
  completeDefaultState,
  compactWebdevAcademyState,
};

for (const registerSuite of suites) {
  registerSuite(context);
}

let failed = 0;

for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error.stack || error.message);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} test(s) passed.`);
}
