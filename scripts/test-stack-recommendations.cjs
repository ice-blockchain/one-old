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
const { STACKS } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks.cjs'));
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
      stack: 'minimal',
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
  withTempDir((cwd) => {
    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;

    assert.equal(defaultBackendValue(), 'supabase');
    assert.match(context, /backend=supabase/);
    assert.match(context, /Supabase \(managed Postgres with Auth, Storage, Realtime, and RLS\)/);
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
  assert.match(promptTemplates, /run `auto-documentation-generator` after the plan even\s+when the user did not ask for docs/);
  assert.match(agentsMirror, /auto-documentation is mandatory/);
  assert.match(claude, /@rules\/common\/documentation\.md/);
  assert.match(cursorDocumentation, /For `mode: new-project`, this is mandatory/);
  assert.match(cursorNewProject, /Mandatory auto-documentation baseline/);
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
  assert.match(documentationRules, /If a canonical doc does not\s+exist, create it/);
  assert.match(documentationRules, /If it already exists, update it in\s+place/);
  assert.match(existingRule, /Before normal feature work/);
  assert.match(existingRule, /If a canonical doc does not exist, create it/);
  assert.match(existingRule, /If a canonical doc already exists, update it in place/);
  assert.match(directives, /create missing canonical docs and update existing docs in place/);
  assert.match(architect, /every `mode: existing-codebase` \/ `existing-with-supabase`/);
  assert.match(reviewer, /Existing projects have had the same docs baseline reconciled/);
  assert.match(autoDocs, /In existing projects, reconcile the docs baseline/);
  assert.match(promptTemplates, /existing-with-supabase`, run it before normal feature work/);
  assert.match(agentsMirror, /if a canonical doc does not exist, create it/);
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
    assert.match(context, /create missing canonical docs and update existing docs in place/);
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
    assert.equal(state.stack, 'react-native-expo-app');
    assert.match(context, /rules\/common\/documentation\.md/);
    assert.match(context, /create missing canonical docs and update existing docs in place/);
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
    assert.equal(state.stack, 'minimal');
    assert.match(context, /go\.mod detected/);
    assert.match(context, /rules\/common\/documentation\.md/);
    assert.match(context, /create missing canonical docs and update existing docs in place/);
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
    assert.match(context, /create missing canonical docs and update existing docs in place/);
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

    assert.equal(state.stack, 'minimal');
    assert.equal(state.frontend, 'nextjs');
    assert.match(context, /NextAuth\/Auth\.js/);
    assert.match(context, /date-fns/);
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

test('plan-gate allows docs/ on new-project without plan', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one.json'), {
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
    });

    const result = runHook(cwd, 'check-architecture-write', {
      tool_input: {
        file_path: 'docs/architecture.md',
        content: '# Architecture\n',
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
    assert.match(result.stdout, /\[graphify\]/);
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
