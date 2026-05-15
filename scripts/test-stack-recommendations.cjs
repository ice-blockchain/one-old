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
const { STACKS, stackSpecForState } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks.cjs'));
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
    const context = payload.hookSpecificOutput.additionalContext;

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
    const context = payload.hookSpecificOutput.additionalContext;
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
  const detectProject = fs.readFileSync(path.join(ROOT, 'skills', 'detect-project', 'SKILL.md'), 'utf8');
  const directives = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8');
  const orchestrator = fs.readFileSync(path.join(ROOT, 'skills', 'senior-eng-orchestrator', 'SKILL.md'), 'utf8');
  const stackSetup = fs.readFileSync(path.join(ROOT, 'skills', 'stack-setup', 'SKILL.md'), 'utf8');
  const agentsMirror = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');

  assert.match(detectProject, /Codex subagent preflight for new projects/);
  assert.match(detectProject, /switch Codex and Claude Code to Plan mode/);
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
  assert.match(directives, /CODEX CODEBASE GRAPH PROVIDER PREFLIGHT/);
  assert.match(directives, /request_user_input/);
  assert.match(directives, /Do NOT print "Options:" or a\s+numbered list in chat/);
  assert.match(directives, /reply with the option number or\s+label/);
  assert.match(directives, /Never choose a default/);
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
  assert.match(agentsMirror, /mode === "new-project"/);
  assert.match(agentsMirror, /Codex and Claude Code must switch to Plan mode/);
  assert.match(agentsMirror, /Codex default-mode fallback is a visible first-response requirement/);
  assert.match(agentsMirror, /Before onboarding is resolved, mention only the project-detection\/onboarding flow/);
  assert.match(claude, /mode === "new-project"/);
  assert.match(claude, /Claude Code and Codex must switch to Plan\s+mode/);
  assert.match(claude, /In Codex Default mode, the fallback must be the next visible assistant response/);
  assert.match(claude, /Before onboarding is resolved, mention only project-detection\/onboarding/);

  withTempDir((cwd) => {
    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;

    assert.match(context, /NEW-PROJECT PLAN MODE GATE \(Codex \+ Claude Code\)/);
    assert.match(context, /mode === "new-project"/);
    assert.match(context, /Plan mode/);
    assert.match(context, /CODEX ONBOARDING POPUP RULE/);
    assert.match(context, /CODEX DEFAULT-MODE FALLBACK \(visible response, blocking\)/);
    assert.match(context, /Plan mode is required for Traffic One new-project onboarding, but Plan mode is not active here and the popup prompt is unavailable/);
    assert.match(context, /Do not say you are using create-feature, create-page, frontend-design, tdd-workflow/);
    assert.match(context, /CODEX MOBILE DECISION PREFLIGHT/);
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
    const context = payload.hookSpecificOutput.additionalContext;

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
  });
});

test('implementation skills defer until new-project onboarding is resolved', () => {
  const implementationSkills = [
    'skills/create-feature/SKILL.md',
    'skills/create-page/SKILL.md',
    'skills/create-component/SKILL.md',
    'skills/create-service/SKILL.md',
    'skills/create-native-feature/SKILL.md',
    'skills/create-native-screen/SKILL.md',
    'skills/create-native-component/SKILL.md',
    'skills/create-native-service/SKILL.md',
    'skills/frontend-design/SKILL.md',
    'skills/tdd-workflow/SKILL.md',
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
  assert.ok(
    preToolUse.findIndex((entry) => /check-onboarding-gate/.test(entry.hooks[0].command))
      < preToolUse.findIndex((entry) => /check-library-allowlist/.test(entry.hooks[0].command)),
    'onboarding gate must run before Bash library/version checks',
  );
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

test('onboarding gate treats missing toolchain as incomplete onboarding', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      version: 3,
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
      codeGraphProvider: 'gitnexus',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-13T10:00:00Z',
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });
    const parsed = parseStdoutJson(result);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /toolchain/);
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
      codeGraphProvider: 'graphify',
      toolchain: initializeToolchainState({}),
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-13T10:00:00Z',
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'npm view react version' },
    });

    assert.equal(result.stdout, '');
  });
});

test('Supabase missing-config setup CTAs must route through Traffic', () => {
  const sources = {
    supabaseRule: fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'react', 'supabase-client.md'), 'utf8'),
    newProjectRule: fs.readFileSync(path.join(ROOT, 'rules', 'modes', 'new-project.md'), 'utf8'),
    stacks: fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks.cjs'), 'utf8'),
    directives: fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8'),
    createFeature: fs.readFileSync(path.join(ROOT, 'skills', 'create-feature', 'SKILL.md'), 'utf8'),
    createPage: fs.readFileSync(path.join(ROOT, 'skills', 'create-page', 'SKILL.md'), 'utf8'),
    createService: fs.readFileSync(path.join(ROOT, 'skills', 'create-service', 'SKILL.md'), 'utf8'),
    promptTemplates: fs.readFileSync(
      path.join(ROOT, 'skills', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
      'utf8',
    ),
    frontendAgent: fs.readFileSync(path.join(ROOT, 'agents', 'senior-frontend.md'), 'utf8'),
    reviewerAgent: fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8'),
    agentsMirror: fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'),
    claudeManifest: fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8'),
    cursorSupabaseRule: fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'react-supabase-client.mdc'), 'utf8'),
    cursorNewProjectRule: fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'mode-new-project.mdc'), 'utf8'),
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
  assert.match(sources.agentsMirror, /SupabaseConfigAlert/);
  assert.match(sources.claudeManifest, /supabase-client\.md/);
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
    const context = payload.hookSpecificOutput.additionalContext;

    assert.match(context, /rules\/frontend\/react\/supabase-client\.md/);
    assert.match(context, /https:\/\/traffic\.io\//);
    assert.match(context, /Add a regression test for the Traffic CTA/);
  });
});

test('new projects must include the auto-documentation baseline', () => {
  const documentationRules = fs.readFileSync(path.join(ROOT, 'rules', 'common', 'documentation.md'), 'utf8');
  const newProjectRule = fs.readFileSync(path.join(ROOT, 'rules', 'modes', 'new-project.md'), 'utf8');
  const directives = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8');
  const stacks = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks.cjs'), 'utf8');
  const architect = fs.readFileSync(path.join(ROOT, 'agents', 'senior-architect.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const promptTemplates = fs.readFileSync(
    path.join(ROOT, 'skills', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  const agentsMirror = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const cursorDocumentation = fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'common-documentation.mdc'), 'utf8');
  const cursorNewProject = fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'mode-new-project.mdc'), 'utf8');

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
  assert.match(agentsMirror, /auto-documentation is mandatory/);
  assert.match(claude, /@rules\/common\/documentation\.md/);
  assert.match(cursorDocumentation, /For `mode: new-project`, this is mandatory/);
  assert.match(cursorNewProject, /Mandatory auto-documentation baseline/);
});

test('project memory baseline is integrated across runtimes', () => {
  const memoryRules = fs.readFileSync(path.join(ROOT, 'rules', 'common', 'project-memory.md'), 'utf8');
  const memorySkill = fs.readFileSync(path.join(ROOT, 'skills', 'project-memory', 'SKILL.md'), 'utf8');
  const newProjectRule = fs.readFileSync(path.join(ROOT, 'rules', 'modes', 'new-project.md'), 'utf8');
  const existingRule = fs.readFileSync(path.join(ROOT, 'rules', 'modes', 'existing-codebase.md'), 'utf8');
  const directives = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8');
  const stacks = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks.cjs'), 'utf8');
  const skillFilters = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'skill-filters.cjs'), 'utf8');
  const architect = fs.readFileSync(path.join(ROOT, 'agents', 'senior-architect.md'), 'utf8');
  const backend = fs.readFileSync(path.join(ROOT, 'agents', 'senior-backend.md'), 'utf8');
  const shipper = fs.readFileSync(path.join(ROOT, 'agents', 'senior-shipper.md'), 'utf8');
  const promptTemplates = fs.readFileSync(
    path.join(ROOT, 'skills', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  const agentsMirror = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const cursorMemory = fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'common-project-memory.mdc'), 'utf8');
  const cursorNewProject = fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'mode-new-project.mdc'), 'utf8');

  assert.match(memoryRules, /\.traffic-one\/product\.md/);
  assert.match(memoryRules, /Root `\.traffic-one\.json`/);
  assert.match(memoryRules, /\.traffic-one\/decisions\//);
  assert.match(memoryRules, /\.traffic-one\/rules\/coding\.md/);
  assert.match(memoryRules, /\.traffic-one\/deployments\.jsonl/);
  assert.match(memoryRules, /\.traffic-one\/mcp\.json/);
  assert.match(memoryRules, /Root `AGENTS\.md` should symlink/);
  assert.match(memorySkill, /Create, refresh, or audit the Traffic One `.traffic-one\/` project memory/);
  assert.match(memorySkill, /root `\.traffic-one\.json`/);
  assert.match(newProjectRule, /Project memory baseline/);
  assert.match(newProjectRule, /root `\.traffic-one\.json` exists/);
  assert.match(existingRule, /run the `project-memory` baseline reconciliation/);
  assert.match(existingRule, /root `\.traffic-one\.json` exists/);
  assert.match(directives, /Project memory baseline: create/);
  assert.match(directives, /Verify the root companion state file/);
  assert.match(directives, /project-memory/);
  assert.match(stacks, /rules\/common\/project-memory\.md/);
  assert.match(skillFilters, /'project-memory'/);
  assert.match(architect, /project-memory/);
  assert.match(backend, /refresh `.traffic-one\/schema\.sql`/);
  assert.match(shipper, /Append one JSON line to `.traffic-one\/deployments\.jsonl`/);
  assert.match(promptTemplates, /Read .traffic-one.json plus existing project memory/);
  assert.match(agentsMirror, /Project memory — `.traffic-one\/`/);
  assert.match(claude, /@rules\/common\/project-memory\.md/);
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
    const context = payload.hookSpecificOutput.additionalContext;

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
    const context = payload.hookSpecificOutput.additionalContext;

    assert.match(context, /rules\/common\/documentation\.md/);
    assert.match(context, /For `mode: new-project`, this is mandatory across every stack/);
    assert.match(context, /new project complete with only a lightweight README/);
  });
});

test('existing projects must reconcile the auto-documentation baseline', () => {
  const documentationRules = fs.readFileSync(path.join(ROOT, 'rules', 'common', 'documentation.md'), 'utf8');
  const existingRule = fs.readFileSync(path.join(ROOT, 'rules', 'modes', 'existing-codebase.md'), 'utf8');
  const directives = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8');
  const architect = fs.readFileSync(path.join(ROOT, 'agents', 'senior-architect.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const autoDocs = fs.readFileSync(path.join(ROOT, 'skills', 'auto-documentation-generator', 'SKILL.md'), 'utf8');
  const promptTemplates = fs.readFileSync(
    path.join(ROOT, 'skills', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  const agentsMirror = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const cursorDocumentation = fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'common-documentation.mdc'), 'utf8');
  const cursorExisting = fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'mode-existing-codebase.mdc'), 'utf8');

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
  assert.match(agentsMirror, /if a canonical doc does not exist, create it from verified repo facts at the repo root/);
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
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one.json'), 'utf8'));

    assert.equal(state.mode, 'existing-codebase');
    assert.match(context, /rules\/modes\/existing-codebase\.md/);
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
  const seoRule = fs.readFileSync(path.join(ROOT, 'rules', 'common', 'seo.md'), 'utf8');
  const seoSkill = fs.readFileSync(path.join(ROOT, 'skills', 'seo', 'SKILL.md'), 'utf8');
  const newProjectRule = fs.readFileSync(path.join(ROOT, 'rules', 'modes', 'new-project.md'), 'utf8');
  const existingRule = fs.readFileSync(path.join(ROOT, 'rules', 'modes', 'existing-codebase.md'), 'utf8');
  const directives = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8');
  const architect = fs.readFileSync(path.join(ROOT, 'agents', 'senior-architect.md'), 'utf8');
  const frontend = fs.readFileSync(path.join(ROOT, 'agents', 'senior-frontend.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const tester = fs.readFileSync(path.join(ROOT, 'agents', 'senior-tester.md'), 'utf8');
  const createPage = fs.readFileSync(path.join(ROOT, 'skills', 'create-page', 'SKILL.md'), 'utf8');
  const createFeature = fs.readFileSync(path.join(ROOT, 'skills', 'create-feature', 'SKILL.md'), 'utf8');
  const promptTemplates = fs.readFileSync(
    path.join(ROOT, 'skills', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  const agentsMirror = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const cursorSeo = fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'common-seo.mdc'), 'utf8');

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
  assert.match(agentsMirror, /SEO baseline — generated and reconciled automatically/);
  assert.match(claude, /@rules\/common\/seo\.md/);
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
    const context = payload.hookSpecificOutput.additionalContext;

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
    const context = payload.hookSpecificOutput.additionalContext;

    assert.match(context, /rules\/common\/seo\.md/);
    assert.match(context, /SEO baseline reconciliation/);
  });
});

test('frontend i18n baseline is mandatory and automatic for UI work', () => {
  const i18nRule = fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'i18n.md'), 'utf8');
  const reactCore = fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'react', 'core.md'), 'utf8');
  const nativeCore = fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'react-native', 'core.md'), 'utf8');
  const i18nSkill = fs.readFileSync(path.join(ROOT, 'skills', 'i18n-text', 'SKILL.md'), 'utf8');
  const createPage = fs.readFileSync(path.join(ROOT, 'skills', 'create-page', 'SKILL.md'), 'utf8');
  const createFeature = fs.readFileSync(path.join(ROOT, 'skills', 'create-feature', 'SKILL.md'), 'utf8');
  const createComponent = fs.readFileSync(path.join(ROOT, 'skills', 'create-component', 'SKILL.md'), 'utf8');
  const newProjectRule = fs.readFileSync(path.join(ROOT, 'rules', 'modes', 'new-project.md'), 'utf8');
  const existingRule = fs.readFileSync(path.join(ROOT, 'rules', 'modes', 'existing-codebase.md'), 'utf8');
  const directives = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8');
  const frontend = fs.readFileSync(path.join(ROOT, 'agents', 'senior-frontend.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const tester = fs.readFileSync(path.join(ROOT, 'agents', 'senior-tester.md'), 'utf8');
  const promptTemplates = fs.readFileSync(
    path.join(ROOT, 'skills', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  const agentsMirror = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');

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
  assert.match(agentsMirror, /i18n baseline — generated and reconciled automatically/);
  assert.match(claude, /i18n\.md/);

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
    assert.match(context, /Frontend i18n Baseline/);
    assert.match(context, /even when the user did not explicitly ask for translations/);
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
    const context = payload.hookSpecificOutput.additionalContext;

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
    const context = payload.hookSpecificOutput.additionalContext;

    assert.match(context, /rules\/frontend\/ui-quality\.md/);
    assert.match(context, /Central design gate/);
    assert.match(context, /rules\/frontend\/typography\.md/);
    assert.match(context, /Mandatory frontend design gate/);
  });
});

test('frontend design gate rejects sparse config-banner-dominated generated UI', () => {
  const sources = {
    uiQuality: fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'ui-quality.md'), 'utf8'),
    reactDesign: fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'react', 'design-quality.md'), 'utf8'),
    newProjectRule: fs.readFileSync(path.join(ROOT, 'rules', 'modes', 'new-project.md'), 'utf8'),
    directives: fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'directives.cjs'), 'utf8'),
    frontendSkill: fs.readFileSync(path.join(ROOT, 'skills', 'frontend-design', 'SKILL.md'), 'utf8'),
    createPage: fs.readFileSync(path.join(ROOT, 'skills', 'create-page', 'SKILL.md'), 'utf8'),
    createFeature: fs.readFileSync(path.join(ROOT, 'skills', 'create-feature', 'SKILL.md'), 'utf8'),
    frontendAgent: fs.readFileSync(path.join(ROOT, 'agents', 'senior-frontend.md'), 'utf8'),
    reviewerAgent: fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8'),
    agentsMirror: fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'),
    claudeManifest: fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8'),
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
  assert.match(sources.agentsMirror, /Do not rely on path-scoped attach/);
  assert.match(sources.claudeManifest, /mandatory frontend-stack design brief/);
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

  const go = classifyPromptForStack('Build a React admin app with a Go backend');
  assert.equal(go.stack, 'custom-backend');
  assert.equal(go.backend, 'go');

  const custom = classifyPromptForStack('Build a Vue app with a Django backend and Expo mobile app');
  assert.equal(custom.stack, 'custom-stack');
  assert.equal(custom.frontend, 'vue');
  assert.equal(custom.backend, 'django');
  assert.equal(custom.mobile.framework, 'react-native-expo');

  const mobileOnly = classifyPromptForStack('Build a mobile app for tracking field jobs');
  assert.equal(mobileOnly.stack, 'custom-frontend');
  assert.equal(mobileOnly.backend, 'supabase');
  assert.equal(mobileOnly.mobile.framework, 'ionic-capacitor');
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

test('materializeProjectAssets copies only active local rules and skills', () => {
  const { materializeProjectAssets } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize.cjs'));
  withTempDir((cwd) => {
    const state = {
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'supabase',
      mobile: { enabled: true, framework: 'react-native-expo', source: 'explicit' },
    };

    const result = materializeProjectAssets(cwd, state);
    assert.ok(result.rules > 0);
    assert.ok(result.skills > 0);
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'active', 'rules', 'frontend', 'react-native', 'core.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'create-native-screen', 'SKILL.md')));
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'golang-patterns', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'nextjs-turbopack', 'SKILL.md')), false);

    const agentsPath = path.join(cwd, 'AGENTS.md');
    const claudePath = path.join(cwd, 'CLAUDE.md');
    assert.ok(fs.existsSync(agentsPath));
    assert.match(fs.readFileSync(claudePath, 'utf8'), /@\.traffic-one\/rules\/active\//);
    assert.match(fs.readFileSync(path.join(cwd, '.traffic-one', 'rules', 'manifest.json'), 'utf8'), /react-native\/core\.md/);
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

    const localRulePath = path.join(cwd, '.traffic-one', 'rules', 'active', 'rules', 'modes', 'new-project.md');
    const manifest = fs.readFileSync(path.join(cwd, '.traffic-one', 'rules', 'manifest.json'), 'utf8');
    const localAgents = fs.readFileSync(path.join(cwd, '.traffic-one', 'rules', 'AGENTS.md'), 'utf8');
    const localClaude = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');

    assert.ok(fs.existsSync(localRulePath));
    assert.match(manifest, /rules\/modes\/new-project\.md/);
    assert.match(localAgents, /\.traffic-one\/rules\/active\/rules\/modes\/new-project\.md/);
    assert.match(localClaude, /@\.traffic-one\/rules\/active\/rules\/modes\/new-project\.md/);
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
  const pythonRule = fs.readFileSync(path.join(ROOT, 'rules', 'backend', 'python.md'), 'utf8');
  assert.match(pythonRule, /do not default FastAPI apps to hand-rolled JWT auth/);
});

test('library-pick checks catalog before candidates', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'library-pick', 'SKILL.md'), 'utf8');
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
    const ctx = payload.hookSpecificOutput.additionalContext;

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
    const ctx = payload.hookSpecificOutput.additionalContext;

    assert.match(ctx, /Deployment artifact baseline/);
    assert.match(ctx, /static-host manifest/);
    assert.match(ctx, /Supabase\s+Branching/);
    assert.match(ctx, /force-update\s+version check/);
  });
});

test('deployment assistant guidance is merged, not duplicated', () => {
  const skillsRoot = path.join(ROOT, 'skills');
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
  const skillsRoot = path.join(ROOT, 'skills');
  const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const postgresReview = fs.readFileSync(path.join(skillsRoot, 'postgres-review', 'SKILL.md'), 'utf8');
  const postgresRules = fs.readFileSync(path.join(ROOT, 'rules', 'backend', 'postgres.md'), 'utf8');
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
  const skillsRoot = path.join(ROOT, 'skills');
  const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const verificationLoop = fs.readFileSync(path.join(skillsRoot, 'verification-loop', 'SKILL.md'), 'utf8');
  const stackRecommendations = fs.readFileSync(path.join(ROOT, 'rules', 'common', 'stack-recommendations.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const shipper = fs.readFileSync(path.join(ROOT, 'agents', 'senior-shipper.md'), 'utf8');
  const agentsMirror = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');

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
  assert.match(agentsMirror, /Production-readiness score/);
});

test('post-deploy observability guidance is integrated, not duplicated', () => {
  const skillsRoot = path.join(ROOT, 'skills');
  const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const observability = fs.readFileSync(path.join(skillsRoot, 'observability', 'SKILL.md'), 'utf8');
  const deploymentPatterns = fs.readFileSync(path.join(skillsRoot, 'deployment-patterns', 'SKILL.md'), 'utf8');
  const verificationLoop = fs.readFileSync(path.join(skillsRoot, 'verification-loop', 'SKILL.md'), 'utf8');
  const stackRecommendations = fs.readFileSync(path.join(ROOT, 'rules', 'common', 'stack-recommendations.md'), 'utf8');
  const reactSecurity = fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'react', 'security.md'), 'utf8');
  const reactVite = fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'react', 'vite.md'), 'utf8');
  const ionicSecurity = fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'ionic', 'security.md'), 'utf8');
  const postgresRules = fs.readFileSync(path.join(ROOT, 'rules', 'backend', 'postgres.md'), 'utf8');
  const shipper = fs.readFileSync(path.join(ROOT, 'agents', 'senior-shipper.md'), 'utf8');
  const skillFilters = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'skill-filters.cjs'), 'utf8');
  const agentsMirror = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const cursorStackRecommendations = fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'common-stack-recommendations.mdc'), 'utf8');

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
  assert.match(agentsMirror, /Post-deploy observability/);
  assert.match(cursorStackRecommendations, /Post-Deploy Observability Defaults/);
});

test('app launch checklist guidance is integrated, not duplicated', () => {
  const skillsRoot = path.join(ROOT, 'skills');
  const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const launchSkill = fs.readFileSync(path.join(skillsRoot, 'app-launch-checklist', 'SKILL.md'), 'utf8');
  const seo = fs.readFileSync(path.join(skillsRoot, 'seo', 'SKILL.md'), 'utf8');
  const ionicMobile = fs.readFileSync(path.join(skillsRoot, 'ionic-mobile', 'SKILL.md'), 'utf8');
  const deploymentPatterns = fs.readFileSync(path.join(skillsRoot, 'deployment-patterns', 'SKILL.md'), 'utf8');
  const verificationLoop = fs.readFileSync(path.join(skillsRoot, 'verification-loop', 'SKILL.md'), 'utf8');
  const stackRecommendations = fs.readFileSync(path.join(ROOT, 'rules', 'common', 'stack-recommendations.md'), 'utf8');
  const accessibility = fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'accessibility.md'), 'utf8');
  const performance = fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'performance.md'), 'utf8');
  const ionicCapacitor = fs.readFileSync(path.join(ROOT, 'rules', 'frontend', 'ionic', 'capacitor.md'), 'utf8');
  const shipper = fs.readFileSync(path.join(ROOT, 'agents', 'senior-shipper.md'), 'utf8');
  const skillFilters = fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'skill-filters.cjs'), 'utf8');
  const agentsMirror = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const ref = fs.readFileSync(path.join(ROOT, 'ref.md'), 'utf8');
  const codexManifest = fs.readFileSync(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8');
  const cursorStackRecommendations = fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'common-stack-recommendations.mdc'), 'utf8');

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
  assert.match(agentsMirror, /app-launch checklist/);
  assert.match(readme, /app launch checklist/);
  assert.match(ref, /Skills: 101/);
  assert.match(codexManifest, /Run the app launch checklist/);
  assert.match(cursorStackRecommendations, /App Launch Checklist Defaults/);
});

test('auto documentation generator guidance is present and not duplicated', () => {
  const skillsRoot = path.join(ROOT, 'skills');
  const skillNames = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const autoDocs = fs.readFileSync(path.join(skillsRoot, 'auto-documentation-generator', 'SKILL.md'), 'utf8');
  const adrSkill = fs.readFileSync(path.join(skillsRoot, 'architecture-decision-records', 'SKILL.md'), 'utf8');
  const documentationRules = fs.readFileSync(path.join(ROOT, 'rules', 'common', 'documentation.md'), 'utf8');
  const architect = fs.readFileSync(path.join(ROOT, 'agents', 'senior-architect.md'), 'utf8');
  const reviewer = fs.readFileSync(path.join(ROOT, 'agents', 'senior-reviewer.md'), 'utf8');
  const shipper = fs.readFileSync(path.join(ROOT, 'agents', 'senior-shipper.md'), 'utf8');
  const agentsMirror = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
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
  assert.match(agentsMirror, /Auto-documentation generator/);
  assert.match(claude, /@rules\/common\/documentation\.md/);
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
  const orchestrator = fs.readFileSync(path.join(ROOT, 'skills', 'senior-eng-orchestrator', 'SKILL.md'), 'utf8');
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
  const rule = fs.readFileSync(path.join(ROOT, 'rules', 'common', 'agent-handoff-digests.md'), 'utf8');
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
  const orchestrator = fs.readFileSync(path.join(ROOT, 'skills', 'senior-eng-orchestrator', 'SKILL.md'), 'utf8');
  assert.match(orchestrator, /Phase 5 — Cleanup \+ sanity check/);
  assert.match(orchestrator, /Digest sanity:/);
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
    writeJson(filePath, {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      codeGraphProvider: 'gitnexus',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-12T00:00:00Z',
    });
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
    writeJson(filePath, {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      codeGraphProvider: 'gitnexus',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-12T00:00:00Z',
    });
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
    writeJson(filePath, {
      version: 2,
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      codeGraphProvider: 'graphify',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-12T00:00:00Z',
    });

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
  const skillPath = path.join(ROOT, 'skills', 'traffic-one-doctor', 'SKILL.md');
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

// ── Toolchain version tracking (2.9.11) ────────────────────────────────────

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

test('manifests bumped to 2.9.11', () => {
  for (const rel of [
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    '.codex-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
  ]) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(text, /"version":\s*"2\.9\.11"/, `${rel} must be bumped to 2.9.11`);
  }
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
