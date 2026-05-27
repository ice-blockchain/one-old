'use strict';

module.exports = function registerMaterializationTests(ctx) {
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

test('new projects must include the auto-documentation baseline', () => {
  const documentationRules = readRule('rules/common/documentation.md');
  const newProjectRule = readRule('rules/modes/new-project.md');
  const directives = readHookModuleSource('directives');
  const stacks = readHookModuleSource('stacks');
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
  const directives = readHookModuleSource('directives');
  const stacks = readHookModuleSource('stacks');
  const skillFilters = readHookModuleSource('skill-filters');
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
  assert.match(memoryRules, /Root `\.traffic-one\/\.one\.json`/);
  assert.match(memoryRules, /\.traffic-one\/decisions\//);
  assert.match(memoryRules, /\.traffic-one\/coding\.md/);
  assert.match(memoryRules, /\.traffic-one\/deployments\.jsonl/);
  assert.match(memoryRules, /\.traffic-one\/mcp\.json/);
  assert.match(memoryRules, /Root `AGENTS\.md` contains the\s+compact active rule kernel and index by default/);
  assert.doesNotMatch(memoryRules, /Root `AGENTS\.md` should symlink/);
  assert.doesNotMatch(memoryRules, /\.traffic-one\/rules\/AGENTS\.md`: canonical/);
  assert.match(memorySkill, /root `AGENTS\.md` containing the compact active rule kernel\/index by default/);
  assert.match(memorySkill, /Create, refresh, or audit the Traffic One `.traffic-one\/` project memory/);
  assert.match(memorySkill, /root `\.traffic-one\/\.one\.json`/);
  assert.match(newProjectRule, /Project memory baseline/);
  assert.match(newProjectRule, /root `\.traffic-one\/\.one\.json` exists/);
  assert.match(newProjectRule, /Root `AGENTS\.md` is the canonical active agent context/);
  assert.match(existingRule, /run the `project-memory` baseline reconciliation/);
  assert.match(existingRule, /root `\.traffic-one\/\.one\.json` exists/);
  assert.match(directives, /Project memory baseline: create/);
  assert.match(directives, /Verify the root companion state file/);
  assert.match(directives, /project-memory/);
  assert.match(directives, /Root AGENTS\.md contains the compact active rule kernel\/index by\s+default/);
  assert.match(stacks, /rules\/common\/project-memory\.md/);
  assert.match(skillFilters, /'project-memory'/);
  assert.match(architect, /project-memory/);
  assert.match(backend, /refresh `.traffic-one\/schema\.sql`/);
  assert.match(shipper, /Append one JSON line to `.traffic-one\/deployments\.jsonl`/);
  assert.match(promptTemplates, /Read \.traffic-one\/\.one\.json plus existing project memory/);
  assert.match(agentsMirror, /\.traffic-one\/skills\/project-memory\/SKILL\.md/);
  assert.match(claude, /\.traffic-one\/skills\/project-memory\/SKILL\.md/);
  assert.match(cursorMemory, /\.traffic-one\/agent-log\.md/);
  assert.match(cursorNewProject, /Project memory baseline/);
});

test('SessionStart bundle includes project-memory guidance and banner', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      version: 2,
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmedAt: '2026-05-08T12:00:00Z',
    }));
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      version: 2,
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmedAt: '2026-05-08T12:00:00Z',
    }));

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
  const directives = readHookModuleSource('directives');
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
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

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
  const directives = readHookModuleSource('directives');
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      version: 2,
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmedAt: '2026-05-12T10:00:00Z',
    }));

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
  const directives = readHookModuleSource('directives');
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      version: 2,
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmedAt: '2026-05-12T10:00:00Z',
    }));

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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      version: 2,
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmedAt: '2026-05-08T13:00:00Z',
    }));

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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      version: 2,
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'supabase',
      realtime: 'none',
      mobile: { enabled: true, framework: 'react-native-expo', source: 'prompted' },
      technologies: { frontend: ['react-native', 'expo'], backend: ['supabase', 'postgres'], mobile: ['react-native', 'expo'] },
      confirmedAt: '2026-05-08T13:05:00Z',
    }));

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
    directives: readHookModuleSource('directives'),
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
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

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
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

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
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

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
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));
    const context = payload.hookSpecificOutput.additionalContext;

    assert.equal(state.stack, 'custom-frontend');
    assert.equal(state.frontend, 'nextjs');
    assert.match(context, /NextAuth\/Auth\.js/);
    assert.match(context, /nextjs-turbopack/);
    assert.doesNotMatch(context, /rules\/frontend\/react\/core\.md/);
  });
});

test('first-prompt classifier resolves stack, tech, and mobile prompt defaults', () => {
  const { classifyPromptForStack } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'detection', 'detection.cjs'));

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
  const { normalizeState } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
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
  const codexCache = path.join(path.sep, 'Users', 'dev', '.codex', 'plugins', 'cache', 'traffic-one-local', 'traffic-one', '2.9.67');
  const claudeCache = path.join(path.sep, 'Users', 'dev', '.claude', 'plugins', 'cache', 'traffic-one-local', 'traffic-one', '2.9.67');
  const sourceCheckout = path.join(path.sep, 'Users', 'dev', 'src', 'traffic-one');

  assert.equal(isManagedPluginCachePath(codexCache), true);
  assert.equal(isManagedPluginCachePath(claudeCache), true);
  assert.equal(isManagedPluginCachePath(sourceCheckout), false);
});

test('materializeProjectAssets copies only active local rules and skills', () => {
  const { materializeProjectAssets } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize', 'materialize.cjs'));
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
  const { materializeProjectAssets } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize', 'materialize.cjs'));
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
  const { materializeProjectAssets } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize', 'materialize.cjs'));
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
  const { materializeProjectAssets } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize', 'materialize.cjs'));
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
  const { materializeProjectAssets } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize', 'materialize.cjs'));
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
  const { initializeToolchainState } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      projectContext: completeDefaultState().projectContext,
      mobile: 'web-only',
      codeGraphProvider: 'gitnexus',
      performance: { level: 'high', source: 'prompted' },
      team: { mode: 'subagents', source: 'prompted', approved: true },
      onboardingComplete: true,
    });

    const result = runHook(cwd, 'materialize-project');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

    assert.match(context, /Project-local rules\/skills/);
    assert.equal(state.version, '2.9.67');
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

test('materialize-project upgrades compact v1 traffic-one state and writes local rules/skills', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), compactWebdevAcademyState());

    const result = runHook(cwd, 'materialize-project');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

    assert.match(context, /Project-local rules\/skills/);
    assert.equal(state.version, '2.9.67');
    assert.equal(state.project, undefined);
    assert.equal(state.mode, 'new-project');
    assert.equal(state.stack, 'default');
    assert.equal(state.frontend, 'react-vite');
    assert.equal(state.backend, 'supabase');
    assert.deepEqual(state.mobile, { enabled: false, framework: 'none', source: 'prompted' });
    assert.ok(Array.isArray(state.technologies.frontend));
    assert.equal(state.realtime, 'none');
    assert.equal(state.codeGraphProvider, 'gitnexus');
    assert.deepEqual(state.performance, { level: 'high', source: 'prompted' });
    assert.deepEqual(state.team, { mode: 'subagents', source: 'prompted', approved: true });
    assert.ok(state.toolchain.gitnexus);
    assert.equal(state.confirmed, true);
    assert.equal(state.onboardingComplete, true);
    assert.ok(state.confirmedAt);
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.equal(state.materializedVersion, '2.9.67');
    assert.ok(state.materializedAt);
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'rules', 'modes', 'new-project.md')));
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'skills', 'create-page', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'CLAUDE.md')));
  });
});

test('post-stack-setup upgrades compact state written directly to .traffic-one/.one.json', () => {
  withTempDir((cwd) => {
    const filePath = path.join(cwd, '.traffic-one/.one.json');
    writeJson(filePath, compactWebdevAcademyState());

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: { file_path: filePath },
    });
    const payload = parseStdoutJson(result);
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    assert.match(payload.hookSpecificOutput.additionalContext, /Project-local rules\/skills/);
    assert.equal(state.stack, 'default');
    assert.equal(state.codeGraphProvider, 'gitnexus');
    assert.deepEqual(state.performance, { level: 'high', source: 'prompted' });
    assert.deepEqual(state.team, { mode: 'subagents', source: 'prompted', approved: true });
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
  });
});

test('generic post-tool convergence upgrades compact traffic-one state', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), compactWebdevAcademyState());

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: { tool_name: 'future-host-patch-tool' },
    });
    const payload = parseStdoutJson(result);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

    assert.match(payload.hookSpecificOutput.additionalContext, /Project-local rules\/skills/);
    assert.equal(state.stack, 'default');
    assert.equal(state.codeGraphProvider, 'gitnexus');
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
  });
});

test('materialize-project canonicalizes mobile source aliases before validation', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      mobile: { enabled: false, framework: 'none', source: 'user-onboarding' },
      codeGraphProvider: 'graphify',
    }));

    const result = runHook(cwd, 'materialize-project');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

    assert.match(context, /Project-local rules\/skills/);
    assert.equal(state.mobile.source, 'prompted');
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
    assert.ok(fs.existsSync(path.join(cwd, '.traffic-one', 'manifest.json')));
  });
});

test('materialize-project canonicalizes team aliases before validation', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      team: { mode: 'run-team', source: 'user-onboarding', approved: true },
      codeGraphProvider: 'graphify',
    }));

    const result = runHook(cwd, 'materialize-project');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

    assert.match(context, /Project-local rules\/skills/);
    assert.equal(state.team.mode, 'subagents');
    assert.equal(state.team.source, 'prompted');
    assert.equal(state.materializedStack, 'default|react-vite|supabase|none');
  });
});

test('materialize-project warning names invalid mobile source instead of blaming stack', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Existing project note\n\nKeep this note.\n', 'utf8');

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: { tool_name: 'future-host-patch-tool' },
    });
    const payload = parseStdoutJson(result);
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));
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
    writeJson(path.join(target, '.traffic-one/.one.json'), completeDefaultState({
      codeGraphProvider: 'graphify',
      materializedStack: 'react-vite-supabase',
      materializedAt: new Date().toISOString(),
      materializedVersion: 'manual',
    }));
    writeJson(path.join(sibling, '.traffic-one/.one.json'), completeDefaultState({
      codeGraphProvider: 'graphify',
    }));

    const result = runHook(cwd, 'post-stack-setup', {
      tool_input: {
        cmd: 'mkdir -p tests/jobconnect/apps/web tests/jobconnect/packages',
      },
    });
    const payload = parseStdoutJson(result);
    const state = JSON.parse(fs.readFileSync(path.join(target, '.traffic-one/.one.json'), 'utf8'));

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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      ...completeDefaultState(),
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: '2026-05-13T10:00:00Z',
      materializedVersion: '2.9.67',
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      ...completeDefaultState(),
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: new Date().toISOString(),
      materializedVersion: '2.9.67',
      currentRunId: '2026-05-18T12-04-52Z',
      activeAgentRole: 'senior-frontend',
      spawnIndex: { 'senior-frontend': 1 },
    });

    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

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
  const { initializeToolchainState } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), { stack: 'react-frontend-only' });

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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), { stack: 'react-frontend-only' });

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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), { stack: 'react-realtime-monorepo' });

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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), { stack: 'react-realtime-monorepo' });

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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), { stack: 'react-native-expo-monorepo' });

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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), { stack: 'react-realtime-monorepo' });

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

    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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

};
