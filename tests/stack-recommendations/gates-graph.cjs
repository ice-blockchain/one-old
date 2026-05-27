'use strict';

module.exports = function registerGatesGraphTests(ctx) {
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
    assert.match(result.stdout, /\.traffic-one\/\.one\.json/);
  });
});

test('plan-gate allows feature write when plan exists', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      performance: { level: 'low', source: 'prompted' },
      team: { mode: 'main-agent', source: 'prompted' },
    }));
    runHook(cwd, 'materialize-project');
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      ...completeDefaultState({
        materializedStack: 'default|react-vite|supabase|none',
        materializedAt: '2026-05-13T10:00:00Z',
        materializedVersion: '2.9.70',
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());
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
    assert.match(result.stdout, /feature-source writes via shell command/);
  });
});

test('run-team enforcement allows active frontend role feature writes', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(projectDir, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), { stack: 'react-realtime-monorepo' });

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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      stack: 'react-realtime-monorepo',
    });
    const fingerprint = computeProjectFingerprint(cwd).fingerprint;
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      stack: 'react-realtime-monorepo',
    });
    const fingerprint = computeProjectFingerprint(cwd).fingerprint;
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      stack: 'react-realtime-monorepo',
      mode: 'new-project',
      onboardingComplete: true,
      codeGraphProvider: 'graphify',
      // Force the manual-hint path without attempting pip install in CI.
      // graphifyy (the PyPI package) may be installable in some environments,
      // which causes bootstrap to succeed and skips the hint we're testing.
      graphifyAutoRun: false,
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      version: 2,
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmedAt: '2026-05-07T14:00:00Z',
    }));

    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const ctx = sessionContextWithMaterializedRules(cwd, payload);

    assert.match(ctx, /codebase-graph\.md/);
    assert.match(ctx, /agent-handoff-digests\.md/);
  });
});

test('SessionStart bundle includes deployment artifact defaults', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      version: 2,
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      confirmedAt: '2026-05-07T14:00:00Z',
    }));

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
  const skillFilters = readHookModuleSource('skill-filters');
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
  const skillFilters = readHookModuleSource('skill-filters');
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
  const skillFilters = readHookModuleSource('skill-filters');

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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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

test('writeState stamps plugin version in .traffic-one/.one.json version field', () => {
  const { writeState, getPluginVersion } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
  withTempDir((cwd) => {
    writeState(cwd, { stack: 'react-realtime-monorepo', mode: 'new-project' });
    const state = readProjectState(cwd);
    const effective = readEffectiveState(cwd);
    const pluginVersion = getPluginVersion();
    // The plugin version helper reads from the plugin manifest.
    assert.match(pluginVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(state.version, pluginVersion);
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'pluginVersion'), false);
    assert.equal(state.stack, 'default');
    assert.ok(effective.toolchain.gitnexus);
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
      writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
      writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), { stack: 'react-realtime-monorepo' });
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), { stack: 'react-realtime-monorepo' });
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

  assert.match(templates, /Before emitting PLAN_READY, verify project-local context is materialized/);
  assert.match(templates, /\.traffic-one\/manifest\.json/);
  assert.match(templates, /materialize-project/);
  assert.match(templates, /Do not write `materializedStack`/);
});

// ── codeGraphProvider onboarding question + state-shape enforcement ────────

test('onboarding directive contains the codeGraphProvider question with gitnexus listed first', () => {
  const { onboardingDirectiveNewProject } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'directives', 'directives.cjs'));
  const directive = onboardingDirectiveNewProject();
  // The question must exist as a required onboarding field.
  assert.match(directive, /codeGraphProvider/);
  assert.match(directive, /REQUIRED/i);
  assert.match(directive, /request_user_input/);
  assert.match(directive, /Code Graph/);
  assert.match(directive, /Which provider should we use for the codebase graph\?/);
  assert.match(directive, /Do NOT print "Options:"/);
  assert.match(directive, /ask in (?:plain )?chat with (?:the )?numbered options.*stop/);
  // gitnexus listed first (per user instruction; no "Recommended" tag).
  const gIdx = directive.indexOf('gitnexus');
  const fIdx = directive.indexOf('graphify');
  assert.ok(gIdx >= 0 && fIdx >= 0, 'both providers must appear in directive');
  assert.ok(gIdx < fIdx, 'gitnexus must be listed before graphify');
  // Explicit no-default + no-skip framing.
  assert.match(directive.replace(/\s+/g, ' '), /no skip|do not (?:default|skip|silently)/i);
});

test('onboarding directive surfaces the PolyForm Noncommercial license for gitnexus', () => {
  const { onboardingDirectiveNewProject } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'directives', 'directives.cjs'));
  const directive = onboardingDirectiveNewProject();
  assert.match(directive, /PolyForm Noncommercial/);
  // graphify license also mentioned so the user can compare.
  assert.match(directive, /MIT/);
});

test('runPostStackSetup warns when codeGraphProvider is missing', () => {
  withTempDir((cwd) => {
    const filePath = path.join(cwd, '.traffic-one/.one.json');
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

test('runPostStackSetup treats unknown local codeGraphProvider as missing', () => {
  withTempDir((cwd) => {
    const filePath = path.join(cwd, '.traffic-one/.one.json');
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
    assert.match(parsed.systemMessage, /missing required `codeGraphProvider`/);
    assert.doesNotMatch(parsed.systemMessage, /bogus-provider/);
  });
});

test('post-build-graphify dispatches to the gitnexus runner when codeGraphProvider is "gitnexus"', () => {
  // We can't easily run the real gitnexus runner from the test (it would
  // probe `which gitnexus` and try to install). Instead, assert the dispatch
  // surface: with `codeGraphProvider: "gitnexus"` and no fresh `.gitnexus/`,
  // the hook must produce a gitnexus-flavoured banner (license reminder /
  // npm install hint), not the graphify one.
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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

test('runPostStackSetup does NOT auto-write .nvmrc from local gitnexus preference', () => {
  withTempDir((cwd) => {
    const filePath = path.join(cwd, '.traffic-one/.one.json');
    writeJson(filePath, completeDefaultState({
      stack: 'react-realtime-monorepo',
      codeGraphProvider: 'gitnexus',
      confirmedAt: '2026-05-12T00:00:00Z',
    }));
    // Sanity: .nvmrc does not exist yet.
    assert.equal(fs.existsSync(path.join(cwd, '.nvmrc')), false);

    runHook(cwd, 'post-stack-setup', { tool_input: { file_path: filePath } });

    const nvmrcPath = path.join(cwd, '.nvmrc');
    assert.equal(fs.existsSync(nvmrcPath), false, '.nvmrc must stay project-owned');
  });
});

test('runPostStackSetup does NOT clobber an existing .nvmrc on gitnexus setup', () => {
  withTempDir((cwd) => {
    const filePath = path.join(cwd, '.traffic-one/.one.json');
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
    const filePath = path.join(cwd, '.traffic-one/.one.json');
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
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
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

    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState({
      codeGraphProvider: 'graphify',
    }));
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

};
