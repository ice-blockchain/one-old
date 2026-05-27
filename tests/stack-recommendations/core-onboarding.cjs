'use strict';

module.exports = function registerCoreOnboardingTests(ctx) {
  const {
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
    writeJsonRaw,
    readProjectState,
    readEffectiveState,
    readProjectPrefs,
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
  } = ctx;

test('react stack denies next packages', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), { stack: 'react-frontend-only' });

    const result = runHook(cwd, 'check-library-allowlist', {
      tool_input: { command: 'pnpm add next next-auth' },
    });

    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /Next\.js auth uses NextAuth\/Auth\.js/);
  });
});

test('explicit nextjs state allows next packages', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    const state = readProjectState(cwd);
    const effective = readEffectiveState(cwd);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.equal(state.backend, 'supabase');
    assert.match(context, /Supabase Auth/);
    assert.match(context, /Library Catalog/);
  });
});

test('new project onboarding defaults to supabase backend', () => {
  const { getPluginVersion } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
  withTempDir((cwd) => {
    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);
    const state = readProjectState(cwd);
    const effective = readEffectiveState(cwd);

    assert.equal(defaultBackendValue(), 'supabase');
    assert.equal(state.version, getPluginVersion());
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'pluginVersion'), false);
    assert.equal(state.mode, 'new-project');
    assert.ok(effective.toolchain, 'new-project local prefs should initialize toolchain');
    assert.match(context, /backend=supabase/);
    assert.match(context, /Supabase \(managed Postgres with Auth, Storage, Realtime, and RLS\)/);
  });
});

test('new project onboarding includes Codex performance preflight', () => {
  const detectProject = fs.readFileSync(path.join(ROOT, 'skills-templates', 'detect-project', 'SKILL.md'), 'utf8');
  const directives = [
    readHookModuleSource('directives'),
    fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'onboarding-prompts.cjs'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'agents-performance-prompt.cjs'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'scripts', 'hook-runtime', 'agents-team-confirmation-prompt.cjs'), 'utf8'),
  ].join('\n');
  const orchestrator = fs.readFileSync(path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'SKILL.md'), 'utf8');
  const stackSetup = fs.readFileSync(path.join(ROOT, 'skills-templates', 'stack-setup', 'SKILL.md'), 'utf8');
  const agentsMirror = readRootAgentContext();
  const claude = readClaudeContext();

  assert.match(detectProject, /Codex Performance\/Team preflight for new projects/);
  assert.match(detectProject, /run Traffic One onboarding in the current\s+thread/);
  assert.match(detectProject, /Explicit user requests never skip Traffic One onboarding/);
  assert.match(detectProject, /Codex current-thread fallback/);
  assert.match(detectProject, /blocking preflight gate on Codex/);
  assert.match(detectProject, /request_user_input/);
  assert.match(detectProject, /Web only \(Recommended\)/);
  assert.match(detectProject, /Ionic \+ Capacitor/);
  assert.match(detectProject, /React Native \/ Expo/);
  assert.match(detectProject, /Code Graph/);
  assert.match(detectProject, /GitNexus/);
  assert.match(detectProject, /graphify/);
  assert.match(directives, /AGENT PERFORMANCE PREFLIGHT/);
  assert.match(directives, /CURRENT-THREAD ONBOARDING GATE \(all hosts\)/);
  assert.match(directives, /mode === "new-project"/);
  assert.match(directives, /complete Traffic One onboarding in the current thread/);
  assert.match(directives, /ONBOARDING POPUP RULE/);
  assert.match(directives, /CURRENT-THREAD ONBOARDING FALLBACK \(visible response, blocking\)/);
  assert.match(directives, /Your next visible assistant message must be the plain-chat fallback prompt/);
  assert.match(directives, /mention only the project-detection\/onboarding flow/);
  assert.match(directives, /Do not read, invoke, announce, or activate create-feature, create-page, frontend-design, tdd-workflow/);
  assert.match(directives, /PROJECT CONTEXT PREFLIGHT/);
  assert.match(directives, /MOBILE DECISION PREFLIGHT/);
  assert.match(directives, /explicit user requests influence the eventual stack choice/i);
  assert.match(directives, /implementation preferences, not\s+onboarding answers/);
  assert.match(directives, /CODEBASE GRAPH PROVIDER PREFLIGHT/);
  assert.match(directives, /How do you want to run agents for this build\?/);
  assert.match(directives, /High \(Recommended\)/);
  assert.match(directives, /Balanced/);
  assert.match(directives, /Low/);
  assert.match(directives, /1\. High \(Recommended\)[\s\S]*2\. Balanced[\s\S]*3\. Low/);
  assert.doesNotMatch(directives, /Balanced \(Recommended\)/);
  assert.match(directives, /request_user_input/);
  assert.match(directives, /Do NOT print "Options:" or a\s+numbered list in chat/);
  assert.match(directives, /reply with the option number or\s+label/);
  assert.match(directives, /Never choose a default/);
  assert.match(directives, /"performance": \{ "level": "<low\|balanced\|high>", "source": "prompted" \}/);
  assert.match(directives, /"team": \{ "mode": "<subagents\|main-agent>", "source": "prompted"/);
  assert.match(directives, /team\.approved: true/);
  assert.match(directives, /team\.mode="subagents"/);
  assert.match(directives, /unlocks the PreToolUse spawn gate/);
  assert.match(orchestrator, /Current-thread onboarding and consent gate/);
  assert.match(orchestrator, /Current-thread fallback is a visible first-response requirement/);
  assert.doesNotMatch(orchestrator, /Plan Mode requirement/);
  assert.match(stackSetup, /Codex current-thread fallback/);
  assert.match(stackSetup, /before any tool\s+use/);
  assert.match(orchestrator, /Code Graph/);
  assert.match(orchestrator, /reply with the option number or label/);
  assert.match(orchestrator, /Performance level/);
  assert.match(orchestrator, /High \(Recommended\)/);
  assert.match(orchestrator, /Balanced/);
  assert.match(orchestrator, /Low/);
  assert.match(orchestrator, /performance: \{ level: "balanced", source: "prompted" \}/);
  assert.match(orchestrator, /team: \{ mode: "subagents", source: "prompted" \}/);
  assert.match(orchestrator, /Do not satisfy Traffic One team execution with generic .*helper agents/i);
  assert.match(orchestrator, /senior-architect[\s\S]*PLAN_READY[\s\S]*senior-frontend[\s\S]*senior-backend/);
  assert.match(orchestrator, /wait for both to return before Phase 3/i);
  assert.match(orchestrator, /do NOT write feature source files/i);
  assert.match(stackSetup, /`team\.mode` is the source of truth/);
  assert.match(agentsMirror, /mode === "new-project"/);
  assert.match(agentsMirror, /Traffic One onboarding runs in the current thread/);
  assert.match(agentsMirror, /Use host popup input for onboarding when available/);
  assert.match(agentsMirror, /Before onboarding is resolved, mention only the project-detection\/onboarding flow/);
  assert.match(agentsMirror, /Do not read, invoke, announce, or activate implementation skills/);
  assert.match(agentsMirror, /implementation intent, not onboarding answers/);
  assert.match(agentsMirror, /Persist Agent Mode\/Performance in local Traffic One preferences/);
  assert.match(agentsMirror, /collect a rich dynamic MVP `projectContext`, then ask Mobile App, then Code Graph/);
  assert.match(agentsMirror, /team\.approved=true/);
  assert.match(agentsMirror, /team\.mode="subagents"/);
  assert.match(claude, /mode === "new-project"/);
  assert.match(claude, /Traffic One onboarding runs in the current thread/);
  assert.match(claude, /Use host popup input for onboarding when available/);
  assert.match(claude, /Before onboarding is resolved, mention only the project-detection\/onboarding flow/);
  assert.match(claude, /Do not read, invoke, announce, or activate implementation skills/);
  assert.match(claude, /implementation intent, not onboarding answers/);
  assert.match(claude, /team\.mode="subagents"/);

  withTempDir((cwd) => {
    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /CURRENT-THREAD ONBOARDING GATE \(all hosts\)/);
    assert.match(context, /mode === "new-project"/);
    assert.match(context, /complete Traffic One onboarding in the current thread/);
    assert.match(context, /ONBOARDING POPUP RULE/);
    assert.match(context, /CURRENT-THREAD ONBOARDING FALLBACK \(visible response, blocking\)/);
    assert.doesNotMatch(context, /Plan mode is required for Traffic One new-project onboarding/);
    assert.match(context, /Do not read, invoke, announce, or activate create-feature, create-page, frontend-design, tdd-workflow/);
    assert.match(context, /PROJECT CONTEXT PREFLIGHT/);
    assert.match(context, /MOBILE DECISION PREFLIGHT/);
    assert.match(context, /implementation preferences, not\s+onboarding answers/);
    assert.match(context, /CODEBASE GRAPH PROVIDER PREFLIGHT/);
    assert.match(context, /Do you want a mobile app too\?/);
    assert.match(context, /Web only \(Recommended\)/);
    assert.match(context, /Ionic \+ Capacitor/);
    assert.match(context, /React Native \/ Expo/);
    assert.match(context, /Which provider should we use for the codebase graph\?/);
    assert.match(context, /GitNexus/);
    assert.match(context, /graphify/);
    assert.match(context, /AGENT PERFORMANCE PREFLIGHT/);
    assert.match(context, /How do you want to run agents for this build\?/);
    assert.match(context, /High \(Recommended\)/);
    assert.match(context, /Balanced/);
    assert.match(context, /Low/);
    assert.match(context, /1\. High \(Recommended\)[\s\S]*2\. Balanced[\s\S]*3\. Low/);
    assert.doesNotMatch(context, /Balanced \(Recommended\)/);
    assert.match(context, /"performance": \{ "level": "<low\|balanced\|high>", "source": "prompted" \}/);
    assert.match(context, /"team": \{ "mode": "<subagents\|main-agent>", "source": "prompted"/);
    assert.match(context, /team\.approved: true/);
    assert.match(context, /team\.mode="subagents"/);
    assert.ok(context.indexOf('AGENT PERFORMANCE PREFLIGHT') < context.indexOf('PROJECT CONTEXT PREFLIGHT'));
    assert.ok(context.indexOf('PROJECT CONTEXT PREFLIGHT') < context.indexOf('MOBILE DECISION PREFLIGHT'));
    assert.ok(context.indexOf('MOBILE DECISION PREFLIGHT') < context.indexOf('CODEBASE GRAPH PROVIDER PREFLIGHT'));
  });
});

test('Traffic One entry skills do not embed auth gate wording', () => {
  const relPaths = [
    'skills/detect-project/SKILL.md',
    'skills/stack-setup/SKILL.md',
    'skills-templates/detect-project/SKILL.md',
    'skills-templates/stack-setup/SKILL.md',
    'skills-templates/senior-eng-orchestrator/SKILL.md',
    'skills-templates/create-feature/SKILL.md',
    'skills-templates/create-page/SKILL.md',
    'skills-templates/create-component/SKILL.md',
    'skills-templates/create-service/SKILL.md',
    'skills-templates/frontend-design/SKILL.md',
    'skills-templates/tdd-workflow/SKILL.md',
  ];

  for (const relPath of relPaths) {
    const body = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    assert.doesNotMatch(body, /Auth gate:/, relPath);
    assert.doesNotMatch(body, /scripts\/traffic-one-auth/, relPath);
    assert.doesNotMatch(body, /Traffic One Auth Preflight/, relPath);
    assert.doesNotMatch(body, /host modal selector/, relPath);
    assert.doesNotMatch(body, /mcp__mcp_auth__auth_status/, relPath);
    assert.doesNotMatch(body, /hook runs login and\s+status internally/, relPath);
  }
});

test('first prompt reminder asks agent mode before project details and mobile (after OpenCode opt-in)', () => {
  withTempDir((cwd) => {
    runHook(cwd, 'session-start');

    // The OpenCode token-economy opt-in is the first onboarding step (its own
    // coverage lives in scripts/test-onboarding-token-economy.cjs). Resolve it
    // here so this test can focus on the agent-mode prompt that follows.
    seedOpenCodeResolved(cwd);

    const result = runHook(cwd, 'user-prompt-submit', {
      prompt: 'create a modern learning platform with courses and an admin area to manage courses and users',
    });
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.equal(payload.promptRequest.id, 'traffic-one.onboarding.performance');
    assert.equal(payload.promptRequest.kind, 'single_select');
    assert.equal(payload.promptRequest.title, 'Performance');
    assert.deepEqual(payload.promptRequest.options.map((option) => option.id), ['high', 'balanced', 'low']);
    assert.match(payload.promptRequest.fallbackText, /How do you want to run agents for this build/);
    assert.match(context, /\[FIRST PROMPT STACK CLASSIFICATION\]/);
    assert.match(context, /stack=default/);
    assert.match(context, /mode=new-project/);
    assert.match(context, /complete Traffic One onboarding in the current thread/);
    assert.match(context, /CURRENT-THREAD ONBOARDING FALLBACK \(visible response, blocking\)/);
    assert.match(context, /Your next visible assistant message must be the plain-chat fallback prompt/);
    assert.doesNotMatch(context, /Plan mode is required for Traffic One new-project onboarding/);
    assert.match(context, /Onboarding choices must be prompt popups/);
    assert.match(context, /reply with the option number or label/);
    assert.match(context, /never choose a default/i);
    assert.match(context, /request_user_input/);
    assert.match(context, /Next unresolved Traffic One onboarding step: Agent mode/);
    assert.match(context, /How do you want to run agents for this build\?/);
    assert.match(context, /High \(Recommended\)/);
    assert.match(context, /Balanced/);
    assert.match(context, /Low/);
    assert.match(context, /balanced\/high subagents/);
    assert.match(context, /main-agent/);
    assert.match(context, /Team Confirmation/);
    assert.match(context, /Traffic One was successfully set up\. Let's collect the project details next\./);
    assert.match(context, /project context, Mobile App, then Code Graph/);
    assert.doesNotMatch(context, /\[ACTIVE SKILLS[^\n]*(create-feature|create-page|frontend-design|tdd-workflow)/);
    assert.match(context, /Team Confirmation/);
    assert.doesNotMatch(context, /Do you want a mobile app too\?/);
    assert.doesNotMatch(context, /Which provider should we use for the codebase graph\?/);
    assert.doesNotMatch(context, /auto-launch the subagent team — no separate Run team\? confirmation/);
  });
});

test('explicit stack or mobile prompt still reaches agent mode after the OpenCode opt-in', () => {
  withTempDir((cwd) => {
    runHook(cwd, 'session-start');

    // Resolve the first step (OpenCode opt-in) so the next prompt is agent mode.
    seedOpenCodeResolved(cwd);

    const result = runHook(cwd, 'user-prompt-submit', {
      prompt: 'fa-mi un site complet pentru jobs cu Next.js, web only, fara subagenti',
    });
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /\[FIRST PROMPT STACK CLASSIFICATION\]/);
    assert.match(context, /stack=custom-frontend/);
    assert.match(context, /frontend=nextjs/);
    assert.match(context, /Next unresolved Traffic One onboarding step: Agent mode/);
    assert.match(context, /How do you want to run agents for this build\?/);
    assert.match(context, /Low/);
    assert.match(context, /project context, Mobile App, then Code Graph/);
    assert.doesNotMatch(context, /Do you want a mobile app too\?/);
    assert.doesNotMatch(context, /skip the mobile popup/);
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
    assert.match(compact, /Prerequisite: do not read, invoke, or activate this skill during Traffic One new-project onboarding/i, rel);
    assert.match(compact, /Traffic One onboarding guard: Do not read, invoke, or activate during Traffic One new-project onboarding/i, rel);
    assert.match(compact, /detect-project/, rel);
    assert.match(compact, /stack-setup/, rel);
    assert.match(compact, /onboardingComplete/, rel);
    assert.ok(
      compact.indexOf('Prerequisite:') < compact.indexOf('Once onboarding is resolved'),
      `${rel} must state onboarding prerequisites before broad activation wording`,
    );
  }
});

test('incomplete new-project state exposes only bootstrap skills', () => {
  const active = activeSkillsFor({
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    onboardingComplete: false,
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
  });

  assert.deepEqual([...active].sort(), ['auth', 'detect-project', 'stack-setup', 'traffic-one-doctor']);
  for (const skillName of [
    'create-component',
    'create-feature',
    'create-page',
    'create-service',
    'frontend-design',
    'frontend-patterns',
    'tdd-workflow',
  ]) {
    assert.equal(active.has(skillName), false, `${skillName} must wait for onboardingComplete`);
  }
});

test('completed new-project state activates implementation skills', () => {
  const active = activeSkillsFor({
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    onboardingComplete: true,
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
  });

  for (const skillName of [
    'detect-project',
    'stack-setup',
    'create-component',
    'create-feature',
    'create-page',
    'create-service',
    'frontend-design',
    'tdd-workflow',
  ]) {
    assert.equal(active.has(skillName), true, `${skillName} should be active after onboardingComplete`);
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
  assert.match(preToolUse[0].matcher, /exec_command/);
  assert.match(preToolUse[0].matcher, /apply_patch/);
  assert.match(preToolUse[0].hooks[0].command, /check-onboarding-gate/);
  const agentModelHook = preToolUse.find((entry) => /check-agent-model/.test(entry.hooks[0].command));
  assert.ok(agentModelHook, 'hooks.json must include the dedicated agent model/team confirmation gate');
  assert.match(agentModelHook.matcher, /Task/);
  assert.match(agentModelHook.matcher, /Agent/);
  assert.match(agentModelHook.matcher, /spawn_agent/);
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
  assert.match(preToolUse[0].matcher, /exec_command/);
  assert.match(preToolUse[0].matcher, /apply_patch/);
  assert.match(preToolUse[0].hooks[0].command, /check-onboarding-gate/);
  const agentModelHook = preToolUse.find((entry) => /check-agent-model/.test(entry.hooks[0].command));
  assert.ok(agentModelHook, 'settings.json must mirror the dedicated agent model/team confirmation gate');
  assert.match(agentModelHook.matcher, /Task/);
  assert.match(agentModelHook.matcher, /Agent/);
  assert.match(agentModelHook.matcher, /spawn_agent/);
  const architectureHook = preToolUse.find((entry) => /check-architecture-write/.test(entry.hooks[0].command));
  assert.ok(architectureHook);
  assert.match(architectureHook.matcher, /Bash/);
  assert.match(architectureHook.matcher, /Write/);
  assert.match(architectureHook.matcher, /Edit/);
  assert.ok(preToolUse.some((entry) => /pre-graphify-hint/.test(entry.hooks[0].command)));

  const bashPostHook = postToolUse.find((entry) => /Bash/.test(entry.matcher));
  assert.ok(bashPostHook, 'Claude settings must run Bash post hooks');
  assert.match(bashPostHook.matcher, /exec_command/);
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
    assert.match(reason, /Complete Traffic One onboarding in the current thread/);
    assert.match(reason, /next unresolved fallback prompt must be displayed as the next visible assistant message/);
    assert.match(reason, /Your next visible assistant message must ask only this unresolved step/);
    // OpenCode token-economy opt-in is the first onboarding step.
    assert.match(reason, /Save tokens by delegating coding tasks to OpenCode/);
    assert.match(reason, /Enable OpenCode delegation/);
    assert.match(reason, /Not now/);
    assert.match(reason, /Reply with the option number or label/);
    assert.match(reason, /remaining onboarding prompts are resolved/);
    assert.match(reason, /Do not choose defaults/);
    assert.match(reason, /inspect package versions/);
  });
});

test('onboarding gate allows read-only orientation but blocks mutations on partial new-project state', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      version: 3,
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      confirmed: false,
      onboardingComplete: false,
    });

    // Read-only orientation is allowed so the agent can find its cwd and read
    // context before writing `.traffic-one/.one.json` (otherwise the gate deadlocks:
    // it blocks the `pwd`/`Read` needed to locate where the file must go).
    for (const probe of [
      { tool_name: 'Read', tool_input: { file_path: 'package.json' } },
      { tool_name: 'Grep', tool_input: { pattern: 'foo' } },
      { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } },
      { tool_name: 'Bash', tool_input: { command: 'pwd' } },
      { tool_name: 'Bash', tool_input: { command: 'ls -la' } },
    ]) {
      const result = runHook(cwd, 'check-onboarding-gate', probe);
      assert.equal(result.stdout.trim(), '', `${probe.tool_name} ${JSON.stringify(probe.tool_input)} should be allowed during onboarding`);
    }

    // Mutations, installs, and agent spawns stay blocked until onboarding completes.
    for (const probe of [
      { tool_name: 'Write', tool_input: { file_path: 'src/App.tsx', content: 'x' } },
      { tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } },
      { tool_name: 'spawn_agent', tool_input: { agent_type: 'explorer', message: 'go' } },
    ]) {
      const result = runHook(cwd, 'check-onboarding-gate', probe);
      const parsed = parseStdoutJson(result);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', `${probe.tool_name} should be denied during onboarding`);
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /onboarding is not complete/);
    }
  });
});

test('onboarding gate fallback resumes at the next missing onboarding step', () => {
  const cases = [
    {
      name: 'open code',
      state: completeDefaultState({ openCode: undefined }),
      expected: [/Next unresolved Traffic One onboarding step: OpenCode delegation opt-in/, /Save tokens by delegating coding tasks to OpenCode/],
      absent: /Do you want a mobile app too/,
      promptId: 'traffic-one.onboarding.open-code',
      promptKind: 'single_select',
      optionIds: ['enable', 'not_now'],
    },
    {
      name: 'performance',
      state: completeDefaultState({ performance: undefined }),
      expected: [/Next unresolved Traffic One onboarding step: Agent mode/, /How do you want to run agents for this build/],
      absent: /Do you want a mobile app too/,
      promptId: 'traffic-one.onboarding.performance',
      promptKind: 'single_select',
      optionIds: ['high', 'balanced', 'low'],
    },
    {
      name: 'team approval',
      state: completeDefaultState({ team: { mode: 'subagents', source: 'prompted' } }),
      expected: [/Traffic One Team Confirmation is still required/, /Traffic One — confirm the subagent team/],
      absent: /Do you want a mobile app too/,
      promptId: 'traffic-one.onboarding.team-confirmation',
      promptKind: 'single_select',
      optionIds: ['approve', 'repick_performance', 'customise'],
    },
    {
      name: 'project context',
      state: completeDefaultState({ projectContext: undefined }),
      expected: [/Traffic One was successfully set up\. Let's collect the project details next/, /Answer these MVP-context questions/],
      absent: /Do you want a mobile app too/,
      promptId: 'traffic-one.onboarding.project-context',
      promptKind: 'text',
    },
    {
      name: 'mobile',
      state: completeDefaultState({ mobile: { enabled: false, framework: 'none', source: 'none' } }),
      expected: [/Traffic One needs the mobile app decision/, /Do you want a mobile app too/],
      absent: /Which provider should we use for the codebase graph/,
      promptId: 'traffic-one.onboarding.mobile',
      promptKind: 'single_select',
      optionIds: ['web_only', 'ionic_capacitor', 'react_native_expo'],
    },
    {
      name: 'code graph',
      state: completeDefaultState({ codeGraphProvider: undefined }),
      expected: [/Traffic One needs the code graph provider/, /Which provider should we use for the codebase graph/],
      absent: /How do you want to run agents for this build/,
      promptId: 'traffic-one.onboarding.code-graph',
      promptKind: 'single_select',
      optionIds: ['gitnexus', 'graphify'],
    },
  ];

  for (const { name, state, expected, absent, promptId, promptKind, optionIds } of cases) {
    withTempDir((cwd) => {
      writeJson(path.join(cwd, '.traffic-one/.one.json'), state);
      const result = runHook(cwd, 'check-onboarding-gate', {
        tool_input: { command: 'ls -la' },
      });
      const parsed = parseStdoutJson(result);
      const reason = parsed.hookSpecificOutput.permissionDecisionReason;

      assert.equal(parsed.promptRequest.id, promptId, name);
      assert.equal(parsed.promptRequest.kind, promptKind, name);
      assert.equal(parsed.promptRequest.blocking, true, name);
      assert.match(parsed.promptRequest.fallbackText, expected[0], name);
      if (optionIds) {
        assert.deepEqual(parsed.promptRequest.options.map((option) => option.id), optionIds, name);
      }
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', name);
      for (const pattern of expected) assert.match(reason, pattern, name);
      assert.doesNotMatch(reason, absent, name);
    });
  }
});

test('project context prompt asks expanded MVP questionnaire', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      projectContext: {
        source: 'prompted',
        originalPrompt: 'create a modern learning platform with courses for web development. use latest tech, make it responsive. create also a admin area where I can manage courses, users, etc.',
        summary: '',
        answers: {},
        collectedAt: '',
      },
    }));

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });
    const parsed = parseStdoutJson(result);
    const text = parsed.promptRequest.fallbackText;

    assert.equal(parsed.promptRequest.id, 'traffic-one.onboarding.project-context');
    assert.equal(parsed.promptRequest.kind, 'text');
    assert.match(text, /Original request I should tailor this to/);
    assert.match(text, /Audience and jobs/);
    assert.match(text, /Roles and auth/);
    assert.match(text, /Data model/);
    assert.match(text, /Admin and operations/);
    assert.match(text, /Business model and payments/);
    assert.match(text, /Content and integrations/);
    assert.match(text, /Success criteria and product tone/);
    assert.match(text, /audience, coreFlows, v1Features, rolesAuth, businessModel, payments, admin, dataModel, contentSource, integrations, engagement, successMetrics, constraints, domainSpecific/);
    assert.match(text, /Learning platform specifics/);
    assert.match(text, /course\/module\/lesson structure/);
    assert.match(text, /lesson types/);
    assert.match(text, /progress\/completion rules/);
    assert.match(text, /free vs paid courses/);
    assert.match(text, /enrollment model/);
    assert.match(text, /learner\/instructor\/admin roles/);
    assert.match(text, /admin CRUD scope/);
    assert.match(text, /seeded demo content/);
    assert.match(text, /analytics/);
    assert.match(text, /payments are in or out for v1/);
    assert.doesNotMatch(text, /polished working demo with local seeded data, or include a real Supabase backend setup now/);
  });
});

test('project context prompt asks payment-provider details only for likely paid products', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      projectContext: {
        source: 'prompted',
        originalPrompt: 'Build an ecommerce marketplace with subscriptions and seller payouts',
        summary: '',
        answers: {},
        collectedAt: '',
      },
    }));

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });
    const parsed = parseStdoutJson(result);
    const text = parsed.promptRequest.fallbackText;

    assert.match(text, /Payment integration, if money is in scope/);
    assert.match(text, /Stripe or other provider/);
    assert.match(text, /subscriptions vs one-time checkout/);
    assert.match(text, /webhooks/);
    assert.match(text, /refunds/);
    assert.match(text, /invoices/);
    assert.match(text, /taxes/);
    assert.match(text, /coupons/);
    assert.match(text, /payouts\/commissions/);
    assert.match(text, /Marketplace specifics/);
    assert.match(text, /Ecommerce specifics/);
  });

  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      projectContext: {
        source: 'prompted',
        originalPrompt: 'Build a simple internal notes tool for our team',
        summary: '',
        answers: {},
        collectedAt: '',
      },
    }));

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });
    const parsed = parseStdoutJson(result);
    const text = parsed.promptRequest.fallbackText;

    assert.match(text, /Business model and payments/);
    assert.doesNotMatch(text, /Stripe or other provider/);
    assert.match(text, /Internal-tool specifics/);
  });
});

test('onboarding gate repairs missing bookkeeping after required choices exist', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      version: 3,
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      realtime: 'light',
      projectContext: completeDefaultState().projectContext,
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      codeGraphProvider: 'gitnexus',
      openCode: { enabled: false, source: 'prompted', decidedAt: '2026-05-13T09:58:00Z' },
      performance: { level: 'high', source: 'prompted' },
      team: { mode: 'subagents', source: 'prompted', approved: true },
      onboardingComplete: true,
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });
    const parsed = parseStdoutJson(result);
    const state = readProjectState(cwd);
    const effective = readEffectiveState(cwd);

    assert.match(parsed.hookSpecificOutput.additionalContext, /Project-local rules\/skills/);
    assert.equal(state.version, '2.9.70');
    assert.equal(state.confirmed, true);
    assert.ok(state.confirmedAt);
    assert.ok(Array.isArray(state.technologies.frontend));
    assert.ok(effective.toolchain.gitnexus);
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'create-page', 'SKILL.md')));
  });
});

test('onboarding gate repairs and denies mutating tools once after compact state convergence', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), compactWebdevAcademyState());

    const first = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'Write',
      tool_input: { file_path: 'apps/web/src/App.tsx', content: 'export const x = 1;\n' },
    });
    const firstPayload = parseStdoutJson(first);
    const state = readEffectiveState(cwd);

    assert.equal(firstPayload.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(firstPayload.hookSpecificOutput.permissionDecisionReason, /repaired\/materialized/);
    assert.match(firstPayload.hookSpecificOutput.permissionDecisionReason, /rerun/);
    assert.equal(state.stack, 'default');
    assert.equal(state.codeGraphProvider, 'gitnexus');
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));

    const second = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'Write',
      tool_input: { file_path: 'apps/web/src/App.tsx', content: 'export const x = 1;\n' },
    });
    assert.equal(second.stdout, '');
  });
});

test('onboarding gate repairs nested stack.codeGraph.provider into top-level codeGraphProvider', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), compactWebdevAcademyState({
      stack: { codeGraph: { provider: 'GitNexus' } },
      codeGraphProvider: undefined,
    }));

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'Write',
      tool_input: { file_path: 'apps/web/src/App.tsx', content: 'export const x = 1;\n' },
    });
    const parsed = parseStdoutJson(result);
    const state = readEffectiveState(cwd);

    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(state.codeGraphProvider, 'gitnexus');
    assert.equal(state.performance.level, 'high');
    assert.equal(state.team.approved, true);
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
  });
});

test('onboarding gate denies ad hoc new-project state that skipped performance and team confirmation', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      projectMode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase-ready',
      mobile: { framework: 'web-only' },
      codeGraphProvider: 'GitNexus',
      subagentTeam: 'enabled',
      notes: ['legacy shape that skipped the required prompts'],
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'spawn_agent',
      tool_input: { agent_type: 'explorer', message: 'review architecture' },
    });
    const parsed = parseStdoutJson(result);

    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /performance/i);
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /team\.approved|Team Confirmation/i);
  });
});

test('user prompt submit re-surfaces Team Confirmation when subagents are selected but not approved', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      team: { mode: 'subagents', source: 'prompted' },
    }));

    const result = runHook(cwd, 'user-prompt-submit', {
      prompt: 'ok continue',
    });
    const parsed = parseStdoutJson(result);
    const context = parsed.hookSpecificOutput.additionalContext;

    assert.equal(parsed.systemMessage, 'traffic-one [team confirmation required]');
    assert.match(context, /Team Confirmation is still required/);
    assert.match(context, /multi-agent performance level/);
    assert.match(context, /team\.approved: true/);
    assert.match(context, /Traffic One — confirm the subagent team for HIGH mode/);
    assert.match(context, /senior-architect/);
    assert.match(context, /senior-tester/);
    assert.match(context, /1\. Approve/);
    assert.match(context, /2\. Re-pick performance/);
    assert.match(context, /3\. Customise/);
  });
});

test('onboarding gate points directly to Team Confirmation when it is the only missing multi-agent prompt', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      team: { mode: 'subagents', source: 'prompted' },
    }));

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'spawn_agent',
      tool_input: { agent_type: 'worker', type: 'senior-frontend', message: 'build UI' },
    });
    const parsed = parseStdoutJson(result);
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;

    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(reason, /Team Confirmation gate/);
    assert.match(reason, /role\/model lineup has not been approved/);
    assert.match(reason, /Traffic One — confirm the subagent team for HIGH mode/);
    assert.match(reason, /1\. Approve/);
    assert.match(reason, /2\. Re-pick performance/);
    assert.match(reason, /3\. Customise/);
    assert.doesNotMatch(reason, /Do you want a mobile app too/);
  });
});

test('team.source unavailable does not bypass approval for a selected subagent team', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      team: { mode: 'subagents', source: 'unavailable' },
    }));

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'spawn_agent',
      tool_input: { agent_type: 'worker', type: 'senior-backend', message: 'build API' },
    });
    const parsed = parseStdoutJson(result);
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;

    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(reason, /Team Confirmation gate/);
    assert.match(reason, /explicitly say they no longer want subagents and want Low\/main-agent/);
    assert.match(reason, /Traffic One — confirm the subagent team for HIGH mode/);
  });
});

test('team mode guard denies direct subagents to main-agent state write without user intent', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());
    const proposed = completeDefaultState({
      performance: { level: 'low', source: 'prompted' },
      team: { mode: 'main-agent', source: 'prompted' },
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'Write',
      tool_input: {
        file_path: '.traffic-one/.one.json',
        content: `${JSON.stringify(proposed, null, 2)}\n`,
      },
    });
    const parsed = parseStdoutJson(result);

    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /team mode guard/);
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /latest user prompt/);
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /team\.source="unavailable"/);
  });
});

test('team mode guard denies apply_patch subagents to main-agent rewrite without user intent', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'apply_patch',
      tool_input: {
        input: [
          '*** Begin Patch',
          '*** Update File: .traffic-one/.one.json',
          '@@',
          '-    "mode": "subagents",',
          '+    "mode": "main-agent",',
          '*** End Patch',
          '',
        ].join('\n'),
      },
    });
    const parsed = parseStdoutJson(result);

    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /team mode guard/);
  });
});

test('team mode guard records explicit user intent and allows one downgrade write', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());
    const prompt = runHook(cwd, 'user-prompt-submit', {
      prompt: 'I do not want to use subagents anymore, switch to main-agent.',
    });
    const promptPayload = parseStdoutJson(prompt);
    let state = readProjectPrefs(cwd);

    assert.equal(promptPayload.systemMessage, 'traffic-one [team mode switch authorized]');
    assert.equal(state.team.modeChangeApproval.from, 'subagents');
    assert.equal(state.team.modeChangeApproval.to, 'main-agent');
    assert.equal(state.team.modeChangeApproval.source, 'user-prompt');
    assert.match(state.team.modeChangeApproval.promptHash, /^[a-f0-9]{64}$/);

    const proposed = completeDefaultState({
      performance: { level: 'low', source: 'prompted' },
      team: { mode: 'main-agent', source: 'prompted' },
    });
    const allowed = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'Write',
      tool_input: {
        file_path: '.traffic-one/.one.json',
        content: `${JSON.stringify(proposed, null, 2)}\n`,
      },
    });
    state = readProjectPrefs(cwd);

    assert.equal(allowed.stdout, '');
    assert.equal(state.team.modeChangeApproval, undefined);
  });
});

test('team mode guard denies manual writes of the internal approval marker', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());
    const proposed = completeDefaultState({
      team: {
        mode: 'subagents',
        source: 'prompted',
        approved: true,
        modeChangeApproval: {
          from: 'subagents',
          to: 'main-agent',
          source: 'user-prompt',
          requestedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          promptHash: 'b'.repeat(64),
        },
      },
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'Write',
      tool_input: {
        file_path: '.traffic-one/.one.json',
        content: `${JSON.stringify(proposed, null, 2)}\n`,
      },
    });
    const parsed = parseStdoutJson(result);
    const state = readProjectPrefs(cwd);

    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /modeChangeApproval/);
    assert.equal(state.team.modeChangeApproval, undefined);
  });
});

test('team mode guard denies apply_patch writes of the internal approval marker', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'apply_patch',
      tool_input: {
        input: [
          '*** Begin Patch',
          '*** Update File: .traffic-one/.one.json',
          '@@',
          '     "approved": true',
          '+    "modeChangeApproval": { "from": "subagents", "to": "main-agent" }',
          '*** End Patch',
          '',
        ].join('\n'),
      },
    });
    const parsed = parseStdoutJson(result);

    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /modeChangeApproval/);
  });
});

test('team mode guard denies downgrade when approval marker is stale', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      team: {
        mode: 'subagents',
        source: 'prompted',
        approved: true,
        modeChangeApproval: {
          from: 'subagents',
          to: 'main-agent',
          source: 'user-prompt',
          requestedAt: '2000-01-01T00:00:00Z',
          promptHash: 'a'.repeat(64),
        },
      },
    }));
    const proposed = completeDefaultState({
      performance: { level: 'low', source: 'prompted' },
      team: { mode: 'main-agent', source: 'prompted' },
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'Write',
      tool_input: {
        file_path: '.traffic-one/.one.json',
        content: `${JSON.stringify(proposed, null, 2)}\n`,
      },
    });
    const parsed = parseStdoutJson(result);

    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /team mode guard/);
  });
});

test('team mode guard does not record approval for vague subagent availability text', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());

    runHook(cwd, 'user-prompt-submit', {
      prompt: 'Subagents are unavailable right now.',
    });
    const state = readProjectPrefs(cwd);

    assert.equal(state.team.modeChangeApproval, undefined);
  });
});

test('team mode guard allows initial low onboarding state write', () => {
  withTempDir((cwd) => {
    const proposed = completeDefaultState({
      performance: { level: 'low', source: 'prompted' },
      team: { mode: 'main-agent', source: 'prompted' },
    });

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'Write',
      tool_input: {
        file_path: '.traffic-one/.one.json',
        content: `${JSON.stringify(proposed, null, 2)}\n`,
      },
    });

    assert.equal(result.stdout, '');
  });
});

test('team mode guard allows main-agent to subagents upgrade write', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      performance: { level: 'low', source: 'prompted' },
      team: { mode: 'main-agent', source: 'prompted' },
    }));
    const proposed = completeDefaultState();

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'Write',
      tool_input: {
        file_path: '.traffic-one/.one.json',
        content: `${JSON.stringify(proposed, null, 2)}\n`,
      },
    });

    assert.equal(result.stdout, '');
  });
});

test('agent model gate materializes and denies role spawn once before workers start', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());

    const first = runHook(cwd, 'check-agent-model', {
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'senior-backend',
        model: 'sonnet',
      },
    });
    const firstPayload = parseStdoutJson(first);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

    assert.equal(firstPayload.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(firstPayload.hookSpecificOutput.permissionDecisionReason, /agent spawn/i);
    assert.match(firstPayload.hookSpecificOutput.permissionDecisionReason, /repaired\/materialized/);
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));

    const second = runHook(cwd, 'check-agent-model', {
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'senior-backend',
        model: 'opus',
      },
    });
    assert.equal(second.stdout, '');
  });
});

test('onboarding gate still denies when required graph choice is missing', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      version: 3,
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      projectContext: completeDefaultState().projectContext,
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
      performance: { level: 'high', source: 'prompted' },
      team: { mode: 'subagents', source: 'prompted', approved: true },
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

test('onboarding gate still denies compact state when graph choice is missing', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), compactWebdevAcademyState({
      stack: { codeGraph: undefined },
    }));

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'Write',
      tool_input: { file_path: 'apps/web/src/App.tsx', content: 'export const x = 1;\n' },
    });
    const parsed = parseStdoutJson(result);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /codeGraphProvider/);
  });
});

test('onboarding gate still denies when required team choice is missing', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      version: '2.9.70',
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      projectContext: completeDefaultState().projectContext,
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
      realtime: 'none',
      codeGraphProvider: 'gitnexus',
      openCode: { enabled: false, source: 'prompted', decidedAt: '2026-05-13T09:58:00Z' },
      performance: { level: 'high', source: 'prompted' },
      toolchain: require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs')).initializeToolchainState({}),
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
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /Traffic One Team Confirmation is still required/);
  });
});

test('onboarding gate still denies compact state when team choice is missing', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), compactWebdevAcademyState({
      stack: { team: undefined },
    }));

    const result = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'Write',
      tool_input: { file_path: 'apps/web/src/App.tsx', content: 'export const x = 1;\n' },
    });
    const parsed = parseStdoutJson(result);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /team/);
  });
});

test('onboarding gate allows .traffic-one/.one.json repair writes with relative or absolute paths', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      version: 3,
      mode: 'new-project',
    });

    const relative = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { file_path: '.traffic-one/.one.json' },
    });
    const absolute = runHook(cwd, 'check-onboarding-gate', {
      tool_input: { file_path: path.join(cwd, '.traffic-one/.one.json') },
    });
    const patch = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'apply_patch',
      tool_input: {
        input: [
          '*** Begin Patch',
          '*** Update File: .traffic-one/.one.json',
          '@@',
          '-  "onboardingComplete": false',
          '+  "onboardingComplete": true',
          '*** End Patch',
          '',
        ].join('\n'),
      },
    });
    const absolutePatch = runHook(cwd, 'check-onboarding-gate', {
      tool_name: 'apply_patch',
      tool_input: {
        input: [
          '*** Begin Patch',
          `*** Update File: ${path.join(cwd, '.traffic-one/.one.json')}`,
          '@@',
          '-  "confirmed": false',
          '+  "confirmed": true',
          '*** End Patch',
          '',
        ].join('\n'),
      },
    });

    assert.equal(relative.stdout, '');
    assert.equal(absolute.stdout, '');
    assert.equal(patch.stdout, '');
    assert.equal(absolutePatch.stdout, '');
  });
});

test('onboarding gate allows tools only after complete v3 onboarding state exists', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({ codeGraphProvider: 'graphify' }));

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
    stacks: readHookModuleSource('stacks'),
    directives: readHookModuleSource('directives'),
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

    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      version: 2,
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmedAt: '2026-05-08T10:00:00Z',
    }));

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(context, /rules\/frontend\/react\/supabase-client\.md/);
    assert.match(context, /https:\/\/traffic\.io\//);
    assert.match(context, /Add a regression test for the Traffic CTA/);
  });
});

};
