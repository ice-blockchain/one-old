#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK_RUNTIME = path.join(ROOT, 'scripts', 'hook-runtime.cjs');
const { defaultBackendValue } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'config.cjs'));
const { STACKS, stackSpecForState, templatePath } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks.cjs'));
const { computeProjectFingerprint } = require(path.join(ROOT, 'scripts', 'security-check-runner.cjs'));

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function withTempDir(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-one-test-'));
  try {
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
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
  const { initializeToolchainState } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs'));
  return {
    version: '2.9.31',
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
    realtime: 'none',
    codeGraphProvider: 'gitnexus',
    team: { mode: 'subagents', source: 'prompted' },
    toolchain: initializeToolchainState({}),
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-05-13T10:00:00Z',
    ...overrides,
  };
}

test('react stack denies next packages', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), { stack: 'react-frontend-only' });

    const result = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'pnpm add next next-auth' },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /Next\.js auth uses NextAuth\/Auth\.js/);
  });
});

test('explicit nextjs state allows next packages', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'custom-frontend',
      frontend: 'nextjs',
    });

    const result = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'pnpm add next next-auth vitest' },
    });

    assert.equal(result.stdout, '');
  });
});

test('existing next dependency allows next-auth', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, 'package.json'), {
      dependencies: { next: '^16.0.0' },
    });

    const result = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'pnpm add next-auth' },
    });

    assert.equal(result.stdout, '');
  });
});

test('supabase project bundle includes supabase auth default', () => {
  withTempDir((cwd) => {
    makeExistingProject(cwd, {
      react: '^18.0.0',
      '@supabase/supabase-js': '^2.0.0',
    });

    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.equal(state.backend, 'supabase');
    assert.match(context, /Supabase Auth/);
    assert.match(context, /Library Catalog/);
  });
});

test('new project onboarding defaults to supabase backend', () => {
  const { getPluginVersion } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs'));
  withTempDir((cwd) => {
    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));

    assert.equal(defaultBackendValue(), 'supabase');
    assert.equal(state.version, getPluginVersion());
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'pluginVersion'), false);
    assert.equal(state.mode, 'new-project');
    assert.ok(state.toolchain, 'new-project state should initialize toolchain');
    assert.match(context, /backend=supabase/);
    assert.match(context, /Supabase \(managed Postgres with Auth, Storage, Realtime, and RLS\)/);
  });
});

test('new project onboarding includes Codex subagent preflight', () => {
  const detectProject = fs.readFileSync(path.join(ROOT, 'skills-templates', 'detect-project', 'SKILL.md'), 'utf8');
  const directives = [
    fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'onboarding-prompts.cjs'), 'utf8'),
  ].join('\n');
  const orchestrator = fs.readFileSync(path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'SKILL.md'), 'utf8');
  const stackSetup = fs.readFileSync(path.join(ROOT, 'skills-templates', 'stack-setup', 'SKILL.md'), 'utf8');
  const agentsMirror = readRootAgentContext();
  const claude = readClaudeContext();

  assert.match(detectProject, /Codex subagent preflight for new projects/);
  assert.match(detectProject, /switch Codex and Claude Code to Plan mode/);
  assert.match(detectProject, /Explicit user requests never skip Traffic One onboarding/);
  assert.match(detectProject, /Codex Default mode fallback/);
  assert.match(detectProject, /Plan mode is required for Traffic One new-project onboarding/);
  assert.match(detectProject, /blocking preflight gate on Codex/);
  assert.match(detectProject, /request_user_input/);
  assert.match(detectProject, /Web only \(Recommended\)/);
  assert.match(detectProject, /Ionic \+ Capacitor/);
  assert.match(detectProject, /React Native \/ Expo/);
  assert.match(detectProject, /Code Graph/);
  assert.match(detectProject, /GitNexus/);
  assert.match(detectProject, /graphify/);
  assert.match(directives, /CODEX SUBAGENT PREFLIGHT/);
  assert.match(directives, /NEW-PROJECT PLAN MODE GATE \(Codex \+ Claude Code\)/);
  assert.match(directives, /mode === "new-project"/);
  assert.match(directives, /switch the host to Plan mode/);
  assert.match(directives, /CODEX ONBOARDING POPUP RULE/);
  assert.match(directives, /CODEX DEFAULT-MODE FALLBACK \(visible response, blocking\)/);
  assert.match(directives, /Your next visible assistant message must be the plain-chat fallback prompt/);
  assert.match(directives, /mention only the project-detection\/onboarding flow/);
  assert.match(directives, /Do not say you are using create-feature, create-page, frontend-design, tdd-workflow/);
  assert.match(directives, /CODEX MOBILE DECISION PREFLIGHT/);
  assert.match(directives, /explicit user requests influence the eventual stack choice/i);
  assert.match(directives, /implementation preferences, not\s+onboarding answers/);
  assert.match(directives, /CODEX CODEBASE GRAPH PROVIDER PREFLIGHT/);
  assert.match(directives, /request_user_input/);
  assert.match(directives, /Do NOT print "Options:" or a\s+numbered list in chat/);
  assert.match(directives, /reply with the option number or\s+label/);
  assert.match(directives, /Never choose a default/);
  assert.match(directives, /"team": \{ "mode": "<subagents\|main-agent>", "source": "prompted" \}/);
  assert.match(directives, /team\.mode="subagents"/);
  assert.match(directives, /must not write feature source/);
  assert.match(orchestrator, /Codex consent gate — blocking/);
  assert.match(orchestrator, /Plan mode/);
  assert.match(orchestrator, /Codex Default mode fallback is a visible first-response requirement/);
  assert.match(orchestrator, /Claude Code follows the same Plan Mode requirement/);
  assert.match(stackSetup, /Codex Default mode fallback/);
  assert.match(stackSetup, /before any tool\s+use/);
  assert.match(orchestrator, /Code Graph/);
  assert.match(orchestrator, /reply with the option number or label/);
  assert.match(orchestrator, /Run team \(Recommended\)/);
  assert.match(orchestrator, /Main agent only/);
  assert.match(orchestrator, /"team": \{ "mode": "subagents", "source": "prompted" \}/);
  assert.match(orchestrator, /must not write feature source/);
  assert.match(stackSetup, /`team\.mode` is the source of truth/);
  assert.match(agentsMirror, /mode === "new-project"/);
  assert.match(agentsMirror, /Codex and Claude Code must switch to Plan mode/);
  assert.match(agentsMirror, /Codex default-mode fallback is a visible first-response requirement/);
  assert.match(agentsMirror, /Before onboarding is resolved, mention only the project-detection\/onboarding flow/);
  assert.match(agentsMirror, /implementation intent, not onboarding answers/);
  assert.match(agentsMirror, /Persist the Team answer in `\.traffic-one\.json`/);
  assert.match(agentsMirror, /team\.mode="subagents"/);
  assert.match(claude, /mode === "new-project"/);
  assert.match(claude, /Codex and Claude Code must switch to Plan\s+mode/);
  assert.match(claude, /Codex default-mode fallback is a visible first-response requirement/);
  assert.match(claude, /Before onboarding is resolved, mention only the project-detection\/onboarding flow/);
  assert.match(claude, /implementation intent, not onboarding answers/);
  assert.match(claude, /team\.mode="subagents"/);

  withTempDir((cwd) => {
    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /NEW-PROJECT PLAN MODE GATE \(Codex \+ Claude Code\)/);
    assert.match(context, /mode === "new-project"/);
    assert.match(context, /Plan mode/);
    assert.match(context, /CODEX ONBOARDING POPUP RULE/);
    assert.match(context, /CODEX DEFAULT-MODE FALLBACK \(visible response, blocking\)/);
    assert.match(context, /Plan mode is required for Traffic One new-project onboarding, but Plan mode is not active here and the popup prompt is unavailable/);
    assert.match(context, /Do not say you are using create-feature, create-page, frontend-design, tdd-workflow/);
    assert.match(context, /CODEX MOBILE DECISION PREFLIGHT/);
    assert.match(context, /implementation preferences, not\s+onboarding answers/);
    assert.match(context, /CODEX CODEBASE GRAPH PROVIDER PREFLIGHT/);
    assert.match(context, /Do you want a mobile app too\?/);
    assert.match(context, /Web only \(Recommended\)/);
    assert.match(context, /Ionic \+ Capacitor/);
    assert.match(context, /React Native \/ Expo/);
    assert.match(context, /Which provider should we use for the codebase graph\?/);
    assert.match(context, /GitNexus/);
    assert.match(context, /graphify/);
    assert.match(context, /Traffic One sees this as a multi-layer build/);
    assert.match(context, /architect → frontend\/backend → reviewer\/tester/);
    assert.match(context, /"team": \{ "mode": "<subagents\|main-agent>", "source": "prompted" \}/);
    assert.match(context, /team\.mode="subagents"/);
    assert.ok(context.indexOf('CODEX MOBILE DECISION PREFLIGHT') < context.indexOf('CODEX CODEBASE GRAPH PROVIDER PREFLIGHT'));
    assert.ok(context.indexOf('CODEX CODEBASE GRAPH PROVIDER PREFLIGHT') < context.indexOf('CODEX SUBAGENT PREFLIGHT'));
  });
});

test('first prompt reminder asks mobile popup before subagent preflight', () => {
  withTempDir((cwd) => {
    runHook(cwd, 'session-start');

    const result = runHook(cwd, 'user-prompt-submit', {
      prompt: 'create a modern learning platform with courses and an admin area to manage courses and users',
    });
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /\[FIRST PROMPT STACK CLASSIFICATION\]/);
    assert.match(context, /stack=default/);
    assert.match(context, /mode=new-project/);
    assert.match(context, /switch Codex and Claude Code to Plan mode/);
    assert.match(context, /CODEX DEFAULT-MODE FALLBACK \(visible response, blocking\)/);
    assert.match(context, /Your next visible assistant message must be the plain-chat fallback prompt/);
    assert.match(context, /Plan mode is required for Traffic One new-project onboarding, but Plan mode is not active here and the popup prompt is unavailable/);
    assert.match(context, /Onboarding choices must be prompt popups/);
    assert.match(context, /reply with the option number or label/);
    assert.match(context, /never choose a default/i);
    assert.match(context, /request_user_input/);
    assert.match(context, /Popup 1/);
    assert.match(context, /Do you want a mobile app too\?/);
    assert.match(context, /Web only \(Recommended\)/);
    assert.match(context, /Ionic \+ Capacitor/);
    assert.match(context, /React Native \/ Expo/);
    assert.match(context, /Popup 2/);
    assert.match(context, /Which provider should we use for the codebase graph\?/);
    assert.match(context, /GitNexus/);
    assert.match(context, /graphify/);
    assert.match(context, /Popup 3/);
    assert.match(context, /Run team \(Recommended\)/);
    assert.match(context, /Main agent only/);
    assert.match(context, /team\.mode="subagents"/);
    assert.match(context, /parent\/orchestrator does not write feature source/);
  });
});

test('explicit stack or mobile prompt still asks mobile popup first', () => {
  withTempDir((cwd) => {
    runHook(cwd, 'session-start');

    const result = runHook(cwd, 'user-prompt-submit', {
      prompt: 'fa-mi un site complet pentru jobs cu Next.js, web only, fara subagenti',
    });
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /\[FIRST PROMPT STACK CLASSIFICATION\]/);
    assert.match(context, /stack=custom-frontend/);
    assert.match(context, /frontend=nextjs/);
    assert.match(context, /Popup 1/);
    assert.match(context, /Do you want a mobile app too\?/);
    assert.match(context, /Ask this even if the prompt already named web, mobile, Next\.js, Ionic, React Native, frontend-only, or no subagents/);
    assert.doesNotMatch(context, /skip the mobile popup/);
    assert.ok(context.indexOf('Popup 1') < context.indexOf('Popup 2'));
    assert.ok(context.indexOf('Popup 2') < context.indexOf('Popup 3'));
  });
});

test('implementation skills defer until new-project onboarding is resolved', () => {
  const implementationSkills = [
    'skills-templates/create-feature/SKILL.md',
    'skills-templates/create-page/SKILL.md',
    'skills-templates/create-component/SKILL.md',
    'skills-templates/create-service/SKILL.md',
    'skills-templates/create-native-feature/SKILL.md',
    'skills-templates/create-native-screen/SKILL.md',
    'skills-templates/create-native-component/SKILL.md',
    'skills-templates/create-native-service/SKILL.md',
    'skills-templates/frontend-design/SKILL.md',
    'skills-templates/tdd-workflow/SKILL.md',
  ];

  for (const rel of implementationSkills) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const compact = content.replace(/\s+/g, ' ');
    assert.match(compact, /Do not activate during Traffic One new-project onboarding/i, rel);
    assert.match(compact, /detect-project/, rel);
    assert.match(compact, /stack-setup/, rel);
    assert.match(compact, /onboardingComplete/, rel);
  }
});

test('onboarding gate hook is installed before tools can proceed', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const preToolUse = hooks.hooks.PreToolUse;
  assert.ok(Array.isArray(preToolUse));
  assert.match(preToolUse[0].matcher, /Bash/);
  assert.match(preToolUse[0].matcher, /Read/);
  assert.match(preToolUse[0].matcher, /LS/);
  assert.match(preToolUse[0].matcher, /Glob/);
  assert.match(preToolUse[0].matcher, /Grep/);
  assert.match(preToolUse[0].matcher, /Write/);
  assert.match(preToolUse[0].hooks[0].command, /check-onboarding-gate/);
  const architectureHook = preToolUse.find((entry) => /check-architecture-write/.test(entry.hooks[0].command));
  assert.ok(architectureHook);
  assert.match(architectureHook.matcher, /Bash/);
  assert.match(architectureHook.matcher, /Write/);
  assert.match(architectureHook.matcher, /Edit/);
  assert.ok(
    preToolUse.findIndex((entry) => /check-onboarding-gate/.test(entry.hooks[0].command))
      < preToolUse.findIndex((entry) => /check-library-allowlist/.test(entry.hooks[0].command)),
    'onboarding gate must run before Bash library/version checks',
  );
});

test('developer settings mirror onboarding and graph hooks', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8'));
  const preToolUse = settings.hooks.PreToolUse;
  const postToolUse = settings.hooks.PostToolUse;
  assert.ok(Array.isArray(preToolUse));
  assert.ok(Array.isArray(postToolUse));

  assert.match(preToolUse[0].matcher, /Bash/);
  assert.match(preToolUse[0].matcher, /Read/);
  assert.match(preToolUse[0].matcher, /LS/);
  assert.match(preToolUse[0].matcher, /Glob/);
  assert.match(preToolUse[0].matcher, /Grep/);
  assert.match(preToolUse[0].matcher, /Write/);
  assert.match(preToolUse[0].hooks[0].command, /check-onboarding-gate/);
  const architectureHook = preToolUse.find((entry) => /check-architecture-write/.test(entry.hooks[0].command));
  assert.ok(architectureHook);
  assert.match(architectureHook.matcher, /Bash/);
  assert.match(architectureHook.matcher, /Write/);
  assert.match(architectureHook.matcher, /Edit/);
  assert.ok(preToolUse.some((entry) => /pre-graphify-hint/.test(entry.hooks[0].command)));

  const bashPostHook = postToolUse.find((entry) => entry.matcher === 'Bash');
  assert.ok(bashPostHook, 'Claude settings must run Bash post hooks');
  const bashCommands = bashPostHook.hooks.map((hook) => hook.command).join('\n');
  assert.match(bashCommands, /post-build-page-speed/);
  assert.match(bashCommands, /post-build-graphify/);

  const materializePostHook = postToolUse.find((entry) => /post-stack-setup/.test(entry.hooks[0].command));
  assert.ok(materializePostHook, 'settings must include generic materialization post hook');
  assert.equal(materializePostHook.matcher, '.*');
});

test('hook configs use host-agnostic post-tool materialization', () => {
  for (const relPath of ['hooks/hooks.json', 'settings.json']) {
    const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
    const postToolUse = hooks.hooks.PostToolUse;
    const materializePostHook = postToolUse.find((entry) => /post-stack-setup/.test(entry.hooks[0].command));

    assert.ok(materializePostHook, `${relPath} must include post-stack-setup`);
    assert.equal(materializePostHook.matcher, '.*', `${relPath} must not bind materialization to host-specific tool names`);
    assert.match(materializePostHook.hooks[0].statusMessage, /materialization/i);
  }
});

test('onboarding gate denies tool use when empty cwd resolves mode=new-project', () => {
  withTempDir((cwd) => {
    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'npm view react version' },
    });
    const parsed = parseStdoutJson(result);
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;

    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(reason, /mode=new-project/);
    assert.match(reason, /Plan mode/);
    assert.match(reason, /fallback chat prompt must be displayed as the next visible assistant message/);
    assert.match(reason, /Your next visible assistant message must be/);
    assert.match(reason, /Plan mode is required for Traffic One new-project onboarding, but Plan mode is not active here and the popup prompt is unavailable/);
    assert.match(reason, /Do you want a mobile app too\?/);
    assert.match(reason, /Web only \(Recommended\)/);
    assert.match(reason, /Ionic \+ Capacitor/);
    assert.match(reason, /React Native \/ Expo/);
    assert.match(reason, /Reply with the option number or label/);
    assert.match(reason, /remaining Code Graph and Team prompts/);
    assert.match(reason, /Do not choose defaults/);
    assert.match(reason, /inspect package versions/);
  });
});

test('onboarding gate denies partial new-project state across read and search tools', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 3,
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      confirmed: false,
      onboardingComplete: false,
    });

    for (const toolInput of [
      { file_path: 'package.json' },
      { path: '.' },
      { pattern: 'package.json' },
    ]) {
      const result = runHook(cwd, 'check-onboarding-gate', { tool_input: toolInput });
      const parsed = parseStdoutJson(result);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /onboarding is not complete/);
    }
  });
});

test('onboarding gate repairs missing bookkeeping after required choices exist', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 3,
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      realtime: 'light',
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      codeGraphProvider: 'gitnexus',
      team: { mode: 'subagents', source: 'prompted' },
      onboardingComplete: true,
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });
    const parsed = parseStdoutJson(result);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));

    assert.match(parsed.hookSpecificOutput.additionalContext, /Project-local rules\/skills/);
    assert.equal(state.version, '2.9.31');
    assert.equal(state.confirmed, true);
    assert.ok(state.confirmedAt);
    assert.ok(Array.isArray(state.technologies.frontend));
    assert.ok(state.toolchain.gitnexus);
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'create-page', 'SKILL.md')));
  });
});

test('onboarding gate still denies when required graph choice is missing', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 3,
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
      team: { mode: 'subagents', source: 'prompted' },
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-13T10:00:00Z',
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });
    const parsed = parseStdoutJson(result);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /codeGraphProvider/);
  });
});

test('onboarding gate still denies when required team choice is missing', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: '2.9.31',
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
      realtime: 'none',
      codeGraphProvider: 'gitnexus',
      toolchain: require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs')).initializeToolchainState({}),
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-13T10:00:00Z',
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });
    const parsed = parseStdoutJson(result);

    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /team/);
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /remaining Code Graph and Team prompts/);
  });
});

test('onboarding gate allows .traffic-one.json repair writes with relative or absolute paths', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 3,
      mode: 'new-project',
    });

    const relative = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { file_path: '.traffic-one.json' },
    });
    const absolute = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { file_path: path.join(cwd, '.traffic-one.json') },
    });

    assert.equal(relative.stdout, '');
    assert.equal(absolute.stdout, '');
  });
});

test('onboarding gate allows tools only after complete v3 onboarding state exists', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), completeDefaultState({ codeGraphProvider: 'graphify' }));

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'npm view react version' },
    });

    assert.doesNotMatch(result.stdout, /permissionDecision/);
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
  });
});

test('Supabase missing-config setup CTAs must route through Traffic', () => {
  const sources = {
    supabaseRule: readRule('rules/frontend/react/supabase-client.md'),
    newProjectRule: readRule('rules/modes/new-project.md'),
    stacks: fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks.cjs'), 'utf8'),
    directives: fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8'),
    createFeature: fs.readFileSync(path.join(ROOT, 'skills-templates', 'create-feature', 'SKILL.md'), 'utf8'),
    createPage: fs.readFileSync(path.join(ROOT, 'skills-templates', 'create-page', 'SKILL.md'), 'utf8'),
    createService: fs.readFileSync(path.join(ROOT, 'skills-templates', 'create-service', 'SKILL.md'), 'utf8'),
    promptTemplates: fs.readFileSync(
      path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
      'utf8',
    ),
    frontendAgent: fs.readFileSync(path.join(ROOT, 'agents', 'senior-frontend.md'), 'utf8'),
    reviewerAgent: fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8'),
    cursorSupabaseRule: readCursorRule('react-supabase-client.mdc', 'rules/frontend/react/supabase-client.md'),
    cursorNewProjectRule: readCursorRule('mode-new-project.mdc', 'rules/modes/new-project.md'),
    cursorFrontendAgent: fs.readFileSync(path.join(ROOT, '.cursor', 'rules', '00-agent-senior-frontend.mdc'), 'utf8'),
    cursorReviewerAgent: fs.readFileSync(path.join(ROOT, '.cursor', 'rules', '00-agent-senior-reviewer.mdc'), 'utf8'),
  };

  for (const [name, content] of Object.entries(sources).filter(([name]) => name !== 'stacks')) {
    assert.match(content, /https:\/\/traffic\.io\//, `${name} must mention the Traffic setup URL`);
  }

  assert.match(sources.supabaseRule, /href` is exactly `https:\/\/traffic\.io\/`/);
  assert.match(sources.supabaseRule, /Add a regression test for the Traffic CTA/);
  assert.match(sources.newProjectRule, /protected-route\s+fallbacks/);
  assert.match(sources.stacks, /rules\/frontend\/react\/supabase-client\.md/);
  assert.match(sources.directives, /MUST link to[\s\S]*https:\/\/traffic\.io\//);
  assert.match(sources.promptTemplates, /https:\/\/traffic\.io\//);
  assert.match(sources.promptTemplates, /exact `href`/);
  assert.match(sources.frontendAgent, /protected-route fallbacks/);
  assert.match(sources.reviewerAgent, /not directly to the Supabase\s+dashboard/);
  assert.match(sources.cursorSupabaseRule, /href` is exactly `https:\/\/traffic\.io\/`/);
  assert.match(sources.cursorNewProjectRule, /protected-route\s+fallbacks/);
});

test('SessionStart bundle includes Supabase Traffic setup CTA rule', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-08T10:00:00Z',
    });

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /rules\/frontend\/react\/supabase-client\.md/);
    assert.match(context, /https:\/\/traffic\.io\//);
    assert.match(context, /Add a regression test for the Traffic CTA/);
  });
});

test('new projects must include the auto-documentation baseline', () => {
  const documentationRules = readRule('rules/common/documentation.md');
  const newProjectRule = readRule('rules/modes/new-project.md');
  const directives = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8');
  const stacks = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks.cjs'), 'utf8');
  const architect = fs.readFileSync(path.join(ROOT, 'agents', 'senior-architect.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const promptTemplates = fs.readFileSync(
    path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  const agentsMirror = readRootAgentContext();
  const claude = readClaudeContext();
  const cursorDocumentation = readCursorRule('common-documentation.mdc', 'rules/common/documentation.md');
  const cursorNewProject = readCursorRule('mode-new-project.mdc', 'rules/modes/new-project.md');

  assert.match(documentationRules, /For `mode: new-project`, this is mandatory/);
  assert.match(newProjectRule, /Mandatory auto-documentation baseline/);
  assert.match(newProjectRule, /Do not leave the project with only a README/);
  assert.match(directives, /Mandatory docs baseline/);
  assert.match(directives, /do not leave only a lightweight README/);
  assert.match(stacks, /rules\/common\/documentation\.md/);
  assert.match(architect, /mandatory for every `mode: new-project`/);
  assert.match(architect, /do not leave only a README/);
  assert.match(reviewer, /Missing facts are\s+explicitly `Unverified`/);
  assert.match(promptTemplates, /run `project-memory` and\s+`auto-documentation-generator` after the plan even/);
  assert.match(agentsMirror, /auto-documentation-generator/);
  assert.match(claude, /auto-documentation-generator/);
  assert.match(cursorDocumentation, /For `mode: new-project`, this is mandatory/);
  assert.match(cursorNewProject, /Mandatory auto-documentation baseline/);
});

test('project memory baseline is integrated across runtimes', () => {
  const memoryRules = readRule('rules/common/project-memory.md');
  const memorySkill = fs.readFileSync(path.join(ROOT, 'skills-templates', 'project-memory', 'SKILL.md'), 'utf8');
  const newProjectRule = readRule('rules/modes/new-project.md');
  const existingRule = readRule('rules/modes/existing-codebase.md');
  const directives = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8');
  const stacks = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks.cjs'), 'utf8');
  const skillFilters = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'skill-filters.cjs'), 'utf8');
  const architect = fs.readFileSync(path.join(ROOT, 'agents', 'senior-architect.md'), 'utf8');
  const backend = fs.readFileSync(path.join(ROOT, 'agents', 'senior-backend.md'), 'utf8');
  const shipper = fs.readFileSync(path.join(ROOT, 'agents', 'senior-shipper.md'), 'utf8');
  const promptTemplates = fs.readFileSync(
    path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  const agentsMirror = readRootAgentContext();
  const claude = readClaudeContext();
  const cursorMemory = readCursorRule('common-project-memory.mdc', 'rules/common/project-memory.md');
  const cursorNewProject = readCursorRule('mode-new-project.mdc', 'rules/modes/new-project.md');

  assert.match(memoryRules, /\.traffic-one\/product\.md/);
  assert.match(memoryRules, /Root `\.traffic-one\.json`/);
  assert.match(memoryRules, /\.traffic-one\/decisions\//);
  assert.match(memoryRules, /\.traffic-one\/coding\.md/);
  assert.match(memoryRules, /\.traffic-one\/deployments\.jsonl/);
  assert.match(memoryRules, /\.traffic-one\/mcp\.json/);
  assert.match(memoryRules, /Root `AGENTS\.md` contains the\s+compact active rule kernel and index by default/);
  assert.doesNotMatch(memoryRules, /Root `AGENTS\.md` should symlink/);
  assert.doesNotMatch(memoryRules, /\.traffic-one\/rules\/AGENTS\.md`: canonical/);
  assert.match(memorySkill, /root `AGENTS\.md` containing the compact active rule kernel\/index by default/);
  assert.match(memorySkill, /Create, refresh, or audit the Traffic One `.traffic-one\/` project memory/);
  assert.match(memorySkill, /root `\.traffic-one\.json`/);
  assert.match(newProjectRule, /Project memory baseline/);
  assert.match(newProjectRule, /root `\.traffic-one\.json` exists/);
  assert.match(newProjectRule, /Root `AGENTS\.md` is the canonical active agent context/);
  assert.match(existingRule, /run the `project-memory` baseline reconciliation/);
  assert.match(existingRule, /root `\.traffic-one\.json` exists/);
  assert.match(directives, /Project memory baseline: create/);
  assert.match(directives, /Verify the root companion state file/);
  assert.match(directives, /project-memory/);
  assert.match(directives, /Root AGENTS\.md contains the compact active rule kernel\/index by\s+default/);
  assert.match(stacks, /rules\/common\/project-memory\.md/);
  assert.match(skillFilters, /'project-memory'/);
  assert.match(architect, /project-memory/);
  assert.match(backend, /refresh `.traffic-one\/schema\.sql`/);
  assert.match(shipper, /Append one JSON line to `.traffic-one\/deployments\.jsonl`/);
  assert.match(promptTemplates, /Read .traffic-one.json plus existing project memory/);
  assert.match(agentsMirror, /\.traffic-one\/skills\/project-memory\/SKILL\.md/);
  assert.match(claude, /\.traffic-one\/skills\/project-memory\/SKILL\.md/);
  assert.match(cursorMemory, /\.traffic-one\/agent-log\.md/);
  assert.match(cursorNewProject, /Project memory baseline/);
});

test('SessionStart bundle includes project-memory guidance and banner', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-08T12:00:00Z',
    });
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'product.md'), '# Product\n', 'utf8');

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /\[memory\] \.traffic-one\/ project memory present/);
    assert.match(context, /rules\/common\/project-memory\.md/);
    assert.match(context, /\.traffic-one\/product\.md/);
    assert.match(context, /\.traffic-one\/deployments\.jsonl/);
  });
});

test('SessionStart bundle includes mandatory auto-docs guidance', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-08T12:00:00Z',
    });

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /rules\/common\/documentation\.md/);
    assert.match(context, /For `mode: new-project`, this is mandatory across every stack/);
    assert.match(context, /new project complete with only a lightweight README/);
  });
});

test('existing projects must reconcile the auto-documentation baseline', () => {
  const documentationRules = readRule('rules/common/documentation.md');
  const existingRule = readRule('rules/modes/existing-codebase.md');
  const directives = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8');
  const architect = fs.readFileSync(path.join(ROOT, 'agents', 'senior-architect.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const autoDocs = fs.readFileSync(path.join(ROOT, 'skills-templates', 'auto-documentation-generator', 'SKILL.md'), 'utf8');
  const promptTemplates = fs.readFileSync(
    path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  const agentsMirror = readRootAgentContext();
  const cursorDocumentation = readCursorRule('common-documentation.mdc', 'rules/common/documentation.md');
  const cursorExisting = readCursorRule('mode-existing-codebase.mdc', 'rules/modes/existing-codebase.md');

  assert.match(documentationRules, /For `mode: existing-codebase` and `mode: existing-with-supabase`/);
  assert.match(documentationRules, /If a canonical doc does not\s+exist, create it from verified repo facts at the repo root/);
  assert.match(documentationRules, /If it already\s+exists, update it in place/);
  assert.match(documentationRules, /legacy canonical docs exist under `docs\/`, migrate/);
  assert.match(existingRule, /Before normal feature work/);
  assert.match(existingRule, /If a canonical doc does not exist, create it from verified repo facts at the\s+repo root/);
  assert.match(existingRule, /If a canonical doc already exists, update it in place/);
  assert.match(directives, /create missing canonical docs at the repo root and update existing docs in place/);
  assert.match(architect, /every `mode: existing-codebase` \/ `existing-with-supabase`/);
  assert.match(reviewer, /Existing projects have had the same docs baseline reconciled/);
  assert.match(autoDocs, /In existing projects, reconcile the docs baseline/);
  assert.match(promptTemplates, /`existing-with-supabase`, run them before normal feature work/);
  assert.match(agentsMirror, /\.traffic-one\/rules\/common\/documentation\.md/);
  assert.match(cursorDocumentation, /For `mode: existing-codebase` and `mode: existing-with-supabase`/);
  assert.match(cursorExisting, /If a canonical doc already exists, update it in place/);
});

test('existing project SessionStart includes docs reconciliation guidance', () => {
  withTempDir((cwd) => {
    makeExistingProject(cwd, {
      react: '^18.0.0',
      '@vitejs/plugin-react': '^4.0.0',
      vite: '^6.0.0',
    });

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));

    assert.equal(state.mode, 'existing-codebase');
    assert.match(context, /auto-documentation baseline reconciliation/);
    assert.match(context, /rules\/common\/documentation\.md/);
    assert.match(context, /create missing canonical docs at the repo root and update existing docs in place/);
    assert.match(context, /Before normal feature work/);
  });
});

test('all stack bundles include documentation defaults', () => {
  for (const [stackId, spec] of Object.entries(STACKS)) {
    assert.equal(
      spec.mandatory.includes('rules/common/documentation.md'),
      true,
      `${stackId} must load documentation defaults mandatorily`,
    );
  }
});

test('SEO baseline is mandatory for generated and existing web projects', () => {
  const seoRule = readRule('rules/common/seo.md');
  const seoSkill = fs.readFileSync(path.join(ROOT, 'skills-templates', 'seo', 'SKILL.md'), 'utf8');
  const newProjectRule = readRule('rules/modes/new-project.md');
  const existingRule = readRule('rules/modes/existing-codebase.md');
  const directives = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8');
  const architect = fs.readFileSync(path.join(ROOT, 'agents', 'senior-architect.md'), 'utf8');
  const frontend = fs.readFileSync(path.join(ROOT, 'agents', 'senior-frontend.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const tester = fs.readFileSync(path.join(ROOT, 'agents', 'senior-tester.md'), 'utf8');
  const createPage = fs.readFileSync(path.join(ROOT, 'skills-templates', 'create-page', 'SKILL.md'), 'utf8');
  const createFeature = fs.readFileSync(path.join(ROOT, 'skills-templates', 'create-feature', 'SKILL.md'), 'utf8');
  const promptTemplates = fs.readFileSync(
    path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  const agentsMirror = readRootAgentContext();
  const claude = readClaudeContext();
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const cursorSeo = readCursorRule('common-seo.mdc', 'rules/common/seo.md');

  for (const [stackId, spec] of Object.entries(STACKS)) {
    assert.equal(
      spec.mandatory.includes('rules/common/seo.md'),
      true,
      `${stackId} must load SEO defaults mandatorily`,
    );
  }

  assert.match(seoRule, /SEO is not a launch-only cleanup task/);
  assert.match(seoRule, /Seo\.tsx/);
  assert.match(seoRule, /src\/lib\/seo\.ts/);
  assert.match(seoRule, /VITE_SITE_URL/);
  assert.match(seoRule, /noindex,nofollow/);
  assert.match(seoRule, /prerendering\/static rendering/);
  assert.match(seoRule, /every created or changed public route/);
  assert.match(seoSkill, /Traffic One generated-web baseline/);
  assert.match(seoSkill, /for every created or changed public\s+route/);
  assert.match(newProjectRule, /Mandatory SEO baseline/);
  assert.match(newProjectRule, /og-default\.png/);
  assert.match(newProjectRule, /every generated public\s+route's title/);
  assert.match(existingRule, /run the `seo`\s+baseline reconciliation/);
  assert.match(directives, /Mandatory SEO baseline/);
  assert.match(directives, /every generated public route's title/);
  assert.match(directives, /SEO baseline reconciliation/);
  assert.match(architect, /route metadata contract/);
  assert.match(frontend, /rules\/common\/seo\.md/);
  assert.match(frontend, /every created or\s+changed public route/);
  assert.match(reviewer, /mandatory\s+SEO baseline/);
  assert.match(reviewer, /metadata tests for every created or\s+changed public route/);
  assert.match(tester, /metadata coverage/);
  assert.match(tester, /every created or changed public route's title/);
  assert.match(createPage, /SEO plan for public web routes/);
  assert.match(createPage, /for every public\s+route created or changed/);
  assert.match(createFeature, /SEO impact plan/);
  assert.match(createFeature, /for every public route created or changed/);
  assert.match(promptTemplates, /include the route metadata contract/);
  assert.match(promptTemplates, /regression coverage for every created or changed public route/);
  assert.match(agentsMirror, /\.traffic-one\/rules\/common\/seo\.md/);
  assert.match(claude, /\.traffic-one\/rules\/common\/seo\.md/);
  assert.match(readme, /Generated\/existing web SEO baseline/);
  assert.match(cursorSeo, /SEO is not a launch-only cleanup task/);

  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-12T10:00:00Z',
    });

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /rules\/common\/seo\.md/);
    assert.match(context, /Generated Web Baseline/);
    assert.match(context, /VITE_SITE_URL/);
  });

  withTempDir((cwd) => {
    makeExistingProject(cwd, {
      react: '^18.0.0',
      '@vitejs/plugin-react': '^4.0.0',
      vite: '^6.0.0',
    });

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /rules\/common\/seo\.md/);
    assert.match(context, /SEO baseline reconciliation/);
  });
});

test('frontend i18n baseline is mandatory and automatic for UI work', () => {
  const i18nRule = readRule('rules/frontend/i18n.md');
  const reactCore = readRule('rules/frontend/react/core.md');
  const nativeCore = readRule('rules/frontend/react-native/core.md');
  const i18nSkill = fs.readFileSync(path.join(ROOT, 'skills-templates', 'i18n-text', 'SKILL.md'), 'utf8');
  const createPage = fs.readFileSync(path.join(ROOT, 'skills-templates', 'create-page', 'SKILL.md'), 'utf8');
  const createFeature = fs.readFileSync(path.join(ROOT, 'skills-templates', 'create-feature', 'SKILL.md'), 'utf8');
  const createComponent = fs.readFileSync(path.join(ROOT, 'skills-templates', 'create-component', 'SKILL.md'), 'utf8');
  const newProjectRule = readRule('rules/modes/new-project.md');
  const existingRule = readRule('rules/modes/existing-codebase.md');
  const directives = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8');
  const frontend = fs.readFileSync(path.join(ROOT, 'agents', 'senior-frontend.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const tester = fs.readFileSync(path.join(ROOT, 'agents', 'senior-tester.md'), 'utf8');
  const promptTemplates = fs.readFileSync(
    path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  const agentsMirror = readRootAgentContext();
  const claude = readClaudeContext();

  for (const state of [
    { stack: 'default', frontend: 'react-vite', backend: 'supabase' },
    { stack: 'custom-frontend', frontend: 'react-vite', backend: 'none' },
    {
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { enabled: true, framework: 'react-native-expo' },
    },
  ]) {
    const spec = stackSpecForState(state);
    assert.equal(
      spec.mandatory.includes('rules/frontend/i18n.md'),
      true,
      `${spec.label} must load frontend i18n defaults mandatorily`,
    );
  }

  assert.match(i18nRule, /even when the user did not explicitly ask for translations/);
  assert.match(i18nRule, /Prefer `<Trans>`/);
  assert.match(i18nRule, /Do not\s+create a parallel translation system/);
  assert.match(reactCore, /Detect and extend existing i18n modules automatically/);
  assert.match(nativeCore, /Detect and extend existing i18n modules automatically/);
  assert.match(i18nSkill, /Do not wait for the user to mention i18n/);
  assert.match(i18nSkill, /Prefer `<Trans>` over `t\(\)`/);
  assert.match(createPage, /Before writing page UI, detect the project's i18n module/);
  assert.match(createFeature, /Before writing feature UI, detect the project's i18n module/);
  assert.match(createComponent, /Before writing component UI, detect the project's i18n module/);
  assert.match(newProjectRule, /New Traffic One frontend projects include `packages\/i18n` by default/);
  assert.match(existingRule, /reconcile the i18n baseline/);
  assert.match(directives, /Mandatory i18n baseline/);
  assert.match(directives, /Do not wait for the\s+user to request translations/);
  assert.match(frontend, /Before writing UI, apply `rules\/frontend\/i18n\.md`/);
  assert.match(reviewer, /uses `<Trans>` instead of\s+`t\(\)`/);
  assert.match(tester, /translated accessible names and labels/);
  assert.match(promptTemplates, /even when the user did not\s+mention translations/);
  assert.match(promptTemplates, /prefer `<Trans>`/);
  assert.match(agentsMirror, /rules\/frontend\/i18n\.md/);
  assert.match(claude, /rules\/frontend\/i18n\.md/);

  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-12T10:00:00Z',
    });

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;

    assert.match(context, /rules\/frontend\/i18n\.md/);
    assert.match(context, /i18n-text/);
  });
});

test('all stack bundles include project-memory defaults', () => {
  for (const [stackId, spec] of Object.entries(STACKS)) {
    assert.equal(
      spec.mandatory.includes('rules/common/project-memory.md'),
      true,
      `${stackId} must load project-memory defaults mandatorily`,
    );
  }
});

test('frontend stack bundles load design quality rules mandatorily', () => {
  const frontendStacks = [
    'default',
    'custom-backend',
  ];

  for (const stackId of frontendStacks) {
    const mandatory = STACKS[stackId].mandatory;
    assert.equal(
      mandatory.includes('rules/frontend/ui-quality.md'),
      true,
      `${stackId} must always load the shared UI quality gate`,
    );
    assert.equal(
      mandatory.includes('rules/frontend/typography.md'),
      true,
      `${stackId} must always load typography rules`,
    );
  }

  for (const stackId of ['default', 'custom-backend']) {
    assert.equal(
      STACKS[stackId].mandatory.includes('rules/frontend/react/design-quality.md'),
      true,
      `${stackId} must always load React design quality rules`,
    );
  }
});

test('SessionStart bundle includes mandatory frontend design gate', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-08T13:00:00Z',
    });

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /rules\/frontend\/ui-quality\.md/);
    assert.match(context, /Central design gate/);
    assert.match(context, /rules\/frontend\/typography\.md/);
    assert.match(context, /rules\/frontend\/react\/design-quality\.md/);
    assert.match(context, /Mandatory frontend design gate/);
    assert.match(context, /sparse shell whose\s+visible product surface is only config banners/);
  });
});

test('React Native SessionStart bundle includes shared design gate', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 2,
      mode: 'new-project',
      stack: 'react-native-expo-app',
      backend: 'supabase',
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-08T13:05:00Z',
    });

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /rules\/frontend\/ui-quality\.md/);
    assert.match(context, /Central design gate/);
    assert.match(context, /rules\/frontend\/typography\.md/);
    assert.match(context, /Mandatory frontend design gate/);
  });
});

test('frontend design gate rejects sparse config-banner-dominated generated UI', () => {
  const sources = {
    uiQuality: readRule('rules/frontend/ui-quality.md'),
    reactDesign: readRule('rules/frontend/react/design-quality.md'),
    newProjectRule: readRule('rules/modes/new-project.md'),
    directives: fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8'),
    frontendSkill: fs.readFileSync(path.join(ROOT, 'skills-templates', 'frontend-design', 'SKILL.md'), 'utf8'),
    createPage: fs.readFileSync(path.join(ROOT, 'skills-templates', 'create-page', 'SKILL.md'), 'utf8'),
    createFeature: fs.readFileSync(path.join(ROOT, 'skills-templates', 'create-feature', 'SKILL.md'), 'utf8'),
    frontendAgent: fs.readFileSync(path.join(ROOT, 'agents', 'senior-frontend.md'), 'utf8'),
    reviewerAgent: fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8'),
    agentsMirror: readRootAgentContext(),
    claudeManifest: readClaudeContext(),
  };

  assert.match(sources.uiQuality, /Generated app\/site prompts must produce a product-specific/);
  assert.match(sources.uiQuality, /Do not duplicate missing-config banners/);
  assert.match(sources.reactDesign, /Never ship a page whose main visible surface is duplicated/);
  assert.match(sources.newProjectRule, /Mandatory frontend design gate/);
  assert.match(sources.newProjectRule, /This applies to every\s+frontend stack/);
  assert.match(sources.directives, /Mandatory design gate/);
  assert.match(sources.directives, /duplicated config banners/);
  assert.match(sources.frontendSkill, /mandatory pre-code gate/);
  assert.match(sources.frontendSkill, /one shared setup banner/);
  assert.match(sources.createPage, /product-specific demo/);
  assert.match(sources.createFeature, /product-specific demo/);
  assert.match(sources.frontendAgent, /2–3 real products/);
  assert.match(sources.frontendAgent, /do not ship only banners plus inactive filters/);
  assert.match(sources.reviewerAgent, /mandatory design gate/);
  assert.match(sources.reviewerAgent, /duplicated setup UI/);
  assert.match(sources.agentsMirror, /Active Rules/);
  assert.match(sources.claudeManifest, /Active Rules/);
});

test('existing React Native project SessionStart includes docs reconciliation guidance', () => {
  withTempDir((cwd) => {
    makeExistingProject(cwd, {
      expo: '^52.0.0',
      react: '^18.0.0',
      'react-native': '^0.76.0',
    });

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));

    assert.equal(state.mode, 'existing-codebase');
    assert.equal(state.stack, 'custom-frontend');
    assert.equal(state.mobile.framework, 'react-native-expo');
    assert.match(context, /rules\/common\/documentation\.md/);
    assert.match(context, /create missing canonical docs at the repo root and update existing docs in place/);
  });
});

test('existing Go project SessionStart includes docs reconciliation guidance', () => {
  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.com/jobs\n\ngo 1.22\n', 'utf8');
    for (let index = 0; index < 6; index += 1) {
      fs.writeFileSync(
        path.join(cwd, `file${index}.go`),
        `package main\n\nfunc value${index}() int { return ${index} }\n`,
        'utf8',
      );
    }

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));

    assert.equal(state.mode, 'existing-codebase');
    assert.equal(state.stack, 'custom-backend');
    assert.equal(state.backend, 'go');
    assert.match(context, /go\.mod detected/);
    assert.match(context, /rules\/common\/documentation\.md/);
    assert.match(context, /create missing canonical docs at the repo root and update existing docs in place/);
    assert.match(context, /Before normal feature work/);
  });
});

test('existing unknown stack falls back to minimal with docs reconciliation guidance', () => {
  withTempDir((cwd) => {
    for (let index = 0; index < 6; index += 1) {
      fs.writeFileSync(
        path.join(cwd, `module${index}.py`),
        `def value_${index}():\n    return ${index}\n`,
        'utf8',
      );
    }

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));

    assert.equal(state.mode, 'existing-codebase');
    assert.equal(state.stack, 'minimal');
    assert.match(context, /existing codebase detected/);
    assert.match(context, /rules\/common\/documentation\.md/);
    assert.match(context, /create missing canonical docs at the repo root and update existing docs in place/);
  });
});

test('next project detects frontend without react stack', () => {
  withTempDir((cwd) => {
    makeExistingProject(cwd, {
      next: '^16.0.0',
      react: '^18.0.0',
    });

    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));
    const context = payload.hookSpecificOutput.additionalContext;

    assert.equal(state.stack, 'custom-frontend');
    assert.equal(state.frontend, 'nextjs');
    assert.match(context, /NextAuth\/Auth\.js/);
    assert.match(context, /nextjs-turbopack/);
    assert.doesNotMatch(context, /rules\/frontend\/react\/core\.md/);
  });
});

test('first-prompt classifier resolves stack, tech, and mobile prompt defaults', () => {
  const { classifyPromptForStack } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'detection.cjs'));

  assert.equal(classifyPromptForStack('simple static landing page for a conference').stack, 'minimal');

  const crm = classifyPromptForStack('Build a CRM app with auth, dashboards, users, and uploads');
  assert.equal(crm.stack, 'default');
  assert.equal(crm.frontend, 'react-vite');
  assert.equal(crm.backend, 'supabase');
  assert.equal(crm.shouldAskMobile, true);

  const next = classifyPromptForStack('Build a Next.js app with login and billing');
  assert.equal(next.stack, 'custom-frontend');
  assert.equal(next.frontend, 'nextjs');
  assert.equal(next.backend, 'supabase');
  assert.equal(next.shouldAskMobile, true);

  const go = classifyPromptForStack('Build a React admin app with a Go backend');
  assert.equal(go.stack, 'custom-backend');
  assert.equal(go.backend, 'go');

  const custom = classifyPromptForStack('Build a Vue app with a Django backend and Expo mobile app');
  assert.equal(custom.stack, 'custom-stack');
  assert.equal(custom.frontend, 'vue');
  assert.equal(custom.backend, 'django');
  assert.equal(custom.mobile.framework, 'react-native-expo');
  assert.equal(custom.shouldAskMobile, true);

  const mobileOnly = classifyPromptForStack('Build a mobile app for tracking field jobs');
  assert.equal(mobileOnly.stack, 'custom-frontend');
  assert.equal(mobileOnly.backend, 'supabase');
  assert.equal(mobileOnly.mobile.framework, 'ionic-capacitor');
  assert.equal(mobileOnly.shouldAskMobile, true);
});

test('normalizeState initializes toolchain and preserves existing stamps', () => {
  const { normalizeState } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs'));
  const state = {
    stack: 'default',
    backend: 'supabase',
    codeGraphProvider: 'graphify',
    toolchain: {
      gitnexus: {
        installedVersion: '1.6.4',
        installedAt: '2026-05-13T00:00:00Z',
        binPath: '/usr/local/bin/gitnexus',
      },
    },
  };

  assert.equal(normalizeState(state, 'new-project'), true);
  assert.equal(state.toolchain.gitnexus.installedVersion, '1.6.4');
  assert.equal(state.toolchain.gitnexus.installedAt, '2026-05-13T00:00:00Z');
  assert.equal(state.toolchain.gitnexus.binPath, '/usr/local/bin/gitnexus');
  assert.equal(state.toolchain.graphify.installedVersion, null);
  assert.equal(state.toolchain.gitleaks.installedAt, null);
  assert.equal(state.toolchain.trufflehog.installedVersion, null);
});

test('plugin cache detection covers both Claude and Codex installs', () => {
  const { isManagedPluginCachePath } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'config.cjs'));
  const codexCache = path.join(path.sep, 'Users', 'dev', '.codex', 'plugins', 'cache', 'traffic-one-local', 'traffic-one', '2.9.31');
  const claudeCache = path.join(path.sep, 'Users', 'dev', '.claude', 'plugins', 'cache', 'traffic-one-local', 'traffic-one', '2.9.31');
  const sourceCheckout = path.join(path.sep, 'Users', 'dev', 'src', 'traffic-one');

  assert.equal(isManagedPluginCachePath(codexCache), true);
  assert.equal(isManagedPluginCachePath(claudeCache), true);
  assert.equal(isManagedPluginCachePath(sourceCheckout), false);
});

test('materializeProjectAssets copies only active local rules and skills', () => {
  const { materializeProjectAssets } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize.cjs'));
  withTempDir((cwd) => {
    const state = {
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'supabase',
      mobile: { enabled: true, framework: 'react-native-expo', source: 'explicit' },
    };
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'rules', 'coding.md'), '# Coding Rules\n', 'utf8');
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'rules', 'security.md'), '# Security Rules\n', 'utf8');

    const result = materializeProjectAssets(cwd, state);
    assert.ok(result.rules > 0);
    assert.ok(result.skills > 0);
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'frontend', 'react-native', 'core.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'create-native-screen', 'SKILL.md')));
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'golang-patterns', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'nextjs-turbopack', 'SKILL.md')), false);

    const agentsPath = path.join(cwd, 'AGENTS.md');
    const claudePath = path.join(cwd, 'CLAUDE.md');
    const manifestPath = path.join(cwd, '.traffic-one', 'manifest.json');
    assert.ok(fs.existsSync(agentsPath));
    const rootAgents = fs.readFileSync(agentsPath, 'utf8');
    assert.match(rootAgents, /\.traffic-one\/rules\/frontend\/react-native\/core\.md/);
    assert.doesNotMatch(rootAgents, /\.traffic-one\/rules\/active/);
    assert.match(rootAgents, /## Active Rule Kernel/);
    assert.match(rootAgents, /## Read Rules When/);
    assert.match(rootAgents, /## Active Rule Index/);
    assert.doesNotMatch(rootAgents, /## Active Rule Contents/);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'manifest.json')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'coding.md')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'security.md')), false);
    assert.match(fs.readFileSync(path.join(cwd, '.traffic-one', 'coding.md'), 'utf8'), /Coding Rules/);
    assert.match(fs.readFileSync(path.join(cwd, '.traffic-one', 'security.md'), 'utf8'), /Security Rules/);
    assert.equal(fs.lstatSync(claudePath).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(claudePath), 'AGENTS.md');
    assert.match(fs.readFileSync(manifestPath, 'utf8'), /react-native\/core\.md/);
  });
});

test('materializeProjectAssets includes mode-specific local rules', () => {
  const { materializeProjectAssets } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize.cjs'));
  withTempDir((cwd) => {
    const state = {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
    };

    materializeProjectAssets(cwd, state);

    const localRulePath = path.join(cwd, '.traffic-one', 'rules', 'modes', 'new-project.md');
    const manifest = fs.readFileSync(path.join(cwd, '.traffic-one', 'manifest.json'), 'utf8');
    const rootAgents = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');

    assert.ok(fs.existsSync(localRulePath));
    assert.match(manifest, /rules\/modes\/new-project\.md/);
    assert.match(rootAgents, /\.traffic-one\/rules\/modes\/new-project\.md/);
    assert.match(rootAgents, /## Active Rule Kernel/);
    assert.match(rootAgents, /## Active Rule Index/);
    assert.match(rootAgents, /### Mandatory Baseline/);
    assert.match(rootAgents, /### Reference On Demand/);
    assert.doesNotMatch(rootAgents, /## Active Rule Contents/);
    assert.doesNotMatch(rootAgents, /# Mode: New Project/);
    assert.doesNotMatch(rootAgents, /\.traffic-one\/rules\/active/);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'manifest.json')), false);
    assert.equal(fs.lstatSync(path.join(cwd, 'CLAUDE.md')).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(cwd, 'CLAUDE.md')), 'AGENTS.md');
  });
});

test('materializeProjectAssets uses compact root AGENTS by default', () => {
  const { materializeProjectAssets } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize.cjs'));
  withTempDir((root) => {
    const cwd = path.join(root, 'careerforge');
    fs.mkdirSync(cwd, { recursive: true });
    const state = {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
    };

    const result = materializeProjectAssets(cwd, state);
    const rootAgents = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
    const localRulePath = path.join(cwd, '.traffic-one', 'rules', 'modes', 'new-project.md');
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'manifest.json'), 'utf8'));

    assert.equal(result.contextProfile, 'lean');
    assert.equal(manifest.contextProfile, 'lean');
    assert.ok(fs.existsSync(localRulePath));
    assert.match(fs.readFileSync(localRulePath, 'utf8'), /# Mode: New Project/);
    assert.match(rootAgents, /## Active Rule Kernel/);
    assert.match(rootAgents, /## Read Rules When/);
    assert.match(rootAgents, /## Active Rule Index/);
    assert.match(rootAgents, /### Mandatory Baseline/);
    assert.match(rootAgents, /### Reference On Demand/);
    assert.match(rootAgents, /team\.mode="subagents"/);
    assert.match(rootAgents, /rules\/frontend\/ui-quality\.md/);
    assert.doesNotMatch(rootAgents, /## Active Rule Contents/);
    assert.doesNotMatch(rootAgents, /# Mode: New Project/);
    assert.ok(rootAgents.length < 10000, `compact AGENTS too large: ${rootAgents.length} bytes`);
  });
});

test('materializeProjectAssets supports full root AGENTS opt-in', () => {
  const { materializeProjectAssets } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize.cjs'));
  withTempDir((cwd) => {
    const state = {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      contextMode: 'full',
    };

    const result = materializeProjectAssets(cwd, state);
    const rootAgents = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'manifest.json'), 'utf8'));

    assert.equal(result.contextProfile, 'full');
    assert.equal(manifest.contextProfile, 'full');
    assert.match(rootAgents, /## Active Rule Contents/);
    assert.match(rootAgents, /### rules\/modes\/new-project\.md/);
    assert.match(rootAgents, /# Mode: New Project/);
    assert.doesNotMatch(rootAgents, /## Active Rule Kernel/);
  });
});

test('materializeProjectAssets skips the plugin authoring root', () => {
  const { materializeProjectAssets } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize.cjs'));
  const before = readRootAgentContext();
  const result = materializeProjectAssets(ROOT, completeDefaultState());
  const after = readRootAgentContext();

  assert.equal(result.skipped, 'plugin-authoring-root');
  assert.equal(after, before);
});

test('hook configs use universal plugin-root fallback for Claude and Codex', () => {
  const settings = fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8');
  const codexHooks = fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8');
  const combined = `${settings}\n${codexHooks}`;

  assert.match(combined, /TRAFFIC_ONE_PLUGIN_ROOT/);
  assert.match(combined, /CODEX_PLUGIN_ROOT/);
  assert.match(combined, /CLAUDE_PLUGIN_ROOT/);
  assert.doesNotMatch(combined, /node "\\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/hook-runtime\.cjs/);
});

test('Codex manifest discovers full skill templates without cache writes', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.skills, './skills-templates/');
  assert.ok(fs.existsSync(path.join(ROOT, 'skills-templates', 'frontend-design', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'SKILL.md')));
});

test('post-stack-setup materializes local rules after project-memory writes', () => {
  const { initializeToolchainState } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs'));
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 3,
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
      realtime: 'none',
      codeGraphProvider: 'graphify',
      team: { mode: 'subagents', source: 'prompted' },
      toolchain: initializeToolchainState({}),
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-13T10:00:00Z',
    });
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'product.md'), '# Product\n', 'utf8');

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: { file_path: '.traffic-one/product.md' },
    });

    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.match(context, /Project-local rules\/skills materialized/);
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'modes', 'new-project.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'create-page', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'manifest.json')), false);
  });
});

test('materialize-project normalizes partial state and writes local rules/skills', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: 'web-only',
      codeGraphProvider: 'gitnexus',
      team: { mode: 'subagents', source: 'prompted' },
      onboardingComplete: true,
    });

    const result = runHook(cwd, 'materialize-project');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));

    assert.match(context, /Project-local rules\/skills/);
    assert.equal(state.version, '2.9.31');
    assert.equal(state.confirmed, true);
    assert.equal(state.onboardingComplete, true);
    assert.equal(state.mobile.framework, 'none');
    assert.equal(state.mobile.enabled, false);
    assert.ok(Array.isArray(state.technologies.frontend));
    assert.ok(state.toolchain.gitnexus);
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'modes', 'new-project.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'create-page', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'manifest.json')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'AGENTS.md')), false);
    assert.ok(fs.existsSync(path.join(cwd, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'CLAUDE.md')));
  });
});

test('materialize-project canonicalizes mobile source aliases before validation', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), completeDefaultState({
      mobile: { enabled: false, framework: 'none', source: 'user-onboarding' },
      codeGraphProvider: 'graphify',
    }));

    const result = runHook(cwd, 'materialize-project');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));

    assert.match(context, /Project-local rules\/skills/);
    assert.equal(state.mobile.source, 'prompted');
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
  });
});

test('materialize-project canonicalizes team aliases before validation', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), completeDefaultState({
      team: { mode: 'run-team', source: 'user-onboarding' },
      codeGraphProvider: 'graphify',
    }));

    const result = runHook(cwd, 'materialize-project');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));

    assert.match(context, /Project-local rules\/skills/);
    assert.equal(state.team.mode, 'subagents');
    assert.equal(state.team.source, 'prompted');
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
  });
});

test('materialize-project warning names invalid mobile source instead of blaming stack', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), completeDefaultState({
      mobile: { enabled: false, framework: 'none', source: 'definitely-invalid' },
      codeGraphProvider: 'graphify',
    }));

    const result = runHook(cwd, 'materialize-project');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;

    assert.match(payload.systemMessage, /incomplete/);
    assert.match(context, /mobile\.source/);
    assert.match(context, /definitely-invalid/);
    assert.doesNotMatch(context, /without a `stack` field/);
  });
});

test('post-tool convergence materializes complete state without write-specific payload', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), completeDefaultState());
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Existing project note\n\nKeep this note.\n', 'utf8');

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: { tool_name: 'future-host-patch-tool' },
    });
    const payload = parseStdoutJson(result);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));
    const rootAgents = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');

    assert.match(payload.hookSpecificOutput.additionalContext, /Project-local rules\/skills/);
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(state.materializedAt);
    assert.ok(state.materializedVersion);
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'modes', 'new-project.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'create-page', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'AGENTS.local.md')));
    assert.match(fs.readFileSync(path.join(cwd, '.nvmrc'), 'utf8'), /^22\n$/);
    assert.match(rootAgents, /Traffic One Local Agent Context/);
    assert.match(rootAgents, /Preserved Project Notes/);
    assert.match(rootAgents, /Keep this note/);
    assert.equal(fs.lstatSync(path.join(cwd, 'CLAUDE.md')).isSymbolicLink(), true);
  });
});

test('post-tool convergence materializes nested project mentioned by Codex cmd path', () => {
  withTempDir((cwd) => {
    const target = path.join(cwd, 'tests', 'jobconnect');
    const sibling = path.join(cwd, 'tests', 'existing-project');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    writeJson(path.join(target, '.traffic-one.json'), completeDefaultState({
      codeGraphProvider: 'graphify',
      materializedStack: 'react-vite-supabase',
      materializedAt: new Date().toISOString(),
      materializedVersion: 'manual',
    }));
    writeJson(path.join(sibling, '.traffic-one.json'), completeDefaultState({
      codeGraphProvider: 'graphify',
    }));

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: {
        cmd: 'mkdir -p tests/jobconnect/apps/web tests/jobconnect/packages',
      },
    });
    const payload = parseStdoutJson(result);
    const state = JSON.parse(fs.readFileSync(path.join(target, '.traffic-one.json'), 'utf8'));

    assert.match(payload.hookSpecificOutput.additionalContext, /Project-local rules\/skills/);
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(fs.existsSync(path.join(target, '.traffic-one', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(target, '.traffic-one', 'rules', 'modes', 'new-project.md')));
    assert.ok(fs.existsSync(path.join(target, '.traffic-one', 'skills', 'create-page', 'SKILL.md')));
    assert.equal(
      fs.existsSync(path.join(sibling, '.traffic-one', 'manifest.json')),
      false,
      'only the nested project named in the command should be materialized',
    );
  });
});

test('pre-tool convergence repairs missing materialized assets before feature gates', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      ...completeDefaultState(),
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: '2026-05-13T10:00:00Z',
      materializedVersion: '2.9.31',
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'future-host-read-or-build' },
    });
    const payload = parseStdoutJson(result);

    assert.match(payload.hookSpecificOutput.additionalContext, /Project-local rules\/skills/);
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'modes', 'new-project.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'create-page', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'CLAUDE.md')));
  });
});

test('session-start repairs fake materialization stamps before subagent fast path', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      ...completeDefaultState(),
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: new Date().toISOString(),
      materializedVersion: '2.9.31',
      currentRunId: '2026-05-18T12-04-52Z',
      activeAgentRole: 'senior-frontend',
      spawnIndex: { 'senior-frontend': 1 },
    });

    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));

    assert.match(context, /senior-frontend/);
    assert.match(context, /materialized to \.traffic-one\/rules/);
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'modes', 'new-project.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'frontend-design', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'CLAUDE.md')));
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(state.materializedAt);
  });
});

test('post-stack-setup reports local materialization failures', () => {
  const { initializeToolchainState } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs'));
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 3,
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
      realtime: 'none',
      codeGraphProvider: 'graphify',
      team: { mode: 'subagents', source: 'prompted' },
      toolchain: initializeToolchainState({}),
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-13T10:00:00Z',
    });
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'rules', 'common'), 'not a directory\n', 'utf8');
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'product.md'), '# Product\n', 'utf8');

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: { file_path: '.traffic-one/product.md' },
    });

    const payload = parseStdoutJson(result);
    assert.match(payload.systemMessage, /materialization failed/);
    assert.match(payload.hookSpecificOutput.additionalContext, /\.traffic-one\/rules/);
  });
});

test('architecture hook blocks invalid component write', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), { stack: 'react-frontend-only' });

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'apps/web/src/Button.tsx',
        content: 'export const Button = (props: any) => <div style={{ color: "red" }} />;\n',
      },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /Components must live/);
    assert.match(result.stdout, /No inline styles/);
    assert.match(result.stdout, /Avoid `any`/);
  });
});

test('architecture hook blocks websocket outside services', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), { stack: 'react-frontend-only' });

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'apps/web/src/features/chat/components/Chat.tsx',
        content: 'const socket = new WebSocket("wss://example.test");\n',
      },
    });

    assert.match(result.stdout, /Open WebSocket connections only/);
  });
});

test('malformed stdin exits cleanly', () => {
  withTempDir((cwd) => {
    const result = runHook(cwd, 'check-library-allowlist', '{bad json');
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
});

test('python backend rule still rejects hand-rolled jwt default', () => {
  const pythonRule = readRule('rules/backend/python.md');
  assert.match(pythonRule, /do not default FastAPI apps to hand-rolled JWT auth/);
});

test('library-pick checks catalog before candidates', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills-templates', 'library-pick', 'SKILL.md'), 'utf8');
  assert.match(skill, /rules\/common\/library-catalog\.md/);
  assert.match(skill, /date-fns or dayjs/);
});

test('web stack denies vanilla-extract installs', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), { stack: 'react-realtime-monorepo' });

    const result = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'pnpm add @vanilla-extract/css @vanilla-extract/recipes' },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /vanilla-extract is no longer in the active stack/);
    assert.match(result.stdout, /Tailwind \+ shadcn/);
  });
});

test('web stack allows tailwindcss and shadcn-adjacent installs', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), { stack: 'react-realtime-monorepo' });

    const result = runHook(cwd, 'check-library-allowlist', {
      tool_input: {
        command: 'pnpm add tailwindcss class-variance-authority tailwind-merge tailwindcss-animate @radix-ui/react-dialog lucide-react',
      },
    });

    assert.equal(result.stdout, '');
  });
});

test('rn stack allows nativewind and denies vanilla-extract', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), { stack: 'react-native-expo-monorepo' });

    const allow = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'pnpm add nativewind tailwindcss react-native-reanimated' },
    });
    assert.equal(allow.stdout, '', 'nativewind/tailwindcss should be allowed on the Expo stack');

    const deny = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'pnpm add @vanilla-extract/css' },
    });
    assert.match(deny.stdout, /permissionDecision/);
    assert.match(deny.stdout, /vanilla-extract is web-only/);
  });
});

test('architecture hook blocks vanilla-extract imports on web', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), { stack: 'react-realtime-monorepo' });

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'apps/web/src/components/Card.tsx',
        content: "import { style } from '@vanilla-extract/css';\nexport const Card = () => <div className=\"p-4\" />;\n",
      },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /vanilla-extract is no longer in the active stack/);
  });
});

// ── Plan gate (senior-architect must run first on new projects) ─────────────

test('plan-gate denies feature write on new-project without plan', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
    });

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'apps/web/src/features/billing/index.ts',
        content: 'export const x = 1;\n',
      },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /Plan gate/);
    assert.match(result.stdout, /senior-architect/);
  });
});

test('state-gate denies feature write when project memory exists without state', () => {
  withTempDir((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'plan.md'), '# Plan\n', 'utf8');
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'stack.md'), '# Stack\n', 'utf8');

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'apps/web/src/features/jobs/index.ts',
        content: 'export const x = 1;\n',
      },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /State gate/);
    assert.match(result.stdout, /\.traffic-one\.json/);
  });
});

test('plan-gate allows feature write when plan exists', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
    });
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'plan.md'), '# Plan\n', 'utf8');

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'apps/web/src/features/billing/index.ts',
        content: 'export const x = 1;\n',
      },
    });

    assert.equal(result.stdout, '');
  });
});

test('materialization gate blocks forged stamp when local assets are missing', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      ...completeDefaultState({
        materializedStack: 'default|react-vite|supabase|none',
        materializedAt: '2026-05-13T10:00:00Z',
        materializedVersion: '2.9.31',
      }),
    });
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'plan.md'), '# Plan\n', 'utf8');
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'rules'), 'blocks materialization\n', 'utf8');

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'apps/web/src/features/jobs/index.ts',
        content: 'export const x = 1;\n',
      },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /Materialization gate/);
    assert.match(result.stdout, /\.traffic-one\/rules/);
  });
});

test('run-team enforcement blocks parent feature writes after subagent choice', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), completeDefaultState());
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'plan.md'), '# Plan\n', 'utf8');

    runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'apps/web/src/features/jobs/index.ts',
        content: 'export const x = 1;\n',
      },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /Run-team enforcement gate/);
    assert.match(result.stdout, /team\.mode=\\?"subagents\\?"/);
    assert.match(result.stdout, /senior-frontend/);
    assert.match(result.stdout, /senior-backend/);
  });
});

test('run-team enforcement blocks Bash feature-source writes', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), completeDefaultState());
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'plan.md'), '# Plan\n', 'utf8');

    runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        command: "cat > apps/web/src/features/jobs/index.ts <<'EOF'\nexport const x = 1;\nEOF",
      },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /Run-team enforcement gate/);
    assert.match(result.stdout, /Bash-based feature-source writes are denied/);
  });
});

test('run-team enforcement allows active frontend role feature writes', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), completeDefaultState({
      currentRunId: '2026-05-18T16-47-32Z',
      activeAgentRole: 'senior-frontend',
      spawnIndex: { 'senior-frontend': 1 },
    }));
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'plan.md'), '# Plan\n', 'utf8');

    runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'apps/web/src/features/jobs/index.ts',
        content: 'export const x = 1;\n',
      },
    });

    assert.equal(result.stdout, '');
  });
});

test('plan-gate allows .traffic-one/plan.md write itself', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
    });

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: '.traffic-one/plan.md',
        content: '# Plan\n',
      },
    });

    assert.equal(result.stdout, '');
  });
});

test('plan-gate allows root architecture docs on new-project without plan', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
    });

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'architecture.md',
        content: '# Architecture\n',
      },
    });

    assert.equal(result.stdout, '');
  });
});

test('new-project monorepo gate blocks flat root Vite scaffold', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
    });
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'plan.md'), '# Plan\n', 'utf8');

    const rootSrc = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'src/main.tsx',
        content: 'export const App = () => null;\n',
      },
    });

    assert.match(rootSrc.stdout, /permissionDecision/);
    assert.match(rootSrc.stdout, /New-project monorepo gate/);
    assert.match(rootSrc.stdout, /apps\/web/);

    const rootPackage = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'package.json',
        content: JSON.stringify({ private: true, scripts: { dev: 'vite' }, dependencies: { react: '^19.0.0' } }, null, 2),
      },
    });

    assert.match(rootPackage.stdout, /permissionDecision/);
    assert.match(rootPackage.stdout, /workspaces/);
  });
});

test('new-project monorepo gate follows nested project state', () => {
  withTempDir((cwd) => {
    const projectDir = path.join(cwd, 'jobs-platform');
    fs.mkdirSync(path.join(projectDir, '.traffic-one'), { recursive: true });
    writeJson(path.join(projectDir, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
    });
    fs.writeFileSync(path.join(projectDir, '.traffic-one', 'plan.md'), '# Plan\n', 'utf8');

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'jobs-platform/package.json',
        content: JSON.stringify({ private: true, scripts: { dev: 'vite' } }, null, 2),
      },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /New-project monorepo gate/);
    assert.match(result.stdout, /workspaces/);
  });
});

test('new-project monorepo gate allows workspace root package', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
    });
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'plan.md'), '# Plan\n', 'utf8');

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'package.json',
        content: JSON.stringify({
          private: true,
          packageManager: 'pnpm@10.23.0',
          workspaces: ['apps/*', 'packages/*'],
        }, null, 2),
      },
    });

    assert.equal(result.stdout, '');
  });
});

// ── Deploy gate (senior-shipper + security check stamps) ───────────────────

test('deploy-gate denies vercel deploy without shipper stamp', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), { stack: 'react-realtime-monorepo' });

    const result = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'vercel deploy --prod' },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /Deploy gate/);
    assert.match(result.stdout, /senior-shipper/);
  });
});

test('deploy-gate denies vercel deploy without security stamp', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      lastShipperApprovalAt: new Date().toISOString(),
    });

    const result = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'vercel deploy --prod' },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /pre-deployment security check/);
  });
});

test('deploy-gate allows vercel deploy after fresh shipper and security stamps', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
    });
    const fingerprint = computeProjectFingerprint(cwd).fingerprint;
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      lastShipperApprovalAt: new Date().toISOString(),
      lastSecurityCheckAt: new Date().toISOString(),
      lastSecurityCheckStatus: 'passed',
      lastSecurityCheckFingerprint: fingerprint,
      lastSecurityCheckReport: '.traffic-one/reports/security/security-check-test.json',
    });

    const result = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'vercel deploy --prod' },
    });

    assert.equal(result.stdout, '');
  });
});

test('deploy-gate denies after stale shipper stamp', () => {
  withTempDir((cwd) => {
    const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      lastShipperApprovalAt: elevenMinAgo,
    });

    const result = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'vercel deploy --prod' },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /Deploy gate/);
  });
});

test('deploy-gate denies when worktree fingerprint changed after security check', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
    });
    const fingerprint = computeProjectFingerprint(cwd).fingerprint;
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      lastShipperApprovalAt: new Date().toISOString(),
      lastSecurityCheckAt: new Date().toISOString(),
      lastSecurityCheckStatus: 'passed',
      lastSecurityCheckFingerprint: fingerprint,
      lastSecurityCheckReport: '.traffic-one/reports/security/security-check-test.json',
    });
    fs.writeFileSync(path.join(cwd, 'changed.ts'), 'export const changed = true;\n', 'utf8');

    const result = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'vercel deploy --prod' },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /worktree changed/);
  });
});

// ── Token-economy: graphify hooks + handoff-digests rule loading ────────────

test('pre-graphify-hint emits hint when GRAPH_REPORT.md exists', () => {
  withTempDir((cwd) => {
    fs.mkdirSync(path.join(cwd, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'), '# Graph\n', 'utf8');

    const result = runHook(cwd, 'pre-graphify-hint', '');
    assert.notEqual(result.stdout.trim(), '', 'expected hint payload');
    // Provider-aware label: '[graph: graphify]' for the graphify branch.
    assert.match(result.stdout, /\[graph:\s*graphify\]/);
    assert.match(result.stdout, /GRAPH_REPORT\.md/);
  });
});

test('pre-graphify-hint silent when GRAPH_REPORT.md missing', () => {
  withTempDir((cwd) => {
    const result = runHook(cwd, 'pre-graphify-hint', '');
    assert.equal(result.stdout, '');
  });
});

test('post-build-graphify hints on first new-project build without report', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      mode: 'new-project',
      onboardingComplete: true,
      codeGraphProvider: 'graphify',
    });

    const result = runHook(cwd, 'post-build-graphify', {
      tool_input: { command: 'pnpm build' },
    });

    assert.match(result.stdout, /\[graphify\]/);
    assert.match(result.stdout, /pipx install graphifyy/);
  });
});

test('post-build-graphify silent when GRAPH_REPORT.md is fresh', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      mode: 'new-project',
      onboardingComplete: true,
      codeGraphProvider: 'graphify',
    });
    fs.mkdirSync(path.join(cwd, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'), '# Graph\n', 'utf8');

    const result = runHook(cwd, 'post-build-graphify', {
      tool_input: { command: 'pnpm build' },
    });

    assert.equal(result.stdout, '');
  });
});

test('post-build-graphify silent on existing-codebase mode', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      mode: 'existing-codebase',
      onboardingComplete: true,
    });

    const result = runHook(cwd, 'post-build-graphify', {
      tool_input: { command: 'pnpm build' },
    });

    assert.equal(result.stdout, '');
  });
});

test('post-build-graphify silent within cooldown after recent hint', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      mode: 'new-project',
      onboardingComplete: true,
      codeGraphProvider: 'graphify',
      graphifyLastHintedAt: new Date().toISOString(),
    });

    const result = runHook(cwd, 'post-build-graphify', {
      tool_input: { command: 'pnpm build' },
    });

    assert.equal(result.stdout, '');
  });
});

test('SessionStart bundle includes codebase-graph + handoff-digests rules', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-07T14:00:00Z',
    });

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const ctx = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(ctx, /codebase-graph\.md/);
    assert.match(ctx, /agent-handoff-digests\.md/);
  });
});

test('SessionStart bundle includes deployment artifact defaults', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-07T14:00:00Z',
    });

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const ctx = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(ctx, /Deployment artifact baseline/);
    assert.match(ctx, /static-host manifest/);
    assert.match(ctx, /Supabase\s+Branching/);
    assert.match(ctx, /force-update\s+version check/);
  });
});

test('deployment assistant guidance is merged, not duplicated', () => {
  const skillsRoot = path.join(ROOT, 'skills-templates');
  const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const deploymentSkill = fs.readFileSync(path.join(skillsRoot, 'deployment-patterns', 'SKILL.md'), 'utf8');

  assert.equal(skillNames.includes('ai-deployment-assistant'), false);
  assert.equal(skillNames.includes('deployment-assistant'), false);
  assert.match(deploymentSkill, /static-host SPA\/Supabase deployment artifacts/);
  assert.match(deploymentSkill, /Traffic One Deployment Artifact Default/);
});

test('database architect guidance is merged, not duplicated', () => {
  const skillsRoot = path.join(ROOT, 'skills-templates');
  const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const postgresReview = fs.readFileSync(path.join(skillsRoot, 'postgres-review', 'SKILL.md'), 'utf8');
  const postgresRules = readRule('rules/backend/postgres.md');
  const migrationSkill = fs.readFileSync(path.join(skillsRoot, 'database-migrations', 'SKILL.md'), 'utf8');

  assert.equal(skillNames.includes('ai-database-architect'), false);
  assert.equal(skillNames.includes('database-architect'), false);
  assert.equal(skillNames.includes('db-architect'), false);
  assert.match(postgresReview, /AI Database Architect/);
  assert.match(postgresReview, /WITH CHECK/);
  assert.match(postgresReview, /Supabase Security Advisor/);
  assert.match(postgresReview, /PII\/sensitive columns/);
  assert.match(postgresRules, /Index every non-PK column referenced in RLS policies/);
  assert.match(postgresRules, /column-level grants/);
  assert.match(postgresRules, /Realtime subscriptions include filters/);
  assert.match(migrationSkill, /NOT VALID/);
  assert.match(migrationSkill, /ALTER COLUMN TYPE/);
});

test('production readiness score guidance is merged, not duplicated', () => {
  const skillsRoot = path.join(ROOT, 'skills-templates');
  const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const verificationLoop = fs.readFileSync(path.join(skillsRoot, 'verification-loop', 'SKILL.md'), 'utf8');
  const stackRecommendations = readRule('rules/common/stack-recommendations.md');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const shipper = fs.readFileSync(path.join(ROOT, 'agents', 'senior-shipper.md'), 'utf8');
  const agentsMirror = readRootAgentContext();

  assert.equal(skillNames.includes('production-readiness-score'), false);
  assert.equal(skillNames.includes('readiness-score'), false);
  assert.equal(skillNames.includes('ai-production-readiness-score'), false);
  assert.match(verificationLoop, /Production-Readiness Score/);
  assert.match(verificationLoop, /8 weighted dimensions/);
  assert.match(verificationLoop, /OWASP ASVS \/ OWASP Top 10:2025/);
  assert.match(verificationLoop, /AWS Well-Architected/);
  assert.match(verificationLoop, /build\/release\/run/);
  assert.match(verificationLoop, /CrUX/);
  assert.match(verificationLoop, /idempotency keys/);
  assert.match(verificationLoop, /service_role` key in client/);
  assert.match(stackRecommendations, /Production-Readiness Score/);
  assert.match(stackRecommendations, /LCP <= 2\.5s, INP <= 200ms/);
  assert.match(reviewer, /Production-Readiness\s+Score/);
  assert.match(shipper, /Production-Readiness Score/);
  assert.match(agentsMirror, /\.traffic-one\/skills\/verification-loop\/SKILL\.md/);
});

test('post-deploy observability guidance is integrated, not duplicated', () => {
  const skillsRoot = path.join(ROOT, 'skills-templates');
  const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const observability = fs.readFileSync(path.join(skillsRoot, 'observability', 'SKILL.md'), 'utf8');
  const deploymentPatterns = fs.readFileSync(path.join(skillsRoot, 'deployment-patterns', 'SKILL.md'), 'utf8');
  const verificationLoop = fs.readFileSync(path.join(skillsRoot, 'verification-loop', 'SKILL.md'), 'utf8');
  const stackRecommendations = readRule('rules/common/stack-recommendations.md');
  const reactSecurity = readRule('rules/frontend/react/security.md');
  const reactVite = readRule('rules/frontend/react/vite.md');
  const ionicSecurity = readRule('rules/frontend/ionic/security.md');
  const postgresRules = readRule('rules/backend/postgres.md');
  const shipper = fs.readFileSync(path.join(ROOT, 'agents', 'senior-shipper.md'), 'utf8');
  const skillFilters = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'skill-filters.cjs'), 'utf8');
  const agentsMirror = readRootAgentContext();
  const cursorStackRecommendations = readCursorRule('common-stack-recommendations.mdc', 'rules/common/stack-recommendations.md');

  assert.equal(skillNames.includes('post-deploy-observability'), false);
  assert.equal(skillNames.includes('ai-error-fixing'), false);
  assert.equal(skillNames.includes('observability'), true);
  assert.match(observability, /AI fix suggestion format/);
  assert.match(observability, /explicit current-turn user approval/);
  assert.match(deploymentPatterns, /Failed deploys/);
  assert.match(deploymentPatterns, /SLO burn-rate/);
  assert.match(verificationLoop, /pg_stat_statements/);
  assert.match(stackRecommendations, /Post-Deploy Observability Defaults/);
  assert.match(stackRecommendations, /Supabase Logs/);
  assert.match(reactSecurity, /Client observability/);
  assert.match(reactVite, /SENTRY_AUTH_TOKEN/);
  assert.match(ionicSecurity, /Native crash reporting/);
  assert.match(postgresRules, /pg_stat_statements/);
  assert.match(shipper, /failed-deploy log analysis/);
  assert.match(skillFilters, /'observability'/);
  assert.match(agentsMirror, /\.traffic-one\/skills\/observability\/SKILL\.md/);
  assert.match(cursorStackRecommendations, /Post-Deploy Observability Defaults/);
});

test('app launch checklist guidance is integrated, not duplicated', () => {
  const skillsRoot = path.join(ROOT, 'skills-templates');
  const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const launchSkill = fs.readFileSync(path.join(skillsRoot, 'app-launch-checklist', 'SKILL.md'), 'utf8');
  const seo = fs.readFileSync(path.join(skillsRoot, 'seo', 'SKILL.md'), 'utf8');
  const ionicMobile = fs.readFileSync(path.join(skillsRoot, 'ionic-mobile', 'SKILL.md'), 'utf8');
  const deploymentPatterns = fs.readFileSync(path.join(skillsRoot, 'deployment-patterns', 'SKILL.md'), 'utf8');
  const verificationLoop = fs.readFileSync(path.join(skillsRoot, 'verification-loop', 'SKILL.md'), 'utf8');
  const stackRecommendations = readRule('rules/common/stack-recommendations.md');
  const accessibility = readRule('rules/frontend/accessibility.md');
  const performance = readRule('rules/frontend/performance.md');
  const ionicCapacitor = readRule('rules/frontend/ionic/capacitor.md');
  const shipper = fs.readFileSync(path.join(ROOT, 'agents', 'senior-shipper.md'), 'utf8');
  const skillFilters = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'skill-filters.cjs'), 'utf8');
  const agentsMirror = readRootAgentContext();
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const ref = fs.readFileSync(path.join(ROOT, 'ref.md'), 'utf8');
  const codexManifest = fs.readFileSync(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8');
  const cursorStackRecommendations = readCursorRule('common-stack-recommendations.mdc', 'rules/common/stack-recommendations.md');

  assert.equal(skillNames.includes('launch-readiness'), false);
  assert.equal(skillNames.includes('app-store-checklist'), false);
  assert.equal(skillNames.includes('app-launch-checklist'), true);
  assert.match(launchSkill, /WCAG 2\.2 Level AA/);
  assert.match(launchSkill, /Global\s+Privacy Control/);
  assert.match(launchSkill, /PrivacyInfo\.xcprivacy/);
  assert.match(launchSkill, /five\s+external testers/);
  assert.match(seo, /1200x630/);
  assert.match(seo, /manifest\.webmanifest/);
  assert.match(ionicMobile, /Store launch checklist/);
  assert.match(ionicMobile, /Google Play Billing/);
  assert.match(deploymentPatterns, /Launch readiness/);
  assert.match(verificationLoop, /data export\/right-to-access/);
  assert.match(stackRecommendations, /App Launch Checklist Defaults/);
  assert.match(stackRecommendations, /Lighthouse Performance >= 90/);
  assert.match(accessibility, /WCAG 2\.2 Level AA/);
  assert.match(accessibility, /Focus is not obscured/);
  assert.match(performance, /Lighthouse Performance >= 90/);
  assert.match(ionicCapacitor, /Android 15 \/ API level 35/);
  assert.match(ionicCapacitor, /Play App Signing/);
  assert.match(shipper, /app-launch-checklist/);
  assert.match(skillFilters, /'app-launch-checklist'/);
  assert.match(agentsMirror, /app-launch-checklist/);
  assert.match(readme, /app launch checklist/);
  assert.match(ref, /Skills: 101/);
  assert.match(codexManifest, /Run the app launch checklist/);
  assert.match(cursorStackRecommendations, /App Launch Checklist Defaults/);
});

test('auto documentation generator guidance is present and not duplicated', () => {
  const skillsRoot = path.join(ROOT, 'skills-templates');
  const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const autoDocs = fs.readFileSync(path.join(skillsRoot, 'auto-documentation-generator', 'SKILL.md'), 'utf8');
  const adrSkill = fs.readFileSync(path.join(skillsRoot, 'architecture-decision-records', 'SKILL.md'), 'utf8');
  const documentationRules = readRule('rules/common/documentation.md');
  const architect = fs.readFileSync(path.join(ROOT, 'agents', 'senior-architect.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const shipper = fs.readFileSync(path.join(ROOT, 'agents', 'senior-shipper.md'), 'utf8');
  const agentsMirror = readRootAgentContext();
  const claude = readClaudeContext();
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const skillFilters = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'skill-filters.cjs'), 'utf8');

  assert.equal(skillNames.includes('auto-documentation-generator'), true);
  assert.equal(skillNames.includes('documentation-generator'), false);
  assert.equal(skillNames.includes('docs-generator'), false);
  assert.equal(skillNames.includes('auto-docs'), false);
  assert.match(autoDocs, /Auto-Documentation Generator/);
  assert.match(autoDocs, /In existing projects, reconcile the docs baseline/);
  assert.match(autoDocs, /README\.md/);
  assert.match(autoDocs, /AGENTS\.md/);
  assert.match(autoDocs, /CLAUDE\.md/);
  assert.match(autoDocs, /\.cursor\/rules\/\*\.mdc/);
  assert.match(autoDocs, /pg_dump --schema-only --no-owner --no-privileges/);
  assert.match(autoDocs, /RLS policies/);
  assert.match(autoDocs, /Keep a Changelog/);
  assert.match(autoDocs, /Conventional Commits/);
  assert.match(autoDocs, /llms\.txt/);
  assert.match(adrSkill, /Auto-Documentation Generator/);
  assert.match(documentationRules, /Auto-Documentation Defaults/);
  assert.match(documentationRules, /For `mode: new-project`, this is mandatory/);
  assert.match(documentationRules, /Context, Decision, Status, and Consequences/);
  assert.match(architect, /auto-documentation-generator/);
  assert.match(reviewer, /auto-documentation-generator/);
  assert.match(shipper, /auto-documentation-generator/);
  assert.match(agentsMirror, /auto-documentation-generator/);
  assert.match(claude, /auto-documentation-generator/);
  assert.match(readme, /generate project docs/);
  assert.match(skillFilters, /auto-documentation-generator/);
});

test('plan-gate exempts .traffic-one/digests/ writes', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
    });

    // No plan.md but the digest write should be allowed (sibling under .traffic-one/).
    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: '.traffic-one/digests/2026-05-07T14-23-05Z/architect.md',
        content: '# architect digest\n',
      },
    });

    assert.equal(result.stdout, '', 'digest writes must not be blocked by the plan gate');
  });
});

// ── Graphify foreground bootstrap runner ────────────────────────────────────

test('graphify-runner gracefully reports skip when graphify+pipx+python3 absent', () => {
  const { bootstrap } = require(path.join(ROOT, 'scripts', 'graphify-runner.cjs'));
  withTempDir((cwd) => {
    // Force every which() probe to miss by stripping PATH.
    const prevPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-that-does-not-exist';
    try {
      const result = bootstrap(cwd, { skipInstall: true });
      assert.equal(result.ok, false);
      assert.equal(result.action, 'install-skipped');
      assert.match(result.error || '', /not on PATH/);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

test('graphify-runner respects graphifyAutoRun: false opt-out', () => {
  const { bootstrap } = require(path.join(ROOT, 'scripts', 'graphify-runner.cjs'));
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      graphifyAutoRun: false,
    });
    const result = bootstrap(cwd);
    assert.equal(result.ok, false);
    assert.equal(result.action, 'install-skipped');
    assert.match(result.error || '', /graphifyAutoRun is false/);
  });
});

test('graphify-runner short-circuits when GRAPH_REPORT.md is fresh (lets Phase 5 invoke unconditionally)', () => {
  const { bootstrap } = require(path.join(ROOT, 'scripts', 'graphify-runner.cjs'));
  withTempDir((cwd) => {
    fs.mkdirSync(path.join(cwd, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'), '# Graph\n', 'utf8');
    // Force every which() probe to miss so the runner would otherwise fail.
    const prevPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-that-does-not-exist';
    try {
      const result = bootstrap(cwd);
      assert.equal(result.ok, true);
      assert.equal(result.action, 'fresh');
      assert.match(result.report || '', /GRAPH_REPORT\.md$/);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

test('orchestrator Phase 5 dispatches to the chosen codebase-graph runner per provider', () => {
  const orchestrator = fs.readFileSync(path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'SKILL.md'), 'utf8');
  // Both runners must be referenced by the dispatch (case statement) so the
  // post-build hook + Phase 5 stay symmetric.
  assert.match(orchestrator, /graphify-runner\.cjs/);
  assert.match(orchestrator, /gitnexus-runner\.cjs/);
  // The dispatch is a `case "$PROVIDER" in ... esac` block keyed on
  // codeGraphProvider, mirroring the post-build hook's behaviour.
  assert.match(orchestrator, /case\s+"\$PROVIDER"\s+in/);
  assert.match(orchestrator, /codeGraphProvider/);
  // Whitespace-tolerant: text wraps across two lines.
  assert.match(orchestrator.replace(/\s+/g, ' '), /every completed orchestrator session is a strong/i);
});

test('digest rule documents reviewer spillover-note pattern', () => {
  const rule = readRule('rules/common/agent-handoff-digests.md');
  assert.match(rule, /Reviewer findings/);
  assert.match(rule, /reviewer-detail-<n>\.md/);
  assert.match(rule, /≤3 sentences per blocker/);
});

test('graphify-runner uses `graphify update .` (not the outdated `graphify .`)', () => {
  // Regression: cached 2.7.0 stamped `"error: unknown command '.'"` because
  // the runner invoked the wrong subcommand. The fix is `graphify update .`.
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'graphify-runner.cjs'), 'utf8');
  // The exact spawn args must include 'update' as the subcommand and '.' as the path.
  assert.match(runnerSrc, /spawnSync\('graphify',\s*\[\s*'update',\s*'\.'\s*\]/);
  // And must NOT contain the outdated invocation.
  assert.doesNotMatch(runnerSrc, /spawnSync\('graphify',\s*\[\s*'\.'\s*,/);
});

test('writeState stamps plugin version in .traffic-one.json version field', () => {
  const { writeState, getPluginVersion } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs'));
  withTempDir((cwd) => {
    writeState(cwd, { stack: 'react-realtime-monorepo', mode: 'new-project' });
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));
    const pluginVersion = getPluginVersion();
    // The plugin version helper reads from the plugin manifest.
    assert.match(pluginVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(state.version, pluginVersion);
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'pluginVersion'), false);
    assert.equal(state.stack, 'default');
    assert.ok(state.toolchain.gitnexus);
  });
});

test('post-build-graphify fires for monorepo build flag forms (pnpm --filter, turbo run)', () => {
  const cases = [
    'pnpm build',
    'pnpm run build',
    'pnpm -w build',
    'pnpm -F web build',
    'pnpm --filter web build',
    'pnpm --filter=web build',
    'pnpm --filter web build --mode production',
    'turbo build',
    'turbo run build',
    'turbo run build --filter web',
    'npm run build',
    'yarn build',
    'bun run build',
    'vite build --mode production',
  ];
  for (const command of cases) {
    withTempDir((cwd) => {
      writeJson(path.join(cwd, '.traffic-one.json'), {
        stack: 'react-realtime-monorepo',
        mode: 'new-project',
        onboardingComplete: true,
        codeGraphProvider: 'graphify',
      });
      const result = runHook(cwd, 'post-build-graphify', {
        tool_input: { command },
      });
      assert.notEqual(result.stdout, '', `expected build regex to match: ${command}`);
    });
  }
});

test('post-build-graphify does not fire on install / typecheck / non-build commands', () => {
  const cases = [
    'pnpm install',
    'pnpm install build-tools',          // `build-tools` is an arg, not the script
    'pnpm run typecheck',
    'pnpm run dev',
    'turbo run typecheck',
    'echo build && pnpm install',         // `&&` breaks the run
    'git status',
  ];
  for (const command of cases) {
    withTempDir((cwd) => {
      writeJson(path.join(cwd, '.traffic-one.json'), {
        stack: 'react-realtime-monorepo',
        mode: 'new-project',
        onboardingComplete: true,
      });
      const result = runHook(cwd, 'post-build-graphify', {
        tool_input: { command },
      });
      assert.equal(result.stdout, '', `expected build regex NOT to match: ${command}`);
    });
  }
});

// ── Digest-size warning on .traffic-one/digests/<run>/<role>.md writes ──────

test('post-stack-setup warns on bloated digest write (> 3 KB)', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), { stack: 'react-realtime-monorepo' });
    const runDir = path.join(cwd, '.traffic-one', 'digests', '2026-05-07T14-23-05Z');
    fs.mkdirSync(runDir, { recursive: true });
    const digestPath = path.join(runDir, 'frontend.md');
    fs.writeFileSync(digestPath, '# frontend digest\n' + 'x'.repeat(4 * 1024), 'utf8');

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: { file_path: digestPath },
    });

    assert.match(result.stdout, /\[digest-size\]/);
    assert.match(result.stdout, /frontend\.md/);
    assert.match(result.stdout, /trim to/);
    assert.match(result.stdout, /Repo-relative paths|repo-relative paths/i);
  });
});

test('post-stack-setup silent on small digest write (< 3 KB)', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), { stack: 'react-realtime-monorepo' });
    const runDir = path.join(cwd, '.traffic-one', 'digests', '2026-05-07T14-23-05Z');
    fs.mkdirSync(runDir, { recursive: true });
    const digestPath = path.join(runDir, 'architect.md');
    fs.writeFileSync(digestPath, '# architect digest\n\nverdict: PLAN_READY\n', 'utf8');

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: { file_path: digestPath },
    });

    assert.equal(result.stdout, '');
  });
});

// ── Phase 5 sanity check is documented in the orchestrator ─────────────────

test('orchestrator Phase 5 documents the missing-digest sanity check', () => {
  const orchestrator = fs.readFileSync(path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'SKILL.md'), 'utf8');
  assert.match(orchestrator, /Phase 5 — Cleanup \+ sanity check/);
  assert.match(orchestrator, /Digest sanity:/);
});

test('orchestrator verifies materialization after PLAN_READY before Phase 2', () => {
  const orchestrator = fs.readFileSync(path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'SKILL.md'), 'utf8');
  const templates = fs.readFileSync(path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'), 'utf8');

  assert.match(orchestrator, /After `PLAN_READY`, before Phase 2/);
  assert.match(orchestrator, /materialize-project/);
  assert.match(orchestrator, /Do not spawn frontend\/backend/);
  assert.match(orchestrator, /without hand-writing `materializedStack`/);
  assert.match(templates, /Before emitting PLAN_READY, verify project-local context is materialized/);
  assert.match(templates, /\.traffic-one\/manifest\.json/);
  assert.match(templates, /materialize-project/);
  assert.match(templates, /Do not write `materializedStack`/);
});

// ── codeGraphProvider onboarding question + state-shape enforcement ────────

test('onboarding directive contains the codeGraphProvider question with gitnexus listed first', () => {
  const { onboardingDirectiveNewProject } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'));
  const directive = onboardingDirectiveNewProject();
  // The question must exist as a required onboarding field.
  assert.match(directive, /codeGraphProvider/);
  assert.match(directive, /REQUIRED/i);
  assert.match(directive, /request_user_input/);
  assert.match(directive, /Code Graph/);
  assert.match(directive, /Which provider should we use for the codebase graph\?/);
  assert.match(directive, /Do NOT print "Options:"/);
  assert.match(directive, /ask in chat with numbered options and stop/);
  // gitnexus listed first (per user instruction; no "Recommended" tag).
  const gIdx = directive.indexOf('gitnexus');
  const fIdx = directive.indexOf('graphify');
  assert.ok(gIdx >= 0 && fIdx >= 0, 'both providers must appear in directive');
  assert.ok(gIdx < fIdx, 'gitnexus must be listed before graphify');
  // Explicit no-default + no-skip framing.
  assert.match(directive.replace(/\s+/g, ' '), /no skip|do not (?:default|skip|silently)/i);
});

test('onboarding directive surfaces the PolyForm Noncommercial license for gitnexus', () => {
  const { onboardingDirectiveNewProject } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'));
  const directive = onboardingDirectiveNewProject();
  assert.match(directive, /PolyForm Noncommercial/);
  // graphify license also mentioned so the user can compare.
  assert.match(directive, /MIT/);
});

test('runPostStackSetup warns when codeGraphProvider is missing', () => {
  withTempDir((cwd) => {
    const filePath = path.join(cwd, '.traffic-one.json');
    writeJson(filePath, {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      // codeGraphProvider intentionally omitted
      confirmed: true,
      onboardingComplete: true,
    });

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: { file_path: filePath },
    });
    const parsed = parseStdoutJson(result);
    assert.match(parsed.systemMessage, /codeGraphProvider/);
    assert.match(parsed.systemMessage, /gitnexus|graphify/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /codeGraphProvider/);
  });
});

test('runPostStackSetup warns when codeGraphProvider is set to an unknown value', () => {
  withTempDir((cwd) => {
    const filePath = path.join(cwd, '.traffic-one.json');
    writeJson(filePath, {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      codeGraphProvider: 'bogus-provider',
      confirmed: true,
      onboardingComplete: true,
    });

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: { file_path: filePath },
    });
    const parsed = parseStdoutJson(result);
    assert.match(parsed.systemMessage, /unknown codeGraphProvider/);
    assert.match(parsed.systemMessage, /bogus-provider/);
    assert.match(parsed.systemMessage, /gitnexus, graphify/);
  });
});

test('post-build-graphify dispatches to the gitnexus runner when codeGraphProvider is "gitnexus"', () => {
  // We can't easily run the real gitnexus runner from the test (it would
  // probe `which gitnexus` and try to install). Instead, assert the dispatch
  // surface: with `codeGraphProvider: "gitnexus"` and no fresh `.gitnexus/`,
  // the hook must produce a gitnexus-flavoured banner (license reminder /
  // npm install hint), not the graphify one.
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      mode: 'new-project',
      onboardingComplete: true,
      codeGraphProvider: 'gitnexus',
    });
    // Force the runner's install probe to miss so it returns install-skipped
    // without trying to install npm packages in CI.
    const prevPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-that-does-not-exist';
    try {
      const result = runHook(cwd, 'post-build-graphify', {
        tool_input: { command: 'pnpm build' },
      });
      // Banner must be gitnexus-flavoured. Two valid outcomes depending on
      // the host Node version: Node >=22 hits the npm-install path (license
      // reminder + install command); Node <22 hits the version-mismatch
      // pre-flight (upgrade command). Both are gitnexus-specific.
      assert.notEqual(result.stdout, '', 'expected post-build hint with gitnexus provider');
      assert.match(result.stdout, /gitnexus/i);
      assert.match(
        result.stdout,
        /PolyForm Noncommercial|npm install -g gitnexus|npx gitnexus|Node >=22|nvm install 22/i,
      );
      // Must NOT mention the graphify pipx install hint.
      assert.doesNotMatch(result.stdout, /pipx install graphifyy/);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

test('gitnexus-runner short-circuits when .gitnexus/ is fresh', () => {
  const { bootstrap } = require(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'));
  withTempDir((cwd) => {
    fs.mkdirSync(path.join(cwd, '.gitnexus'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.gitnexus', 'index.json'), '{}\n', 'utf8');
    // Force every which() probe to miss so the runner would otherwise fail.
    const prevPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-that-does-not-exist';
    try {
      const result = bootstrap(cwd);
      assert.equal(result.ok, true);
      assert.equal(result.action, 'fresh');
      assert.match(result.report || '', /\.gitnexus$/);
      // License notice surfaced even on the fresh-cache path.
      assert.equal(result.license, 'PolyForm Noncommercial');
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

test('gitnexus-runner reports install-skipped when both gitnexus and npm are off PATH', () => {
  // Reload the runner module with a stubbed HOME so its `findNvmNode22()`
  // returns null (no nvm-v22 fallback path). This test pins the
  // npm-not-on-PATH branch.
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
  withTempDir((cwd) => {
    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    process.env.PATH = '/nonexistent-path-that-does-not-exist';
    process.env.HOME = cwd;  // no `.nvm/` in here
    try {
      const { bootstrap } = require(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'));
      // Inject `nodeMajor: 22` so this test focuses on the
      // npm-not-on-PATH branch regardless of the test runner's host Node
      // version (the Node-version-mismatch branch has its own dedicated
      // test below).
      const result = bootstrap(cwd, { nodeMajor: 22 });
      assert.equal(result.ok, false);
      assert.equal(result.action, 'install-skipped');
      assert.match(result.error || '', /npm.*not on PATH|graphify/i);
    } finally {
      process.env.PATH = prevPath;
      process.env.HOME = prevHome;
      delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
    }
  });
});

test('findNvmNode22 returns absolute paths for an nvm v22.x.y install when present', () => {
  // This test does NOT mock HOME — it just verifies the helper returns a
  // sensible shape on the current machine. If the test machine has no
  // `~/.nvm/versions/node/v22.*`, the helper returns null, which is also
  // a valid result we assert.
  const { findNvmNode22 } = require(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'));
  const result = findNvmNode22();
  if (result === null) {
    // CI/sandbox without nvm — nothing more to assert.
    return;
  }
  // Shape check + absolute paths.
  assert.match(result.version, /^v22\.\d+\.\d+$/);
  assert.ok(path.isAbsolute(result.root));
  for (const key of ['node', 'npm', 'gitnexus']) {
    if (result[key] !== null) {
      assert.ok(path.isAbsolute(result[key]), `${key} should be absolute`);
    }
  }
});

test('gitnexus-runner uses absolute nvm-v22 gitnexus binary even when injected nodeMajor is <22', () => {
  // Seamless behaviour: if the host machine has `~/.nvm/versions/node/v22.*/
  // bin/gitnexus`, the runner must NOT refuse with node-version-mismatch
  // even when the current process is on an older Node. It should resolve
  // the absolute v22 binary path and try to run it. This is the change
  // that lets the v2.8.1 runner work without a Claude Code relaunch.
  const runner = require(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'));
  const { bootstrap, findNvmNode22 } = runner;
  const nvm22 = findNvmNode22();
  if (!nvm22 || !nvm22.gitnexus) {
    // No usable v22 install on the test machine — skip; the dedicated
    // node-version-mismatch test still pins refusal in that scenario.
    return;
  }
  withTempDir((cwd) => {
    // Make `which gitnexus` miss so the only resolvable path is the
    // absolute nvm-v22 one. We can't easily run gitnexus here without git
    // (the runner adds --skip-git when no .git/) — accept either ok:true
    // or ok:false with a non-version-mismatch action.
    const prevPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-that-does-not-exist';
    try {
      const result = bootstrap(cwd, { nodeMajor: 20 });
      assert.notEqual(
        result.action,
        'node-version-mismatch',
        'runner must NOT refuse when nvm v22 is present, even on Node 20',
      );
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

test('runPostStackSetup auto-writes .nvmrc with `22` when codeGraphProvider is gitnexus on new-project', () => {
  withTempDir((cwd) => {
    const filePath = path.join(cwd, '.traffic-one.json');
    writeJson(filePath, completeDefaultState({
      stack: 'react-realtime-monorepo',
      codeGraphProvider: 'gitnexus',
      confirmedAt: '2026-05-12T00:00:00Z',
    }));
    // Sanity: .nvmrc does not exist yet.
    assert.equal(fs.existsSync(path.join(cwd, '.nvmrc')), false);

    runHook(cwd, 'post-stack-setup', { tool_input: { file_path: filePath } });

    // .nvmrc must now exist with content `22`.
    const nvmrcPath = path.join(cwd, '.nvmrc');
    assert.equal(fs.existsSync(nvmrcPath), true, '.nvmrc must be auto-written');
    assert.equal(fs.readFileSync(nvmrcPath, 'utf8').trim(), '22');
  });
});

test('runPostStackSetup does NOT clobber an existing .nvmrc on gitnexus setup', () => {
  withTempDir((cwd) => {
    const filePath = path.join(cwd, '.traffic-one.json');
    writeJson(filePath, completeDefaultState({
      stack: 'react-realtime-monorepo',
      codeGraphProvider: 'gitnexus',
      confirmedAt: '2026-05-12T00:00:00Z',
    }));
    // Pre-existing .nvmrc — must be preserved.
    const nvmrcPath = path.join(cwd, '.nvmrc');
    fs.writeFileSync(nvmrcPath, '20.11.0\n', 'utf8');

    runHook(cwd, 'post-stack-setup', { tool_input: { file_path: filePath } });

    assert.equal(fs.readFileSync(nvmrcPath, 'utf8').trim(), '20.11.0',
      'existing .nvmrc must not be overwritten');
  });
});

test('runPostStackSetup does NOT write .nvmrc when codeGraphProvider is graphify', () => {
  withTempDir((cwd) => {
    const filePath = path.join(cwd, '.traffic-one.json');
    writeJson(filePath, completeDefaultState({
      stack: 'react-realtime-monorepo',
      codeGraphProvider: 'graphify',
      confirmedAt: '2026-05-12T00:00:00Z',
    }));

    runHook(cwd, 'post-stack-setup', { tool_input: { file_path: filePath } });

    assert.equal(
      fs.existsSync(path.join(cwd, '.nvmrc')),
      false,
      '.nvmrc must only be written for gitnexus, not for graphify',
    );
  });
});

test('gitnexus-runner emits nvm-install-needed (not node-version-mismatch) when nvm is installed but has no v22', () => {
  // Stub HOME to a temp dir that contains `~/.nvm/nvm.sh` (= nvm installed)
  // but no `~/.nvm/versions/node/v22.*` (= no v22 yet). The runner should
  // emit the more specific `nvm-install-needed` action with a single-line
  // bash command the agent can hand to its Bash tool.
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
  withTempDir((cwd) => {
    // Make `~/.nvm/nvm.sh` exist (nvm is "installed") but no v22 folder.
    fs.mkdirSync(path.join(cwd, '.nvm', 'versions', 'node', 'v20.18.3'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.nvm', 'nvm.sh'), '# fake nvm script\n');

    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    process.env.PATH = '/nonexistent-path-that-does-not-exist';
    process.env.HOME = cwd;
    try {
      const { bootstrap } = require(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'));
      const result = bootstrap(cwd, { nodeMajor: 20 });
      assert.equal(result.ok, false);
      assert.equal(result.action, 'nvm-install-needed');
      assert.ok(result.recommendedCommand, 'must include a recommendedCommand for the agent to run');
      // Command must source nvm, install v22, set default, and (helpfully)
      // also install gitnexus so the user is done in one go.
      assert.match(result.recommendedCommand, /nvm install 22/);
      assert.match(result.recommendedCommand, /nvm alias default 22/);
      assert.match(result.recommendedCommand, /npm install -g gitnexus/);
      // The banner copy must direct the agent to use its Bash tool (the
      // permission prompt is the consent gate).
      assert.match(result.error, /Bash tool/);
    } finally {
      process.env.PATH = prevPath;
      process.env.HOME = prevHome;
      delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
    }
  });
});

test('post-build-graphify surfaces the nvm install command when bootstrap returns nvm-install-needed', () => {
  // The post-build hook must recognise the `nvm-install-needed` action and
  // emit a beginner-friendly banner that includes the single-line install
  // command + instructions for the agent to run it via Bash.
  withTempDir((cwd) => {
    // Fake nvm install: nvm.sh present, no v22 folder.
    fs.mkdirSync(path.join(cwd, '.nvm', 'versions', 'node', 'v20.18.3'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.nvm', 'nvm.sh'), '# fake nvm script\n');
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      mode: 'new-project',
      onboardingComplete: true,
      codeGraphProvider: 'gitnexus',
    });

    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    process.env.PATH = '/nonexistent-path-that-does-not-exist';
    process.env.HOME = cwd;
    try {
      const result = runHook(cwd, 'post-build-graphify', {
        tool_input: { command: 'pnpm build' },
      });
      assert.notEqual(result.stdout, '');
      assert.match(result.stdout, /nvm-install-needed|Node 22 not installed yet/);
      assert.match(result.stdout, /Bash tool/);
      assert.match(result.stdout, /nvm install 22/);
    } finally {
      process.env.PATH = prevPath;
      process.env.HOME = prevHome;
    }
  });
});

test('doctor.cjs reports HEALTHY when state has graphify provider and no issues', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { probeNode, probeProject, buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      codeGraphProvider: 'graphify',
    });
    const node = probeNode();
    const project = probeProject(cwd);
    // Force a clean nvm/gitnexus shape; we're testing the findings logic.
    const nvm = { installed: false };
    const gitnexus = { onPath: null, absoluteV22: null, crashRiskInOldNvm: false };
    const findings = buildFindings({ node, nvm, gitnexus, project });
    // graphify provider + no graph-related issues => no fix-needed findings.
    const fixNeeded = findings.filter((f) => f.severity === 'fix-needed');
    assert.equal(fixNeeded.length, 0, JSON.stringify(findings, null, 2));
  });
});

test('doctor.cjs flags GITNEXUS_IN_OLD_NVM_NODE when gitnexus on PATH lives in old nvm folder', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      codeGraphProvider: 'gitnexus',
    });
    const node = { runningMajor: 22, runningVersion: '22.0.0', onPath: '/x/v22.0.0/bin/node', requiredMajor: 22 };
    const nvm = { installed: true, hasV22: true, v22Paths: { version: 'v22.0.0' }, installCommand: null };
    const gitnexus = {
      onPath: '/Users/cosmin/.nvm/versions/node/v20.18.3/bin/gitnexus',
      absoluteV22: '/Users/cosmin/.nvm/versions/node/v22.0.0/bin/gitnexus',
      crashRiskInOldNvm: true,
    };
    const project = {
      cwd,
      hasState: true,
      state: { codeGraphProvider: 'gitnexus', mode: 'new-project' },
      nvmrc: null,
      hasGit: false,
      artefacts: { gitnexus: null, graphify: null },
    };
    const findings = buildFindings({ node, nvm, gitnexus, project });
    const crashFinding = findings.find((f) => f.code === 'GITNEXUS_IN_OLD_NVM_NODE');
    assert.ok(crashFinding, JSON.stringify(findings, null, 2));
    assert.equal(crashFinding.severity, 'fix-needed');
    assert.match(crashFinding.message, /npm install -g gitnexus/);
  });
});

test('doctor.cjs flags NVMRC_PINNED_TO_OLD_NODE when project .nvmrc < 22 + provider is gitnexus', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  const node = { runningMajor: 22, requiredMajor: 22 };
  const nvm = { installed: true, hasV22: true };
  const gitnexus = { crashRiskInOldNvm: false };
  const project = {
    cwd: '/tmp',
    hasState: true,
    state: { codeGraphProvider: 'gitnexus', mode: 'new-project' },
    nvmrc: '20.11.0',
    hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
  };
  const findings = buildFindings({ node, nvm, gitnexus, project });
  const f = findings.find((x) => x.code === 'NVMRC_PINNED_TO_OLD_NODE');
  assert.ok(f, JSON.stringify(findings, null, 2));
  assert.equal(f.severity, 'fix-needed');
  assert.match(f.message, /\.nvmrc/);
});

test('traffic-one-doctor skill exists with required trigger phrases', () => {
  const skillPath = path.join(ROOT, 'skills-templates', 'traffic-one-doctor', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'skill file must exist');
  const text = fs.readFileSync(skillPath, 'utf8');
  // Required trigger phrases so the model picks it up on common user wording.
  for (const phrase of ['traffic one doctor', 'graph isn\'t working', '/doctor', 'gitnexus isn\'t running']) {
    assert.match(text, new RegExp(phrase.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'i'), `missing trigger: ${phrase}`);
  }
  // Must reference the underlying script.
  assert.match(text, /scripts\/doctor\.cjs/);
  // Must be read-only — no install/modify language.
  assert.match(text, /read-only|never installs/i);
});

test('gitnexus-runner respects codeGraphAutoRun: false (provider-agnostic opt-out)', () => {
  const { bootstrap } = require(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'));
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      stack: 'react-realtime-monorepo',
      codeGraphProvider: 'gitnexus',
      codeGraphAutoRun: false,
    });
    const result = bootstrap(cwd);
    assert.equal(result.ok, false);
    assert.equal(result.action, 'install-skipped');
    assert.match(result.error || '', /codeGraphAutoRun is false/);
  });
});

test('gitnexus-runner auto-passes --skip-git when project has no .git directory + surfaces stdout in error', () => {
  // Regression for trading-game: fresh scaffolds typically have no `.git/`
  // yet. GitNexus refuses non-git folders by default and writes the tip
  //   "Tip: pass --skip-git to index any folder without a .git directory."
  // to STDOUT (not stderr). The runner used to only surface `run.stderr`,
  // so users saw an opaque "gitnexus exited non-zero" with no clue why.
  // Two fixes: auto-pass `--skip-git` when `.git/` is absent, AND fall back
  // to `run.stdout` in the error message when stderr is empty.
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'), 'utf8');

  // The runner must conditionally append `--skip-git` based on a `.git/`
  // existence check at the project root. Match flexibly to keep the assert
  // resilient to small refactors.
  assert.match(runnerSrc, /existsSync\([^)]*'\.git'[^)]*\)/);
  assert.match(runnerSrc, /['"]--skip-git['"]/);

  // The non-zero-exit branch must include `run.stdout` in the error fallback
  // chain so stdout-only tips (like the --skip-git hint) reach the user.
  assert.match(
    runnerSrc.replace(/\s+/g, ' '),
    /run\.stderr\s*\|\|\s*run\.stdout/,
  );

  // Sanity: the runGitnexus helper exposes a `skippedGit` flag downstream
  // diagnostics can use (kept stable so future hook banners can surface it).
  assert.match(runnerSrc, /skippedGit/);
});

test('gitnexus-runner does not refuse when gitnexus is on PATH (trust user PATH)', () => {
  // v2.8.1 behaviour: when an `gitnexus` binary already lives on PATH, the
  // runner trusts the user's setup and tries it — even when the active
  // process is on Node <22. If that binary turns out to crash, the
  // resulting stderr/stdout is surfaced in the error stamp so the user
  // gets a specific diagnosis. Refusal pre-flight only fires when there
  // is NO usable path forward (no absolute nvm-v22 binary, no PATH
  // binary, no v22 npm to install with).
  //
  // Regression motivation: when the user has gitnexus installed via a
  // non-nvm mechanism (Homebrew, custom prefix, fork) the runner should
  // not pre-emptively refuse based on `process.versions.node` alone.
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
  withTempDir((cwd) => {
    // Fake gitnexus binary that exits 0 (no `.gitnexus/` produced).
    const fakeBin = path.join(cwd, '.fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeGitnexus = path.join(fakeBin, 'gitnexus');
    fs.writeFileSync(fakeGitnexus, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(fakeGitnexus, 0o755);

    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    process.env.HOME = cwd;  // no `.nvm/` -> findNvmNode22 returns null
    try {
      const { bootstrap } = require(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'));
      const result = bootstrap(cwd, { nodeMajor: 20 });
      // Must NOT be a version-mismatch refusal. The runner uses the on-PATH
      // binary, then reports "gitnexus ran but `.gitnexus/` was not
      // produced" (because the fake binary doesn't actually generate it).
      assert.notEqual(result.action, 'node-version-mismatch');
      assert.equal(result.ok, false);
      assert.match(result.error || '', /\.gitnexus\/?.*not produced/);
    } finally {
      process.env.PATH = prevPath;
      process.env.HOME = prevHome;
      delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
    }
  });
});

test('gitnexus-runner refuses on Node <22 with the actionable upgrade command', () => {
  // Stub HOME so `findNvmNode22()` returns null and the refusal branch
  // fires deterministically regardless of what's installed on the host.
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
  withTempDir((cwd) => {
    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    process.env.PATH = '/nonexistent-path-that-does-not-exist';
    process.env.HOME = cwd;
    try {
      const { bootstrap, GITNEXUS_MIN_NODE_MAJOR, currentNodeMajor } =
        require(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'));
      // Sanity-check the helpers exist + behave as documented.
      assert.equal(GITNEXUS_MIN_NODE_MAJOR, 22);
      assert.ok(typeof currentNodeMajor() === 'number' || currentNodeMajor() === null);

      const result = bootstrap(cwd, { nodeMajor: 20 });
      assert.equal(result.ok, false);
      assert.equal(result.action, 'node-version-mismatch');
      assert.equal(result.nodeMajor, 20);
      assert.equal(result.requiredNodeMajor, 22);
      // Banner must contain the exact upgrade sequence so the agent can
      // relay it verbatim to beginner users.
      assert.match(result.error, /Node >=22/);
      assert.match(result.error, /nvm install 22/);
      assert.match(result.error, /nvm alias default 22/);
      // Must offer the graphify fallback so users on locked Node can switch.
      assert.match(result.error, /graphify/);

      // The runner must stamp `.traffic-one.json` so subsequent runs
      // surface the error in the orchestrator summary.
      const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));
      assert.match(state.gitnexusLastError, /Node >=22/);
      assert.match(state.gitnexusLastErrorAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      process.env.PATH = prevPath;
      process.env.HOME = prevHome;
      delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
    }
  });
});

// ── Toolchain version tracking (2.9.31) ────────────────────────────────────

test('toolchain spec lists gitnexus + graphify + security scanners with valid semver', () => {
  const tch = require(path.join(ROOT, 'scripts', 'toolchain.cjs'));
  const spec = tch.loadSpec();
  for (const name of ['gitnexus', 'graphify', 'gitleaks', 'trufflehog']) {
    const entry = spec[name];
    assert.ok(entry, `spec must include ${name}`);
    assert.match(entry.recommended, /^\d+\.\d+\.\d+$/, `${name}.recommended must be a semver`);
    assert.match(entry.minimum, /^\d+\.\d+\.\d+$/, `${name}.minimum must be a semver`);
    // recommended must be >= minimum.
    assert.ok(tch.compareSemver(entry.recommended, entry.minimum) >= 0, `${name}.recommended must be >= minimum`);
    assert.ok(entry.versionCommand, `${name} must declare versionCommand`);
    assert.ok(entry.installCommand, `${name} must declare installCommand`);
  }
});

test('toolStatus classifies current / outdated / too-old / missing correctly', () => {
  const tch = require(path.join(ROOT, 'scripts', 'toolchain.cjs'));
  // gitnexus spec: minimum 1.0.0, recommended 1.6.4.
  assert.equal(tch.toolStatus('gitnexus', '1.6.4').status, 'current');
  assert.equal(tch.toolStatus('gitnexus', '2.0.0').status, 'current');
  assert.equal(tch.toolStatus('gitnexus', '1.5.0').status, 'outdated');
  assert.equal(tch.toolStatus('gitnexus', '0.9.0').status, 'too-old');
  assert.equal(tch.toolStatus('gitnexus', null).status, 'missing');
  assert.equal(tch.toolStatus('unknown-tool', '1.0.0').status, 'unknown');
});

test('compareSemver handles equal, less, greater, malformed', () => {
  const { compareSemver } = require(path.join(ROOT, 'scripts', 'toolchain.cjs'));
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.2.3', '1.2.4'), -1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0); // tolerant `v` prefix
  assert.equal(compareSemver('1.2', '1.2.3'), null); // malformed → null
  assert.equal(compareSemver('abc', '1.2.3'), null);
});

test('mergeToolchainStamp writes installedVersion + installedAt under toolchain.<name>', () => {
  const tch = require(path.join(ROOT, 'scripts', 'toolchain.cjs'));
  const before = { stack: 'react-realtime-monorepo', otherField: 'preserved' };
  const after = tch.mergeToolchainStamp(before, 'gitnexus', {
    version: '1.6.4',
    binPath: '/usr/local/bin/gitnexus',
    at: '2026-05-13T00:00:00Z',
  });
  assert.equal(after.otherField, 'preserved', 'sibling state fields must survive');
  assert.equal(after.toolchain.gitnexus.installedVersion, '1.6.4');
  assert.equal(after.toolchain.gitnexus.installedAt, '2026-05-13T00:00:00Z');
  assert.equal(after.toolchain.gitnexus.binPath, '/usr/local/bin/gitnexus');
});

test('doctor.cjs flags TOOLCHAIN_OUTDATED (severity info) when installed < recommended but >= minimum', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  const node = { runningMajor: 22, requiredMajor: 22 };
  const nvm = { installed: true, hasV22: true };
  const gitnexus = { crashRiskInOldNvm: false };
  const project = {
    cwd: '/tmp',
    hasState: true,
    state: {
      codeGraphProvider: 'gitnexus',
      mode: 'new-project',
      toolchain: { gitnexus: { installedVersion: '1.5.0' } },  // < recommended 1.6.4 but > minimum 1.0.0
    },
    nvmrc: null,
    hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
  };
  const findings = buildFindings({ node, nvm, gitnexus, project });
  const drift = findings.find((f) => f.code === 'TOOLCHAIN_OUTDATED' && f.tool === 'gitnexus');
  assert.ok(drift, JSON.stringify(findings, null, 2));
  assert.equal(drift.severity, 'info');
  assert.match(drift.message, /1\.5\.0/);
  assert.match(drift.message, /1\.6\.4/);
  assert.ok(drift.recommendedCommand);
});

test('doctor.cjs flags TOOLCHAIN_OUTDATED (severity fix-needed) when installed < minimum', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  const project = {
    cwd: '/tmp',
    hasState: true,
    state: {
      codeGraphProvider: 'graphify',
      mode: 'new-project',
      toolchain: { graphify: { installedVersion: '0.3.0' } },  // below minimum 0.4.0
    },
    nvmrc: null,
    hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
  };
  const findings = buildFindings({
    node: { runningMajor: 22, requiredMajor: 22 },
    nvm: { installed: true, hasV22: true },
    gitnexus: { crashRiskInOldNvm: false },
    project,
  });
  const drift = findings.find((f) => f.code === 'TOOLCHAIN_OUTDATED' && f.tool === 'graphify');
  assert.ok(drift, JSON.stringify(findings, null, 2));
  assert.equal(drift.severity, 'fix-needed');
  assert.match(drift.message, /minimum supported is 0\.4\.0/);
});

test('SessionStart tokenEconomyBanner surfaces a one-line toolchain nudge per drifted tool', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 2,
      mode: 'existing-codebase',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      codeGraphProvider: 'gitnexus',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-13T00:00:00Z',
      toolchain: {
        gitnexus: { installedVersion: '1.5.0' },  // outdated, not too-old
        graphify: { installedVersion: '0.3.0' },  // too-old
      },
    });
    // Make it look like an existing project so detection accepts the state.
    makeExistingProject(cwd, { react: '^18.0.0' });

    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.match(context, /\[toolchain\] gitnexus 1\.5\.0 installed; recommended is 1\.6\.4/);
    assert.match(context, /\[toolchain\] graphify 0\.3\.0 is below the minimum supported \(0\.4\.0\)/);
  });
});

test('manifests bumped to 2.9.31', () => {
  for (const rel of [
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    '.codex-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
  ]) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(text, /"version":\s*"2\.9\.31"/, `${rel} must be bumped to 2.9.31`);
  }
});

// ── Per-subagent rule scoping (2.9.31) ──────────────────────────────────────

test('isSubagentSession returns true when currentRunId + fresh materialization match', () => {
  const { isSubagentSession } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs'));
  const fresh = new Date().toISOString();
  const state = {
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' },
    materializedStack: 'default|react-vite|supabase|none',
    materializedAt: fresh,
    currentRunId: '2026-05-17T08-00-00Z',
  };
  assert.equal(isSubagentSession(state), true);
});

test('isSubagentSession returns false when materialization is stale (>30 min)', () => {
  const { isSubagentSession } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs'));
  const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const state = {
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' },
    materializedStack: 'default|react-vite|supabase|none',
    materializedAt: stale,
    currentRunId: '2026-05-17T08-00-00Z',
  };
  assert.equal(isSubagentSession(state), false);
});

test('isSubagentSession returns false when currentRunId is missing', () => {
  const { isSubagentSession } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs'));
  const state = {
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' },
    materializedStack: 'default|react-vite|supabase|none',
    materializedAt: new Date().toISOString(),
  };
  assert.equal(isSubagentSession(state), false);
});

test('AGENT_ROLE_BASE_RULES covers all 6 senior roles with curated sets', () => {
  const { AGENT_ROLE_BASE_RULES } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks.cjs'));
  const roles = ['senior-architect', 'senior-frontend', 'senior-backend',
                 'senior-reviewer', 'senior-tester', 'senior-shipper'];
  for (const role of roles) {
    assert.ok(Array.isArray(AGENT_ROLE_BASE_RULES[role]), `${role} missing`);
    assert.ok(AGENT_ROLE_BASE_RULES[role].length >= 3, `${role} has too few rules`);
  }
});

test('roleScopedRules excludes non-relevant rules per role', () => {
  const { roleScopedRules } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks.cjs'));
  const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' } };
  const frontendRules = roleScopedRules('senior-frontend', state);
  const backendRules  = roleScopedRules('senior-backend', state);
  const reviewerRules = roleScopedRules('senior-reviewer', state);
  // Frontend gets frontend rules, no backend rules
  assert.ok(frontendRules.some((r) => r.startsWith('rules/frontend/')), 'frontend missing frontend rules');
  assert.ok(!frontendRules.some((r) => r.startsWith('rules/backend/')), 'frontend should not have backend rules');
  // Backend gets backend rules, no frontend rules
  assert.ok(backendRules.some((r) => r.startsWith('rules/backend/')), 'backend missing backend rules');
  assert.ok(!backendRules.some((r) => r.startsWith('rules/frontend/')), 'backend should not have frontend rules');
  // Reviewer sees both for cross-cutting review
  assert.ok(reviewerRules.some((r) => r.startsWith('rules/common/security.md')), 'reviewer missing security');
});

test('packRuleIndex emits bullet list of paths, no rule content', () => {
  const { packRuleIndex } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'packing.cjs'));
  const rules = ['rules/common/security.md', 'rules/common/clean-code.md', 'rules/core.md'];
  const { body } = packRuleIndex(ROOT, rules);
  assert.match(body, /## Active rule index/);
  assert.match(body, /- \.traffic-one\/rules\/common\/security\.md/);
  assert.doesNotMatch(body, /\.traffic-one\/rules\/active/);
  assert.ok(body.length < 5000, `index too large: ${body.length} bytes`);
  // Should NOT contain actual rule content (no '# Security Baseline' from security.md)
  assert.ok(!body.includes('# Security Baseline'), 'index leaked rule content');
});

test('runSessionStart emits slim bundle when state.currentRunId is set', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: '2.9.31',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-17T10:00:00Z',
      codeGraphProvider: 'graphify',
      toolchain: { gitnexus: { installedVersion: null, installedAt: null },
                   graphify: { installedVersion: null, installedAt: null },
                   gitleaks: { installedVersion: null, installedAt: null },
                   trufflehog: { installedVersion: null, installedAt: null } },
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: new Date().toISOString(),
      materializedVersion: '2.9.31',
      currentRunId: '2026-05-17T11-00-00Z',
      activeAgentRole: 'senior-frontend',
    });
    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.ok(context.length < 8000, `subagent bundle too large: ${context.length} bytes`);
    assert.match(context, /subagent/i);
    assert.match(context, /senior-frontend/);
    // Should NOT include full rule content (no '# ── rules/' headers from packBundle)
    assert.ok(!context.includes('# ── rules/'), 'subagent bundle leaked rule content');
  });
});

test('sweepOldDigests keeps only the N most recent directories', () => {
  withTempDir((cwd) => {
    const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
    fs.mkdirSync(digestsRoot, { recursive: true });
    const stamps = [
      '2026-01-01T00-00-00Z', '2026-02-01T00-00-00Z', '2026-03-01T00-00-00Z',
      '2026-04-01T00-00-00Z', '2026-05-01T00-00-00Z', '2026-06-01T00-00-00Z',
      '2026-07-01T00-00-00Z',
    ];
    for (const s of stamps) {
      fs.mkdirSync(path.join(digestsRoot, s));
      fs.writeFileSync(path.join(digestsRoot, s, 'architect.md'), '# digest');
    }
    // Trigger SessionStart so sweep runs
    writeJson(path.join(cwd, '.traffic-one.json'), { stack: 'minimal' });
    runHook(cwd, 'session-start', '');
    const remaining = fs.readdirSync(digestsRoot).sort();
    assert.equal(remaining.length, 5, `expected 5 remaining, got ${remaining.length}`);
    // Should keep the 5 most recent (newest sorted alphabetically by ISO)
    assert.deepEqual(remaining, [
      '2026-03-01T00-00-00Z', '2026-04-01T00-00-00Z', '2026-05-01T00-00-00Z',
      '2026-06-01T00-00-00Z', '2026-07-01T00-00-00Z',
    ]);
  });
});

test('graph-preview is included in subagent SessionStart when present', () => {
  withTempDir((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', 'graph-preview.md'),
      '## Codebase graph preview\n\nProvider: test · 3 modules:\n- apps/web\n- packages/ui\n- packages/api\n',
    );
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: '2.9.31',
      stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
      confirmed: true, onboardingComplete: true,
      confirmedAt: '2026-05-17T10:00:00Z',
      codeGraphProvider: 'graphify',
      toolchain: { gitnexus: { installedVersion: null, installedAt: null },
                   graphify: { installedVersion: null, installedAt: null },
                   gitleaks: { installedVersion: null, installedAt: null },
                   trufflehog: { installedVersion: null, installedAt: null } },
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: new Date().toISOString(),
      materializedVersion: '2.9.31',
      currentRunId: '2026-05-17T11-00-00Z',
      activeAgentRole: 'senior-architect',
    });
    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.match(context, /Codebase graph preview/);
    assert.match(context, /apps\/web/);
  });
});

test('generateGraphPreview returns null when graph artefact is missing', () => {
  withTempDir((cwd) => {
    const { generateGraphPreview } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize.cjs'));
    assert.equal(generateGraphPreview(cwd, 'graphify'), null);
    assert.equal(generateGraphPreview(cwd, 'gitnexus'), null);
  });
});

// ── Token usage report (2.9.31) ──────────────────────────────────────────────

test('token-report parseJsonlFile extracts usage from assistant messages', () => {
  withTempDir((cwd) => {
    const tr = require(path.join(ROOT, 'scripts', 'token-report.cjs'));
    const jsonl = path.join(cwd, 'fixture.jsonl');
    const line1 = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-17T10:00:00Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', name: 'Bash' }],
        usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 50 },
      },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-17T10:01:00Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', name: 'Write' }, { type: 'tool_use', name: 'Read' }],
        usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 80 },
      },
    });
    fs.writeFileSync(jsonl, `${line1}\n${line2}\n`);
    const stats = tr.parseJsonlFile(jsonl);
    assert.equal(stats.messages, 2);
    assert.equal(stats.toolUses, 3);
    assert.equal(stats.inputTokens, 150);
    assert.equal(stats.cacheCreationInputTokens, 200);
    assert.equal(stats.cacheReadInputTokens, 3000);
    assert.equal(stats.outputTokens, 130);
    assert.equal(stats.byTool.Bash, 1);
    assert.equal(stats.byTool.Write, 1);
    assert.equal(stats.byTool.Read, 1);
    assert.equal(stats.byModel['claude-sonnet-4-6'].messages, 2);
  });
});

test('token-report discoverSubagents reads agentType from meta.json', () => {
  withTempDir((cwd) => {
    const tr = require(path.join(ROOT, 'scripts', 'token-report.cjs'));
    const subDir = path.join(cwd, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-abc.jsonl'), '');
    fs.writeFileSync(path.join(subDir, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'traffic-one:senior-frontend', description: 'Build UI' }));
    fs.writeFileSync(path.join(subDir, 'agent-def.jsonl'), '');
    // No meta for agent-def — should fall back to 'unknown'
    const subs = tr.discoverSubagents(cwd);
    assert.equal(subs.length, 2);
    const frontend = subs.find((s) => s.id === 'agent-abc');
    assert.equal(frontend.agentType, 'traffic-one:senior-frontend');
    assert.equal(frontend.description, 'Build UI');
    const unknown = subs.find((s) => s.id === 'agent-def');
    assert.equal(unknown.agentType, 'unknown');
  });
});

test('token-report estimateCost uses model-specific pricing', () => {
  const tr = require(path.join(ROOT, 'scripts', 'token-report.cjs'));
  const opusStats = { byModel: { 'claude-opus-4-7': {
    inputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0,
  } } };
  const sonnetStats = { byModel: { 'claude-sonnet-4-6': {
    inputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0,
  } } };
  // Opus input list price = $15/M, Sonnet input list price = $3/M
  assert.equal(tr.estimateCost(opusStats), 15);
  assert.equal(tr.estimateCost(sonnetStats), 3);
});

test('token-report parseCodexJsonlFile extracts Codex totals and Traffic One estimates', () => {
  withTempDir((cwd) => {
    const tr = require(path.join(ROOT, 'scripts', 'token-report.cjs'));
    const jsonl = path.join(cwd, 'rollout-2026-05-18T10-00-00-session.jsonl');
    const lines = [
      {
        timestamp: '2026-05-18T10:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'session',
          timestamp: '2026-05-18T10:00:00Z',
          cwd,
          originator: 'Codex Desktop',
          model: 'gpt-5.2',
          base_instructions: { text: 'Traffic One rules live in .traffic-one/rules.' },
        },
      },
      {
        timestamp: '2026-05-18T10:00:05Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'functions.exec_command' },
      },
      {
        timestamp: '2026-05-18T10:00:06Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: 'Original token count: 1,234\nOutput:\nTraffic One .traffic-one/rules materialized.',
        },
      },
      {
        timestamp: '2026-05-18T10:00:10Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 250,
              output_tokens: 60,
              reasoning_output_tokens: 9,
              total_tokens: 1060,
            },
            last_token_usage: {
              input_tokens: 400,
              cached_input_tokens: 100,
              output_tokens: 10,
              reasoning_output_tokens: 3,
              total_tokens: 410,
            },
            model_context_window: 258400,
          },
        },
      },
    ];
    fs.writeFileSync(jsonl, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

    const report = tr.parseCodexJsonlFile(jsonl);
    assert.equal(report.session.id, 'session');
    assert.equal(report.stats.messages, 1);
    assert.equal(report.stats.toolUses, 1);
    assert.equal(report.stats.inputTokens, 750);
    assert.equal(report.stats.cacheReadInputTokens, 250);
    assert.equal(report.stats.outputTokens, 60);
    assert.equal(report.stats.reasoningOutputTokens, 9);
    assert.equal(report.stats.modelContextWindow, 258400);
    assert.equal(tr.totalTokens(report.stats), 1060);
    assert.equal(report.stats.byModel['gpt-5.2'].messages, 1);
    assert.equal(report.trafficOne.directToolOutputTokens, 1234);
    assert.equal(report.trafficOne.directToolOutputs, 1);
    assert.ok(report.trafficOne.instructionApproxTokens > 0);
  });
});

test('token-logger isEnabled honors TRAFFIC_ONE_TOKEN_LOG env var', () => {
  const tl = require(path.join(ROOT, 'scripts', 'hook-runtime', 'token-logger.cjs'));
  const prev = process.env[tl.ENV_FLAG];
  delete process.env[tl.ENV_FLAG];
  assert.equal(tl.isEnabled(), false);
  process.env[tl.ENV_FLAG] = '1';
  assert.equal(tl.isEnabled(), true);
  process.env[tl.ENV_FLAG] = 'true';
  assert.equal(tl.isEnabled(), true);
  process.env[tl.ENV_FLAG] = '0';
  assert.equal(tl.isEnabled(), false);
  if (prev === undefined) delete process.env[tl.ENV_FLAG];
  else process.env[tl.ENV_FLAG] = prev;
});

test('token-logger writes one JSONL line per tool use when enabled', () => {
  withTempDir((cwd) => {
    const tl = require(path.join(ROOT, 'scripts', 'hook-runtime', 'token-logger.cjs'));
    const prev = process.env[tl.ENV_FLAG];
    process.env[tl.ENV_FLAG] = '1';
    try {
      tl.logToolUse(cwd, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/foo.ts', content: 'console.log(1);' },
        tool_response: 'ok',
      });
      tl.logToolUse(cwd, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: 'foo\nbar\n',
      });
    } finally {
      if (prev === undefined) delete process.env[tl.ENV_FLAG];
      else process.env[tl.ENV_FLAG] = prev;
    }
    const logPath = path.join(cwd, tl.LOG_REL_PATH);
    assert.ok(fs.existsSync(logPath));
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const entry1 = JSON.parse(lines[0]);
    assert.equal(entry1.toolName, 'Write');
    assert.equal(entry1.hookEvent, 'PostToolUse');
    assert.ok(entry1.inputBytes > 0);
    assert.ok(entry1.estTokens > 0);
  });
});

test('token-logger is a no-op when env var is unset', () => {
  withTempDir((cwd) => {
    const tl = require(path.join(ROOT, 'scripts', 'hook-runtime', 'token-logger.cjs'));
    const prev = process.env[tl.ENV_FLAG];
    delete process.env[tl.ENV_FLAG];
    try {
      tl.logToolUse(cwd, { tool_name: 'Bash', tool_input: { command: 'ls' } });
    } finally {
      if (prev !== undefined) process.env[tl.ENV_FLAG] = prev;
    }
    assert.equal(fs.existsSync(path.join(cwd, tl.LOG_REL_PATH)), false);
  });
});

test('token-usage-report skill exists with required trigger phrases', () => {
  const skillPath = path.join(ROOT, 'skills-templates', 'token-usage-report', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'token-usage-report SKILL.md missing');
  const text = fs.readFileSync(skillPath, 'utf8');
  assert.match(text, /name:\s*token-usage-report/);
  assert.match(text, /how many tokens/);
  assert.match(text, /TRAFFIC_ONE_TOKEN_LOG/);
  assert.match(text, /token-report\.cjs/);
});

test('token-usage-report is in SKILL_FILTERS._common', () => {
  const { SKILL_FILTERS } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'skill-filters.cjs'));
  assert.ok(SKILL_FILTERS._common.has('token-usage-report'), 'token-usage-report not in _common');
});

// ── Fix-cycle slim bundle (2.9.31) ───────────────────────────────────────────

test('getSpawnIndex returns 0 when spawnIndex missing or role not present', () => {
  const { getSpawnIndex } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs'));
  assert.equal(getSpawnIndex({}, 'senior-frontend'), 0);
  assert.equal(getSpawnIndex({ spawnIndex: {} }, 'senior-frontend'), 0);
  assert.equal(getSpawnIndex({ spawnIndex: { 'senior-frontend': 1 } }, 'senior-frontend'), 1);
  assert.equal(getSpawnIndex({ spawnIndex: { 'senior-frontend': 3 } }, 'senior-frontend'), 3);
});

test('isFixCycleSession requires subagent + spawnIndex > 1', () => {
  const { isFixCycleSession } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state.cjs'));
  const fresh = new Date().toISOString();
  const base = {
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' },
    materializedStack: 'default|react-vite|supabase|none',
    materializedAt: fresh,
    currentRunId: '2026-05-18T08-00-00Z',
    activeAgentRole: 'senior-frontend',
  };
  // spawnIndex=1 is the FIRST spawn (not a fix-cycle)
  assert.equal(isFixCycleSession({ ...base, spawnIndex: { 'senior-frontend': 1 } }), false);
  // spawnIndex=2 IS a fix-cycle
  assert.equal(isFixCycleSession({ ...base, spawnIndex: { 'senior-frontend': 2 } }), true);
  // Without currentRunId, never a subagent session
  assert.equal(isFixCycleSession({ ...base, currentRunId: null, spawnIndex: { 'senior-frontend': 2 } }), false);
});

test('packFixCycleHeader emits ultra-slim bundle with both pointers', () => {
  const { packFixCycleHeader } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'packing.cjs'));
  const { body } = packFixCycleHeader('/cwd', 'senior-frontend', '2026-05-18T08-00-00Z', 2);
  assert.ok(body.length < 1500, `fix-cycle header too large: ${body.length} bytes`);
  assert.match(body, /FIX-CYCLE #1/);
  assert.match(body, /\.traffic-one\/fix-cycles\/2026-05-18T08-00-00Z\/senior-frontend-fix-1\.md/);
  assert.match(body, /\.traffic-one\/digests\/2026-05-18T08-00-00Z\/frontend\.md/);
  assert.match(body, /do not re-explore/i);
});

test('roleDigestName maps senior-* to short digest filename', () => {
  const { roleDigestName } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'packing.cjs'));
  assert.equal(roleDigestName('senior-frontend'), 'frontend');
  assert.equal(roleDigestName('senior-backend'), 'backend');
  assert.equal(roleDigestName('senior-architect'), 'architect');
  assert.equal(roleDigestName('senior-reviewer'), 'reviewer');
  assert.equal(roleDigestName('senior-tester'), 'tester');
  assert.equal(roleDigestName('senior-shipper'), 'shipper');
});

test('runSessionStart emits ultra-slim bundle for fix-cycle re-spawn', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: '2.9.31',
      stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
      confirmed: true, onboardingComplete: true,
      confirmedAt: '2026-05-18T10:00:00Z',
      codeGraphProvider: 'graphify',
      toolchain: { gitnexus: { installedVersion: null, installedAt: null },
                   graphify: { installedVersion: null, installedAt: null },
                   gitleaks: { installedVersion: null, installedAt: null },
                   trufflehog: { installedVersion: null, installedAt: null } },
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: new Date().toISOString(),
      materializedVersion: '2.9.31',
      currentRunId: '2026-05-18T11-00-00Z',
      activeAgentRole: 'senior-frontend',
      spawnIndex: { 'senior-frontend': 2 },
    });
    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.ok(context.length < 1500, `fix-cycle bundle too large: ${context.length} bytes`);
    assert.match(context, /FIX-CYCLE #1/);
    assert.match(context, /fix-cycles/);
    assert.match(context, /do not re-explore/i);
    // Should NOT include the role-scoped rule index that the standard subagent branch emits
    assert.ok(!context.includes('## Active rule index'), 'fix-cycle leaked rule index');
  });
});

test('runSessionStart emits standard slim bundle when spawnIndex is 1', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: '2.9.31',
      stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
      confirmed: true, onboardingComplete: true,
      confirmedAt: '2026-05-18T10:00:00Z',
      codeGraphProvider: 'graphify',
      toolchain: { gitnexus: { installedVersion: null, installedAt: null },
                   graphify: { installedVersion: null, installedAt: null },
                   gitleaks: { installedVersion: null, installedAt: null },
                   trufflehog: { installedVersion: null, installedAt: null } },
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: new Date().toISOString(),
      materializedVersion: '2.9.31',
      currentRunId: '2026-05-18T11-00-00Z',
      activeAgentRole: 'senior-frontend',
      spawnIndex: { 'senior-frontend': 1 },
    });
    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    // First spawn should get the standard subagent slim bundle with rule index, NOT fix-cycle
    assert.match(context, /## Active rule index/);
    assert.ok(!context.includes('FIX-CYCLE'), 'first spawn should not be fix-cycle');
  });
});

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
