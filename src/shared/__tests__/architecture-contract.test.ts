import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  architectureInputPath,
  compileArchitecture,
  compileArchitectureForRun,
  compiledArchitecturePath,
  createWorkUnitContract,
  ensureArchitectureRunSnapshot,
  publishRuntimeAssignments,
  readArchitectureRunBaseline,
  legacyCustomBackendMigration,
  readArchitectureRunSnapshot,
  readCompiledArchitecture,
  readRuntimeAssignments,
  runtimeAssignmentsPath,
  stableContractJson,
  validateArchitectureInput,
  type ArchitectureInputV1,
} from '../architecture-contract';
import { sha256 } from '../text';
import {
  compileVerificationContract,
  verificationContractPath,
} from '../verification-contract';
import { activateRunV2RollbackBarrier } from '../run-settlement';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-architecture-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

const REACT_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

const INPUT: ArchitectureInputV1 = {
  schemaVersion: 1,
  routes: [
    { id: 'home-route', path: '/', moduleId: 'home' },
    { id: 'news-route', path: '/news', moduleId: 'news' },
  ],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' },
    { id: 'home', name: 'Home', kind: 'page' },
    { id: 'news', name: 'News', kind: 'page' },
  ],
};

test('architecture input is semantic and cannot choose roots or output paths', () => {
  assert.equal(validateArchitectureInput(INPUT).ok, true);
  const invalid = {
    ...INPUT,
    modules: [{ id: 'home', name: 'Home', kind: 'page', output: '/tmp/Home.tsx' }],
  };
  const validation = validateArchitectureInput(invalid);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes('may not choose output paths')));
});

test('architecture input rejects unknown fields at every semantic schema level', () => {
  const validation = validateArchitectureInput({
    ...INPUT,
    profile: 'vite-react',
    sourceRoots: ['attacker-owned'],
    modules: [{
      ...INPUT.modules[0],
      customPolicy: 'allow-anywhere',
    }],
    routes: [{
      ...INPUT.routes[0],
      output: 'src/attacker.tsx',
    }],
    exceptions: [{
      ruleId: 'STRUCT_COMPONENTS_PER_FILE',
      glob: 'packages/ui/src/Accordion*.tsx',
      reason: 'Compound component family needs colocated primitives.',
      disableAll: true,
    }],
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes('input has unsupported field profile'));
  assert.ok(validation.errors.includes('input has unsupported field sourceRoots'));
  assert.ok(validation.errors.includes('modules[0] has unsupported field customPolicy'));
  assert.ok(validation.errors.includes('routes[0] has unsupported field output'));
  assert.ok(validation.errors.includes('exceptions[0] has unsupported field disableAll'));

  const wrongOptionalTypes = validateArchitectureInput({
    ...INPUT,
    exceptions: {},
    routes: [{ ...INPUT.routes[0], redirect: 'yes' }],
  });
  assert.equal(wrongOptionalTypes.ok, false);
  assert.ok(wrongOptionalTypes.errors.includes('exceptions must be an array when provided'));
  assert.ok(wrongOptionalTypes.errors.includes('routes[0].redirect must be a boolean when provided'));
});

test('non-Git immutable baseline rejects symbolic links instead of omitting them', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'outside.ts'), 'export const value = 1;\n');
    fs.symlinkSync(path.join(cwd, 'outside.ts'), path.join(cwd, 'src/linked.ts'));
    assert.throws(
      () => compileArchitecture(cwd, 'R', REACT_STATE, INPUT),
      /baseline cannot include symbolic link src\/linked\.ts/,
    );
  });
});

test('non-Git immutable baseline records only the canonical Traffic One CLAUDE.md alias', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Project agents\n');
    fs.symlinkSync('AGENTS.md', path.join(cwd, 'CLAUDE.md'));

    const snapshot = ensureArchitectureRunSnapshot(cwd, 'R', REACT_STATE);
    const baseline = readArchitectureRunBaseline(cwd, 'R')?.baseline;
    assert.equal(snapshot.profile.profileId, 'vite-react');
    assert.equal(baseline?.kind, 'file-manifest');
    assert.ok(baseline?.files?.some((entry) => entry.path === 'AGENTS.md'));
    assert.ok(baseline?.files?.some((entry) => entry.path === 'CLAUDE.md'));
  });

  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Project agents\n');
    fs.writeFileSync(path.join(cwd, 'OTHER.md'), '# Other\n');
    fs.symlinkSync('OTHER.md', path.join(cwd, 'CLAUDE.md'));
    assert.throws(
      () => ensureArchitectureRunSnapshot(cwd, 'R', REACT_STATE),
      /baseline cannot include symbolic link CLAUDE\.md/,
    );
  });
});

test('runtime compiles React outputs and hashes the immutable baseline', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'apps/web/src/pages'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'apps/web/src/components'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'apps/web/src/features'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'apps/web/src/lib'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, INPUT);
    assert.equal(compiled.profile.profileId, 'vite-react');
    assert.equal(compiled.modules.find((module) => module.id === 'home')?.output, 'apps/web/src/pages/Home.tsx');
    assert.equal(compiled.modules.find((module) => module.id === 'app-shell')?.output, 'apps/web/src/App.tsx');
    assert.match(compiled.baseline.identity, /^(?:git|files):/);
    assert.match(compiled.inputHash, /^[a-f0-9]{64}$/);
    assert.match(compiled.contractHash, /^[a-f0-9]{64}$/);
  });
});

test('run-start capability and non-Git baseline stay immutable before architect output', () => {
  withProject((cwd) => {
    const state = {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'python',
      mobile: { framework: 'none' },
    };
    fs.writeFileSync(path.join(cwd, 'seed.py'), 'print("baseline")\n');
    const snapshot = ensureArchitectureRunSnapshot(cwd, 'R', state);
    const frozenBaseline = readArchitectureRunBaseline(cwd, 'R');
    assert.equal(snapshot.profile.profileId, 'backend-only');
    assert.equal(frozenBaseline?.baseline.kind, 'file-manifest');
    assert.ok(frozenBaseline?.baseline.files?.some((entry) => entry.path === 'seed.py'));
    assert.ok(fs.statSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'capability-v1.json')).size < 20_000);

    // These markers would normally detect Next, but they were created after the
    // run snapshot and may not steer the compiled profile or baseline.
    fs.mkdirSync(path.join(cwd, 'app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    const input: ArchitectureInputV1 = {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'sync-service', name: 'Sync Service', kind: 'service' }],
    };
    const inputPath = path.join(cwd, '.traffic-one', 'runs', 'R', 'architecture-input-v1.json');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify(input));

    const compiled = compileArchitectureForRun(cwd, 'R', state);
    assert.equal(compiled.profile.profileId, 'backend-only');
    assert.equal(compiled.baseline.identity, snapshot.baselineIdentity);
    assert.ok(!compiled.baseline.files?.some((entry) => entry.path === 'package.json'));
    assert.equal(readArchitectureRunSnapshot(cwd, 'R')?.snapshotHash, snapshot.snapshotHash);
  });
});

test('pre-existing compiled sidecars cannot steer the runtime-owned run snapshot', () => {
  withProject((cwd) => {
    const injected = compileArchitecture(cwd, 'R', REACT_STATE, INPUT);
    const compiledPath = compiledArchitecturePath(cwd, 'R');
    fs.mkdirSync(path.dirname(compiledPath), { recursive: true });
    fs.writeFileSync(compiledPath, JSON.stringify(injected));

    const backendState = {
      mode: 'existing-codebase',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
    };
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
    const snapshot = ensureArchitectureRunSnapshot(cwd, 'R', backendState);
    assert.equal(snapshot.profile.profileId, 'backend-only');
    assert.equal(snapshot.profile.backendFramework, 'go');
    assert.notEqual(snapshot.profile.profileId, injected.profile.profileId);
    assert.equal(readCompiledArchitecture(cwd, 'R')?.contractHash, injected.contractHash);
  });
});

test('module roots are selected from the immutable baseline, not directories added mid-run', () => {
  withProject((cwd) => {
    const state = {
      mode: 'existing-codebase',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
    };
    fs.mkdirSync(path.join(cwd, 'cmd/server'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'cmd/server/main.go'), 'package main\n');
    ensureArchitectureRunSnapshot(cwd, 'R', state);

    fs.mkdirSync(path.join(cwd, 'internal'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'internal/steer.go'), 'package internal\n');
    const inputPath = architectureInputPath(cwd, 'R');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify({
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'sync-service', name: 'Sync Service', kind: 'service' }],
    }));

    const compiled = compileArchitectureForRun(cwd, 'R', state);
    assert.equal(compiled.modules[0]?.output, 'cmd/sync_service.go');
    assert.ok(!compiled.modules[0]?.output.startsWith('internal/'));
  });
});

test('backend-only profiles reject semantic UI modules instead of assigning a frontend role', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
    assert.throws(() => compileArchitecture(cwd, 'R', {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
    }, INPUT), /has no UI surface/);
  });
});

test('runtime compiles framework-native page conventions for Next App, Nuxt, and Laravel Blade', () => {
  for (const fixture of [
    {
      deps: { next: '16.0.0', react: '19.0.0' },
      dirs: ['app'],
      state: { ...REACT_STATE, frontend: 'nextjs' },
      expected: 'app/news/page.tsx',
    },
    {
      deps: { nuxt: '4.0.0', vue: '3.0.0' },
      dirs: ['pages'],
      state: { ...REACT_STATE, frontend: 'nuxt' },
      expected: 'pages/news.vue',
    },
  ]) {
    withProject((cwd) => {
      for (const dir of fixture.dirs) fs.mkdirSync(path.join(cwd, dir), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: fixture.deps }));
      const compiled = compileArchitecture(cwd, 'R', fixture.state, INPUT);
      assert.equal(compiled.modules.find((module) => module.id === 'news')?.output, fixture.expected);
    });
  }

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'resources/views'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'resources/views/dashboard.blade.php'), '<h1>Dashboard</h1>\n');
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
    }));
    const compiled = compileArchitecture(cwd, 'R', {
      ...REACT_STATE,
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'laravel',
    }, INPUT);
    assert.equal(compiled.profile.profileId, 'server-rendered');
    assert.equal(compiled.modules.find((module) => module.id === 'app-shell')?.output, 'resources/views/layouts/app.blade.php');
    assert.equal(compiled.modules.find((module) => module.id === 'news')?.output, 'resources/views/news.blade.php');
  });
});

test('runtime compiles custom workspace roots with framework-correct module extensions and routers', () => {
  const fixtures = [
    {
      root: 'packages/dashboard',
      deps: { next: '16.0.0', react: '19.0.0' },
      dirs: ['app'],
      profileId: 'next-app',
      router: 'next-app-router',
      appShell: 'packages/dashboard/app/layout.tsx',
      page: 'packages/dashboard/app/news/page.tsx',
    },
    {
      root: 'packages/portal',
      deps: { vue: '3.5.0', vite: '7.0.0' },
      dirs: ['src/pages', 'src/components'],
      profileId: 'vue',
      router: 'vue-router',
      appShell: 'packages/portal/src/App.vue',
      page: 'packages/portal/src/pages/News.vue',
    },
    {
      root: 'apps/site',
      deps: { '@sveltejs/kit': '2.0.0', svelte: '5.0.0' },
      dirs: ['src/routes', 'src/lib/components'],
      profileId: 'sveltekit',
      router: 'sveltekit-file-router',
      appShell: 'apps/site/src/routes/+layout.svelte',
      page: 'apps/site/src/routes/news/+page.svelte',
    },
    {
      root: 'frontend',
      deps: { svelte: '5.0.0', vite: '7.0.0' },
      dirs: ['src/pages', 'src/components'],
      profileId: 'svelte',
      router: 'svelte-router',
      appShell: 'frontend/src/App.svelte',
      page: 'frontend/src/pages/News.svelte',
    },
    {
      root: 'packages/marketing',
      deps: { astro: '5.0.0' },
      dirs: ['src/pages', 'src/components'],
      profileId: 'astro',
      router: 'astro-file-router',
      appShell: 'packages/marketing/src/layouts/Layout.astro',
      page: 'packages/marketing/src/pages/news.astro',
    },
    {
      root: 'client',
      deps: { '@angular/core': '20.0.0', '@angular/cli': '20.0.0' },
      dirs: ['src/app/pages', 'src/app/components'],
      profileId: 'angular',
      router: 'angular-router',
      appShell: 'client/src/app/app.component.ts',
      page: 'client/src/app/pages/news/news.component.ts',
    },
  ] as const;

  for (const fixture of fixtures) {
    withProject((cwd) => {
      for (const dir of fixture.dirs) {
        fs.mkdirSync(path.join(cwd, fixture.root, dir), { recursive: true });
      }
      fs.writeFileSync(
        path.join(cwd, fixture.root, 'package.json'),
        JSON.stringify({ dependencies: fixture.deps }),
      );
      const compiled = compileArchitecture(cwd, 'R', {
        mode: 'existing-codebase',
        stack: 'custom-frontend',
        frontend: 'none',
        backend: 'none',
        mobile: { framework: 'none' },
      }, INPUT);
      assert.equal(compiled.profile.profileId, fixture.profileId, fixture.root);
      assert.equal(compiled.profile.router, fixture.router, fixture.root);
      assert.equal(
        compiled.modules.find((module) => module.id === 'app-shell')?.output,
        fixture.appShell,
        fixture.root,
      );
      assert.equal(
        compiled.modules.find((module) => module.id === 'news')?.output,
        fixture.page,
        fixture.root,
      );
    });
  }
});

test('hybrid UI architecture compilation is blocked without a runtime/user-owned target', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'packages/dashboard/app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'packages/dashboard/package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { expo: '55.0.0', react: '19.0.0', 'react-native': '0.83.0' },
    }));
    const state = {
      mode: 'existing-codebase',
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { framework: 'react-native-expo' },
    };
    assert.throws(
      () => compileArchitecture(cwd, 'R', state, INPUT),
      /CAPABILITY_HYBRID_UI_TARGET_REQUIRED.*Both web-ui and native-ui were detected/,
    );

    const selected = compileArchitecture(cwd, 'R', {
      ...state,
      architectureTarget: 'web-ui',
    }, INPUT);
    assert.equal(selected.profile.profileId, 'next-app');
    assert.equal(selected.profile.architectureTarget, 'web-ui');
    assert.equal(selected.modules.find((module) => module.id === 'news')?.output,
      'packages/dashboard/app/news/page.tsx');
  });
});

test('Laravel UI routes compile routes/web.php into the page-owner assignment even in maintenance', () => {
  withProject((cwd) => {
    const state = {
      ...REACT_STATE,
      mode: 'existing-codebase',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'laravel',
    };
    fs.mkdirSync(path.join(cwd, 'resources/views'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'resources/views/dashboard.blade.php'), '<h1>Dashboard</h1>\n');
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
    }));
    const inputPath = architectureInputPath(cwd, 'R');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify(INPUT));

    const architecture = compileArchitectureForRun(cwd, 'R', state);
    const routeOutput = architecture.scaffoldOutputs?.find((output) => (
      output.path === 'routes/web.php'
    ));
    assert.deepEqual(routeOutput, {
      path: 'routes/web.php',
      ownerRole: 'senior-frontend',
      kind: 'scaffold',
    });
    assert.ok(architecture.allowedOutputs.includes('routes/web.php'));

    const verification = compileVerificationContract(cwd, 'R', state, architecture, {
      changedPaths: [],
    });
    const assignments = publishRuntimeAssignments(cwd, architecture, verification.contractHash);
    assert.ok(assignments.assignments
      .find((assignment) => assignment.role === 'senior-frontend')
      ?.scope.include.includes('routes/web.php'));
    assert.equal(Boolean(assignments.assignments
      .find((assignment) => assignment.role === 'senior-backend')
      ?.scope.include.includes('routes/web.php')), false);
  });
});

test('runtime compiles workspace Next, Nuxt srcDir, and Laravel Inertia outputs', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'apps/web/app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    const compiled = compileArchitecture(cwd, 'R', {
      ...REACT_STATE,
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
    }, INPUT);
    assert.equal(compiled.profile.profileId, 'next-app');
    assert.equal(compiled.modules.find((module) => module.id === 'app-shell')?.output, 'apps/web/app/layout.tsx');
    assert.equal(compiled.modules.find((module) => module.id === 'news')?.output, 'apps/web/app/news/page.tsx');
  });

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'apps/web/ui/app/pages'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
      dependencies: { nuxt: '4.0.0', vue: '3.0.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'apps/web/nuxt.config.ts'), "export default defineNuxtConfig({ srcDir: './ui' });\n");
    const compiled = compileArchitecture(cwd, 'R', {
      ...REACT_STATE,
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
    }, INPUT);
    assert.equal(compiled.profile.profileId, 'nuxt');
    assert.equal(compiled.modules.find((module) => module.id === 'app-shell')?.output, 'apps/web/ui/app/app.vue');
    assert.equal(compiled.modules.find((module) => module.id === 'news')?.output, 'apps/web/ui/app/pages/news.vue');
  });

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'resources/js/Pages'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'resources/js/app.tsx'), 'export {};\n');
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: {
        'laravel/framework': '^12.0',
        'inertiajs/inertia-laravel': '^2.0',
      },
    }));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { '@inertiajs/react': '^2.0', react: '^19.0' },
    }));
    const compiled = compileArchitecture(cwd, 'R', {
      ...REACT_STATE,
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'laravel',
    }, INPUT);
    assert.equal(compiled.profile.router, 'inertia-react-router');
    assert.equal(compiled.modules.find((module) => module.id === 'app-shell')?.output, 'resources/js/app.tsx');
    assert.equal(compiled.modules.find((module) => module.id === 'news')?.output, 'resources/js/Pages/News.tsx');
  });
});

test('legacy custom-backend + react-vite migration is framework-aware and fails closed on lifecycle uncertainty', () => {
  withProject((cwd) => {
    const legacy = { stack: 'custom-backend', frontend: 'react-vite', backend: 'other' };
    const clean = legacyCustomBackendMigration(cwd, legacy);
    assert.equal(clean.changed, true);
    assert.equal(clean.state.frontend, 'none');

    const runDir = path.join(cwd, '.traffic-one', 'runs', 'active-run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId: 'active-run',
      status: 'active',
    }));
    const active = legacyCustomBackendMigration(cwd, { ...legacy, currentRunId: 'active-run' });
    assert.equal(active.changed, false);
    assert.equal(active.ambiguous, true);
    assert.match(active.message || '', /forbidden mid-run/);

    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'App.tsx'), 'export const App = () => <div />;\n');
    const ambiguous = legacyCustomBackendMigration(cwd, legacy);
    assert.equal(ambiguous.changed, false);
    assert.equal(ambiguous.ambiguous, true);
  });
});

test('legacy migration cannot treat the V2 barrier intermediate projection as terminal', () => {
  withProject((cwd) => {
    const runId = 'barrier-intermediate';
    const runDir = path.join(cwd, '.traffic-one', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId,
      status: 'active',
      kind: 'orchestration',
    }));
    assert.ok(activateRunV2RollbackBarrier(cwd, runId));
    assert.equal(fs.existsSync(path.join(runDir, 'verification-v2.json')), false);
    assert.equal(fs.existsSync(path.join(runDir, 'settlement-v2.json')), false);

    const migration = legacyCustomBackendMigration(cwd, {
      stack: 'custom-backend',
      frontend: 'react-vite',
      backend: 'other',
      currentRunId: runId,
    });
    assert.equal(migration.changed, false);
    assert.equal(migration.ambiguous, true);
    assert.match(migration.message || '', /current run is active; migration is forbidden mid-run/);
  });
});

test('legacy migration treats generic framework-less UI roots as ambiguous frontend evidence', () => {
  for (const artifact of [
    'app/page.tsx',
    'pages/index.tsx',
    'app/Home.tsx',
    'pages/index.html',
  ]) {
    withProject((cwd) => {
      fs.mkdirSync(path.dirname(path.join(cwd, artifact)), { recursive: true });
      fs.writeFileSync(path.join(cwd, artifact), '<main>UI</main>\n');
      const migration = legacyCustomBackendMigration(cwd, {
        stack: 'custom-backend',
        frontend: 'react-vite',
        backend: 'other',
      });
      assert.equal(migration.changed, false, artifact);
      assert.equal(migration.ambiguous, true, artifact);
      assert.match(migration.message || '', /frontend evidence exists/, artifact);
    });
  }
});

test('legacy Laravel API-only scaffolding migrates, while real UI and corrupt lifecycle evidence do not', () => {
  withProject((cwd) => {
    const legacy = {
      stack: 'custom-backend',
      frontend: 'react-vite',
      backend: 'laravel',
      mobile: { framework: 'none' },
    };
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
      requireDev: {},
    }));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      devDependencies: {
        vite: '^7.0.0',
        'laravel-vite-plugin': '^2.0.0',
      },
    }));
    fs.mkdirSync(path.join(cwd, 'app/Http/Controllers'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'resources/views'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'resources/js'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'resources/views/welcome.blade.php'), '<h1>Laravel</h1>\n');
    fs.writeFileSync(path.join(cwd, 'resources/js/bootstrap.js'), 'import axios from "axios";\n');
    fs.writeFileSync(path.join(cwd, 'resources/js/app.js'), "import './bootstrap';\n");

    const apiOnly = legacyCustomBackendMigration(cwd, legacy);
    assert.equal(apiOnly.changed, true);
    assert.equal(apiOnly.state.frontend, 'none');

    fs.writeFileSync(path.join(cwd, 'resources/views/dashboard.blade.php'), '<h1>Dashboard</h1>\n');
    const blade = legacyCustomBackendMigration(cwd, legacy);
    assert.equal(blade.changed, false);
    assert.equal(blade.ambiguous, true);
    fs.rmSync(path.join(cwd, 'resources/views/dashboard.blade.php'));

    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { '@inertiajs/react': '^2.0.0', react: '^19.0.0' },
      devDependencies: { vite: '^7.0.0', 'laravel-vite-plugin': '^2.0.0' },
    }));
    const inertia = legacyCustomBackendMigration(cwd, legacy);
    assert.equal(inertia.changed, false);
    assert.equal(inertia.ambiguous, true);

    const corruptRunDir = path.join(cwd, '.traffic-one', 'runs', 'corrupt-run');
    fs.mkdirSync(corruptRunDir, { recursive: true });
    fs.writeFileSync(path.join(corruptRunDir, 'run.json'), '{not-json');
    const corrupt = legacyCustomBackendMigration(cwd, {
      ...legacy,
      currentRunId: 'corrupt-run',
    });
    assert.equal(corrupt.changed, false);
    assert.equal(corrupt.ambiguous, true);
    assert.match(corrupt.message || '', /missing or corrupt/);

    const invalidRunDir = path.join(cwd, '.traffic-one', 'runs', 'invalid-settlement');
    fs.mkdirSync(invalidRunDir, { recursive: true });
    const semanticallyInvalid = {
      schemaVersion: 2,
      runId: 'invalid-settlement',
      runtimeVersion: '1.0.20',
      minimumRuntimeVersion: '1.0.20',
      status: 'verified',
      activeClaims: 1,
      incompleteChecks: [],
      revision: 1,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(invalidRunDir, 'settlement-v2.json'), JSON.stringify({
      ...semanticallyInvalid,
      settlementHash: sha256(stableContractJson(semanticallyInvalid)),
    }));
    const invalid = legacyCustomBackendMigration(cwd, {
      ...legacy,
      currentRunId: 'invalid-settlement',
    });
    assert.equal(invalid.changed, false);
    assert.equal(invalid.ambiguous, true);
    assert.match(invalid.message || '', /missing or corrupt/);
  });
});

test('work-unit contract requires a role and preflights every output against its allowlist', () => {
  assert.throws(() => createWorkUnitContract({
    runId: 'R',
    unitId: 'web',
    trafficOneRole: '',
    hostAgentType: null,
    rules: [],
    skills: [],
    outputs: ['apps/web/src/pages/Home.tsx'],
    allowlist: ['apps/web/**'],
    allowlistExclude: [],
    architectureHash: 'a',
    verificationHash: 'v',
  }), /trafficOneRole/);
  assert.throws(() => createWorkUnitContract({
    runId: 'R',
    unitId: 'web',
    trafficOneRole: 'senior-frontend',
    hostAgentType: null,
    rules: [],
    skills: [],
    outputs: ['tests/home.test.ts'],
    allowlist: ['apps/web/**'],
    allowlistExclude: [],
    architectureHash: 'a',
    verificationHash: 'v',
  }), /allowlist does not cover/);
  const valid = createWorkUnitContract({
    runId: 'R',
    unitId: 'web',
    trafficOneRole: 'senior-frontend',
    hostAgentType: null,
    rules: [{ id: 'frontend/components', contentHash: 'r' }],
    skills: [{ id: 'create-page', contentHash: 's' }],
    outputs: ['apps/web/src/pages/Home.tsx', 'tests/home.test.ts'],
    allowlist: ['apps/web/**', 'tests/**'],
    allowlistExclude: [],
    architectureHash: 'a',
    verificationHash: 'v',
  });
  assert.match(valid.contractHash, /^[a-f0-9]{64}$/);
});

test('runtime assignments contain only exact compiled outputs and bind the verification sidecar', () => {
  withProject((cwd) => {
    const inputPath = architectureInputPath(cwd, 'R');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify(INPUT));
    const architecture = compileArchitectureForRun(cwd, 'R', REACT_STATE);
    const verification = compileVerificationContract(cwd, 'R', REACT_STATE, architecture, {
      changedPaths: [],
    });
    const published = publishRuntimeAssignments(cwd, architecture, verification.contractHash);

    const frontend = published.assignments.find((entry) => entry.role === 'senior-frontend');
    const tester = published.assignments.find((entry) => entry.role === 'senior-tester');
    assert.ok(frontend);
    assert.ok(tester);
    assert.ok(frontend.scope.include.includes('apps/web/src/pages/Home.tsx'));
    assert.ok(frontend.scope.include.includes('apps/web/package.json'));
    assert.ok(tester.scope.include.includes('tests/home.test.ts'));
    assert.ok(tester.scope.include.includes('playwright.config.ts'));
    assert.ok(published.assignments.every((entry) => (
      entry.scope.exclude.length === 0
      && entry.scope.include.every((output) => !output.includes('*'))
    )));
    assert.equal(readRuntimeAssignments(cwd, 'R')?.assignmentsHash, published.assignmentsHash);

    const assignmentsPath = runtimeAssignmentsPath(cwd, 'R');
    const widened = JSON.parse(fs.readFileSync(assignmentsPath, 'utf8')) as Record<string, unknown>;
    const rows = widened.assignments as Array<Record<string, unknown>>;
    const firstScope = rows[0]?.scope as Record<string, unknown>;
    firstScope.include = [...(firstScope.include as string[]), 'src/**'];
    const { assignmentsHash: _observed, ...canonical } = widened;
    widened.assignmentsHash = sha256(stableContractJson(canonical));
    fs.writeFileSync(assignmentsPath, JSON.stringify(widened));
    assert.equal(readRuntimeAssignments(cwd, 'R'), null,
      'a self-rehashed widened manifest must not replace deterministic runtime assignments');

    fs.writeFileSync(assignmentsPath, JSON.stringify(published));

    const verificationPath = verificationContractPath(cwd, 'R');
    const tampered = JSON.parse(fs.readFileSync(verificationPath, 'utf8')) as Record<string, unknown>;
    tampered.changedPaths = [];
    fs.writeFileSync(verificationPath, JSON.stringify(tampered));
    assert.equal(readRuntimeAssignments(cwd, 'R'), null);
  });
});

test('backend-only scaffolds stay stack-native and existing-codebase skips scaffold/config outputs', () => {
  const semanticService: ArchitectureInputV1 = {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'sync-service', name: 'Sync Service', kind: 'service' }],
  };
  for (const fixture of [
    { backend: 'go', expected: ['go.mod', 'go.sum'] },
    { backend: 'python', expected: ['pyproject.toml'] },
    { backend: 'laravel', expected: ['composer.json', 'artisan'] },
  ]) {
    withProject((cwd) => {
      const state = {
        mode: 'new-project',
        stack: 'custom-backend',
        frontend: 'none',
        backend: fixture.backend,
        mobile: { framework: 'none' },
      };
      const compiled = compileArchitecture(cwd, 'R', state, semanticService);
      const outputs = compiled.allowedOutputs;
      for (const expected of fixture.expected) assert.ok(outputs.includes(expected), `${fixture.backend}: ${expected}`);
      assert.ok(!outputs.some((output) => /(?:^|\/)(?:apps\/web|pnpm-workspace|tailwind|playwright)/i.test(output)),
        `${fixture.backend}: ${outputs.join(', ')}`);
      assert.ok(!compiled.profile.roles.includes('senior-frontend'));

      const existing = compileArchitecture(cwd, 'E', { ...state, mode: 'existing-codebase' }, semanticService);
      assert.ok(!existing.allowedOutputs.some((output) => fixture.expected.includes(output)),
        `${fixture.backend}: existing-codebase must not re-plan scaffold/config outputs`);
    });
  }
});
