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
  isDeletableStrayArtifact,
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

const SERVICE_INPUT: ArchitectureInputV1 = {
  schemaVersion: 1,
  routes: [],
  modules: [{ id: 'sync-service', name: 'Sync Service', kind: 'service' }],
};

function assertScaffoldOwner(
  compiled: ReturnType<typeof compileArchitecture>,
  outputPath: string,
  ownerRole: string,
): void {
  const matches = (compiled.scaffoldOutputs || []).filter((output) => output.path === outputPath);
  assert.equal(matches.length, 1, `${outputPath} must be compiled exactly once`);
  assert.equal(matches[0]?.ownerRole, ownerRole, `${outputPath} owner`);
}

function assertNoRuntimeContextScaffolds(compiled: ReturnType<typeof compileArchitecture>): void {
  const outputs = [
    ...(compiled.scaffoldOutputs || []).map((output) => output.path),
    ...compiled.allowedOutputs,
  ];
  assert.ok(!outputs.includes('AGENTS.md'));
  assert.ok(!outputs.includes('CLAUDE.md'));
  assert.ok(!outputs.some((output) => output === '.traffic-one' || output.startsWith('.traffic-one/')));
}

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

test('vite-react+supabase compiled outputs cover the standard surfaces the rules require', () => {
  withProject((cwd) => {
    const inputPath = architectureInputPath(cwd, 'R');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify(INPUT), 'utf8');
    const compiled = compileArchitectureForRun(cwd, 'R', REACT_STATE);
    const scaffoldOutputs = compiled.scaffoldOutputs ?? [];
    assert.ok(scaffoldOutputs.length > 0, 'compiled architecture carries scaffold outputs');
    const byPath = new Map(scaffoldOutputs.map((o) => [o.path, o.ownerRole]));
    // 4cu: frontend digested BLOCKED twice over these — the SEO rule requires
    // them but nothing compiled them, forcing architect replans mid-build.
    for (const asset of [
      'apps/web/public/robots.txt',
      'apps/web/public/sitemap.xml',
      'apps/web/public/manifest.webmanifest',
      'apps/web/public/favicon.ico',
      'apps/web/public/apple-touch-icon.png',
      'apps/web/public/og-image.png',
    ]) {
      assert.equal(byPath.get(asset), 'senior-frontend', `missing frontend asset grant: ${asset}`);
    }
    // 4cu backend: the generated Database types snapshot was in no allowlist.
    assert.equal(byPath.get('packages/api-client/src/database.types.ts'), 'senior-backend');
    // 6co: no compiled home for the client factory, so the FRONTEND built its
    // own `createClient` in an auth feature and passed closures into
    // backend-owned services. One factory, owned with the schema and types.
    assert.equal(byPath.get('packages/api-client/src/supabase.ts'), 'senior-backend');
    assert.equal(byPath.get('packages/api-client/src/index.ts'), 'senior-backend');
    // The package manifest is what makes it a resolvable workspace member and
    // what the typecheck gate reads.
    assert.equal(byPath.get('packages/api-client/package.json'), 'senior-backend');
    // 3cl: README + the canonical en locale catalog were in nobody's scope.
    assert.equal(byPath.get('README.md'), 'senior-frontend');
    assert.equal(byPath.get('packages/i18n/src/locales/en/common.json'), 'senior-frontend');
  });
});

test('new-project scaffold baselines are stack-aware, single-owner, and keep tooling beside the selected Node manifest', () => {
  const repositoryOutputs = [
    '.gitignore',
    'README.md',
    '.editorconfig',
    '.github/workflows/ci.yml',
  ];
  const nodeTooling = ['.prettierrc', '.prettierignore', '.nvmrc'];
  const workspaceOnly = ['pnpm-workspace.yaml', 'turbo.json', 'tsconfig.base.json'];

  withProject((cwd) => {
    const compiled = compileArchitecture(cwd, 'workspace-web', REACT_STATE, INPUT);
    for (const output of repositoryOutputs) assertScaffoldOwner(compiled, output, 'senior-frontend');
    for (const output of nodeTooling) assertScaffoldOwner(compiled, output, 'senior-frontend');
    for (const output of workspaceOnly) assertScaffoldOwner(compiled, output, 'senior-frontend');
    assertScaffoldOwner(compiled, '.env.example', 'senior-backend');
    assertNoRuntimeContextScaffolds(compiled);
  });

  withProject((cwd) => {
    const compiled = compileArchitecture(cwd, 'root-next', {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'nextjs',
      backend: 'external-api',
      mobile: { framework: 'none' },
    }, INPUT);
    assert.equal(compiled.profile.profileId, 'next-app');
    for (const output of repositoryOutputs) assertScaffoldOwner(compiled, output, 'senior-frontend');
    for (const output of nodeTooling) assertScaffoldOwner(compiled, output, 'senior-frontend');
    assertScaffoldOwner(compiled, '.env.example', 'senior-frontend');
    for (const output of workspaceOnly) {
      assert.ok(!compiled.allowedOutputs.includes(output), `root Next excludes workspace-only ${output}`);
    }
    assertNoRuntimeContextScaffolds(compiled);
  });

  withProject((cwd) => {
    const compiled = compileArchitecture(cwd, 'vite-external-api', {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'react-vite',
      backend: 'external-api',
      mobile: { framework: 'none' },
    }, INPUT);
    assert.equal(compiled.profile.profileId, 'vite-react');
    assertScaffoldOwner(compiled, '.env.example', 'senior-frontend');
    assertScaffoldOwner(compiled, '.prettierrc', 'senior-frontend');
    assertNoRuntimeContextScaffolds(compiled);
  });

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'web/app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'web/package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    const compiled = compileArchitecture(cwd, 'nested-next', {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'nextjs',
      backend: 'none',
      mobile: { framework: 'none' },
    }, INPUT);
    assert.ok(compiled.allowedOutputs.includes('web/package.json'));
    assert.ok(!compiled.allowedOutputs.includes('package.json'));
    for (const output of repositoryOutputs) assertScaffoldOwner(compiled, output, 'senior-frontend');
    for (const output of nodeTooling) {
      assertScaffoldOwner(compiled, `web/${output}`, 'senior-frontend');
      assert.ok(!compiled.allowedOutputs.includes(output), `nested Next keeps ${output} beside its manifest`);
    }
    assert.ok(!compiled.allowedOutputs.includes('.env.example'));
    for (const output of workspaceOnly) {
      assert.ok(!compiled.allowedOutputs.includes(output), `nested Next excludes workspace-only ${output}`);
    }
    assertNoRuntimeContextScaffolds(compiled);
  });

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'web', 'app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      private: true,
    }));
    fs.writeFileSync(path.join(cwd, 'web', 'package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    const compiled = compileArchitecture(cwd, 'nested-next-root-tooling', {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'nextjs',
      backend: 'none',
      mobile: { framework: 'none' },
    }, INPUT);
    assertScaffoldOwner(compiled, 'package.json', 'senior-frontend');
    assertScaffoldOwner(compiled, 'web/package.json', 'senior-frontend');
    for (const output of nodeTooling) {
      assertScaffoldOwner(compiled, output, 'senior-frontend');
      assert.ok(!compiled.allowedOutputs.includes(`web/${output}`));
    }
    assertNoRuntimeContextScaffolds(compiled);
  });

  for (const fixture of [
    {
      name: 'Go API',
      state: {
        mode: 'new-project',
        stack: 'custom-backend',
        frontend: 'none',
        backend: 'go',
        mobile: { framework: 'none' },
      },
      input: SERVICE_INPUT,
      node: false,
      envOwner: 'senior-backend',
      expectedScaffolds: ['go.mod', 'go.sum'],
    },
    {
      name: 'NestJS API',
      state: {
        mode: 'new-project',
        stack: 'custom-backend',
        frontend: 'none',
        backend: 'nestjs',
        mobile: { framework: 'none' },
      },
      input: SERVICE_INPUT,
      node: true,
      envOwner: 'senior-backend',
      expectedScaffolds: ['package.json'],
    },
    {
      name: 'Python API',
      state: {
        mode: 'new-project',
        stack: 'custom-backend',
        frontend: 'none',
        backend: 'fastapi',
        mobile: { framework: 'none' },
      },
      input: SERVICE_INPUT,
      node: false,
      envOwner: 'senior-backend',
      expectedScaffolds: ['pyproject.toml'],
    },
    {
      name: 'Swift app',
      state: {
        mode: 'new-project',
        stack: 'custom-stack',
        frontend: 'none',
        backend: 'none',
        mobile: { framework: 'swift-native' },
      },
      input: INPUT,
      node: false,
      envOwner: null,
      expectedScaffolds: ['Package.swift'],
    },
    {
      name: 'Rust API',
      state: {
        mode: 'new-project',
        stack: 'custom-backend',
        frontend: 'none',
        backend: 'rust',
        mobile: { framework: 'none' },
      },
      input: SERVICE_INPUT,
      node: false,
      envOwner: 'senior-backend',
      expectedScaffolds: ['Cargo.toml'],
    },
    {
      name: 'Java API',
      state: {
        mode: 'new-project',
        stack: 'custom-backend',
        frontend: 'none',
        backend: 'java',
        mobile: { framework: 'none' },
      },
      input: SERVICE_INPUT,
      node: false,
      envOwner: 'senior-backend',
      expectedScaffolds: ['pom.xml'],
    },
    {
      name: 'Kotlin API',
      state: {
        mode: 'new-project',
        stack: 'custom-backend',
        frontend: 'none',
        backend: 'kotlin',
        mobile: { framework: 'none' },
      },
      input: SERVICE_INPUT,
      node: false,
      envOwner: 'senior-backend',
      expectedScaffolds: ['build.gradle.kts'],
    },
    {
      name: '.NET API',
      state: {
        mode: 'new-project',
        stack: 'custom-backend',
        frontend: 'none',
        backend: 'dotnet',
        mobile: { framework: 'none' },
      },
      input: SERVICE_INPUT,
      node: false,
      envOwner: 'senior-backend',
      expectedScaffolds: ['Directory.Build.props'],
    },
    {
      name: 'Kotlin native app',
      state: {
        mode: 'new-project',
        stack: 'custom-stack',
        frontend: 'none',
        backend: 'none',
        mobile: { framework: 'kotlin-android' },
      },
      input: INPUT,
      node: false,
      envOwner: null,
      expectedScaffolds: ['settings.gradle.kts', 'app/build.gradle.kts'],
    },
    {
      name: 'Flutter app',
      state: {
        mode: 'new-project',
        stack: 'custom-stack',
        frontend: 'none',
        backend: 'none',
        mobile: { framework: 'flutter' },
      },
      input: INPUT,
      node: false,
      envOwner: null,
      expectedScaffolds: ['pubspec.yaml'],
    },
    {
      name: 'React Native external API app',
      state: {
        mode: 'new-project',
        stack: 'custom-stack',
        frontend: 'none',
        backend: 'external-api',
        mobile: { framework: 'react-native-expo' },
      },
      input: INPUT,
      node: true,
      envOwner: null,
      expectedScaffolds: ['package.json', 'app.json'],
    },
  ] as const) {
    withProject((cwd) => {
      const compiled = compileArchitecture(cwd, fixture.name, fixture.state, fixture.input);
      const repositoryOwner = compiled.profile.roles.includes('senior-frontend')
        ? 'senior-frontend'
        : 'senior-backend';
      for (const output of repositoryOutputs) assertScaffoldOwner(compiled, output, repositoryOwner);
      for (const output of nodeTooling) {
        if (fixture.node) assertScaffoldOwner(compiled, output, repositoryOwner);
        else assert.ok(!compiled.allowedOutputs.includes(output), `${fixture.name} excludes ${output}`);
      }
      if (fixture.envOwner) assertScaffoldOwner(compiled, '.env.example', fixture.envOwner);
      else assert.ok(!compiled.allowedOutputs.includes('.env.example'), `${fixture.name} excludes .env.example`);
      for (const output of workspaceOnly) {
        assert.ok(!compiled.allowedOutputs.includes(output), `${fixture.name} excludes workspace-only ${output}`);
      }
      for (const output of fixture.expectedScaffolds) {
        assertScaffoldOwner(compiled, output, repositoryOwner);
      }
      assertNoRuntimeContextScaffolds(compiled);
    });
  }
});

test('every root web profile compiles its exact framework scaffold beside Node tooling', () => {
  const fixtures: Array<{
    frontend: string;
    profileId: string;
    frameworkScaffolds: string[];
    setupPaths?: string[];
  }> = [
    {
      frontend: 'nextjs',
      profileId: 'next-app',
      frameworkScaffolds: ['package.json', 'next.config.ts', 'tsconfig.json'],
    },
    {
      frontend: 'nextjs',
      profileId: 'next-pages',
      frameworkScaffolds: ['package.json', 'next.config.ts', 'tsconfig.json'],
      setupPaths: ['pages'],
    },
    {
      frontend: 'nuxt',
      profileId: 'nuxt',
      frameworkScaffolds: ['package.json', 'nuxt.config.ts', 'tsconfig.json'],
    },
    {
      frontend: 'vue',
      profileId: 'vue',
      frameworkScaffolds: ['package.json', 'vite.config.ts', 'tsconfig.json'],
    },
    {
      frontend: 'sveltekit',
      profileId: 'sveltekit',
      frameworkScaffolds: ['package.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json'],
    },
    {
      frontend: 'svelte',
      profileId: 'svelte',
      frameworkScaffolds: ['package.json', 'vite.config.ts', 'tsconfig.json'],
    },
    {
      frontend: 'astro',
      profileId: 'astro',
      frameworkScaffolds: ['package.json', 'astro.config.mjs', 'tsconfig.json'],
    },
    {
      frontend: 'angular',
      profileId: 'angular',
      frameworkScaffolds: ['package.json', 'angular.json', 'tsconfig.json'],
    },
    {
      frontend: 'other',
      profileId: 'generic-web',
      frameworkScaffolds: ['package.json'],
    },
  ];

  for (const fixture of fixtures) {
    withProject((cwd) => {
      for (const setupPath of fixture.setupPaths || []) {
        fs.mkdirSync(path.join(cwd, setupPath), { recursive: true });
      }
      const compiled = compileArchitecture(cwd, `root-${fixture.profileId}`, {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: fixture.frontend,
        backend: 'none',
        mobile: { framework: 'none' },
      }, INPUT);

      assert.equal(compiled.profile.profileId, fixture.profileId);
      for (const output of fixture.frameworkScaffolds) {
        assertScaffoldOwner(compiled, output, 'senior-frontend');
      }
      for (const output of ['.prettierrc', '.prettierignore', '.nvmrc']) {
        assertScaffoldOwner(compiled, output, 'senior-frontend');
      }
      for (const output of ['pnpm-workspace.yaml', 'turbo.json', 'tsconfig.base.json']) {
        assert.ok(!compiled.allowedOutputs.includes(output), `${fixture.profileId} excludes ${output}`);
      }
      assertNoRuntimeContextScaffolds(compiled);
    });
  }
});

test('compound profiles keep one owner per scaffold and honor the selected UI target', () => {
  withProject((cwd) => {
    const compiled = compileArchitecture(cwd, 'react-native-node-api', {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'none',
      backend: 'nestjs',
      mobile: { framework: 'react-native-expo' },
    }, {
      ...INPUT,
      modules: [
        ...INPUT.modules,
        { id: 'sync-service', name: 'Sync Service', kind: 'service' },
      ],
    });
    assertScaffoldOwner(compiled, 'package.json', 'senior-frontend');
    assertScaffoldOwner(compiled, '.prettierrc', 'senior-frontend');
    assertScaffoldOwner(compiled, '.env.example', 'senior-backend');
    assert.ok(compiled.modules.some((module) => module.ownerRole === 'senior-backend'));
    assertNoRuntimeContextScaffolds(compiled);
  });

  withProject((cwd) => {
    const compiled = compileArchitecture(cwd, 'swift-node-api', {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'none',
      backend: 'nestjs',
      mobile: { framework: 'swift-native' },
    }, INPUT);
    assertScaffoldOwner(compiled, 'package.json', 'senior-backend');
    assertScaffoldOwner(compiled, '.prettierrc', 'senior-backend');
    assertScaffoldOwner(compiled, '.gitignore', 'senior-frontend');
    assertNoRuntimeContextScaffolds(compiled);
  });

  withProject((cwd) => {
    const compiled = compileArchitecture(cwd, 'native-target-external-api', {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'react-vite',
      backend: 'external-api',
      mobile: { framework: 'react-native-expo' },
      architectureTarget: 'native-ui',
    }, INPUT);
    assert.equal(compiled.profile.profileId, 'react-native');
    assert.ok(!compiled.allowedOutputs.includes('.env.example'));
    assert.ok(compiled.allowedOutputs.includes('.maestro/flows/smoke.yaml'));
    assert.ok(!compiled.allowedOutputs.includes('playwright.config.ts'));
    assertNoRuntimeContextScaffolds(compiled);
  });

  withProject((cwd) => {
    const compiled = compileArchitecture(cwd, 'native-target-node-api', {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'react-vite',
      backend: 'nestjs',
      mobile: { framework: 'swift-native' },
      architectureTarget: 'native-ui',
    }, INPUT);
    assert.equal(compiled.profile.profileId, 'swift-native');
    assertScaffoldOwner(compiled, 'package.json', 'senior-backend');
    assertScaffoldOwner(compiled, '.prettierrc', 'senior-backend');
    assertScaffoldOwner(compiled, '.env.example', 'senior-backend');
    assert.ok(compiled.allowedOutputs.includes('Tests/AppSmokeTests.swift'));
    assert.ok(!compiled.allowedOutputs.includes('playwright.config.ts'));
    assertNoRuntimeContextScaffolds(compiled);
  });
});

test('Laravel compiles the Node and PHP formatter/testing boundaries without sharing ownership', () => {
  withProject((cwd) => {
    const compiled = compileArchitecture(cwd, 'laravel-ui', {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'laravel-ui',
      backend: 'laravel',
      mobile: { framework: 'none' },
    }, INPUT);
    assert.equal(compiled.profile.profileId, 'server-rendered');
    assertScaffoldOwner(compiled, 'package.json', 'senior-frontend');
    assertScaffoldOwner(compiled, '.prettierrc', 'senior-frontend');
    assertScaffoldOwner(compiled, 'composer.json', 'senior-backend');
    assertScaffoldOwner(compiled, 'phpunit.xml', 'senior-tester');
    assertScaffoldOwner(compiled, 'playwright.config.ts', 'senior-tester');
    assertNoRuntimeContextScaffolds(compiled);
  });
});

test('module display names accept title punctuation and reject path/markup chars', () => {
  const named = (name: string): ReturnType<typeof validateArchitectureInput> =>
    validateArchitectureInput({
      ...INPUT,
      modules: [...INPUT.modules.slice(0, 2), { id: 'news', name, kind: 'page' }],
    });
  // observed 2cl: a comma in a human title cost the architect a deny cycle
  assert.equal(named('Content schema, RLS, and seeds').ok, true);
  assert.equal(named("Learner's dashboard (v2): progress & stats").ok, true);
  for (const bad of ['api/routes', 'a<b>', 'x"quoted"', '`tick`', '1st module', '']) {
    const validation = named(bad);
    assert.equal(validation.ok, false, `expected reject: ${bad}`);
    assert.ok(validation.errors.some((error) => error.includes('modules[2].name is invalid')));
  }
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
  const unsupported = (label: string, key: string): string | undefined =>
    validation.errors.find((error) => error.startsWith(`${label} has unsupported field ${key} (accepted: `));
  assert.ok(unsupported('input', 'profile'));
  assert.ok(unsupported('input', 'sourceRoots'));
  assert.ok(unsupported('modules[0]', 'customPolicy'));
  assert.ok(unsupported('exceptions[0]', 'disableAll'));
  // the error names the fields that ARE accepted, so one retry is enough
  assert.equal(unsupported('routes[0]', 'output'), 'routes[0] has unsupported field output (accepted: id, path, moduleId, redirect)');

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

test('every workspace package holding a compiled output gets a manifest, owned by that package', () => {
  // 1cu-cursor: supabase services compile to `packages/api-client/src/*.ts`
  // while only the FRONTEND packages had hardcoded manifests, so the compiled
  // backend package could never become a resolvable workspace member.
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'apps/web/src/pages'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    const inputPath = architectureInputPath(cwd, 'R');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify({
      ...INPUT,
      modules: [
        ...INPUT.modules,
        { id: 'auth-api', name: 'AuthAPIService', kind: 'service' },
      ],
    }));
    const architecture = compileArchitectureForRun(cwd, 'R', REACT_STATE);
    const serviceOutput = architecture.modules.find((module) => module.id === 'auth-api')?.output;
    assert.equal(serviceOutput, 'packages/api-client/src/AuthAPIService.ts');

    const manifest = architecture.scaffoldOutputs
      ?.find((output) => output.path === 'packages/api-client/package.json');
    assert.deepEqual(manifest, {
      path: 'packages/api-client/package.json',
      ownerRole: 'senior-backend',
      kind: 'scaffold',
    });
    assert.ok(architecture.allowedOutputs.includes('packages/api-client/package.json'));

    // the frontend packages keep their declared owner — no duplicate entry
    const uiManifests = (architecture.scaffoldOutputs || [])
      .filter((output) => output.path === 'packages/ui/package.json');
    assert.equal(uiManifests.length, 1);
    assert.equal(uiManifests[0]?.ownerRole, 'senior-frontend');

    const verification = compileVerificationContract(cwd, 'R', REACT_STATE, architecture, { changedPaths: [] });
    const assignments = publishRuntimeAssignments(cwd, architecture, verification.contractHash);
    const backendScope = assignments.assignments
      .find((assignment) => assignment.role === 'senior-backend')?.scope.include || [];
    assert.ok(backendScope.includes('packages/api-client/package.json'));
    assert.ok(backendScope.includes('packages/api-client/src/AuthAPIService.ts'));
    assert.equal(backendScope.includes('packages/ui/package.json'), false);
  });
});

test('a supabase backend owns its whole data layer, and every project owns a .gitignore', () => {
  // 1cu/2cu backends both reported the migrations gap; 1cl never reached
  // PLAN_READY because the architect could not queue `supabase/seed.sql`.
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'apps/web/src/pages'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    const inputPath = architectureInputPath(cwd, 'R');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify(INPUT));
    const architecture = compileArchitectureForRun(cwd, 'R', REACT_STATE);

    const verification = compileVerificationContract(cwd, 'R', REACT_STATE, architecture, { changedPaths: [] });
    const assignments = publishRuntimeAssignments(cwd, architecture, verification.contractHash);
    const scopeFor = (role: string): string[] => assignments.assignments
      .find((assignment) => assignment.role === role)?.scope.include || [];

    for (const output of ['supabase/config.toml', 'supabase/migrations/0001_init.sql', 'supabase/seed.sql']) {
      assert.ok(architecture.allowedOutputs.includes(output), output);
      assert.ok(scopeFor('senior-backend').includes(output), output);
    }
    // one owner only — the frontend must not be able to write the data layer
    assert.equal(scopeFor('senior-frontend').some((entry) => entry.startsWith('supabase/')), false);

    // 2cu shipped with no .gitignore because nothing compiled it
    assert.ok(architecture.allowedOutputs.includes('.gitignore'));
    assert.ok(scopeFor('senior-frontend').includes('.gitignore'));
    // and the tester gets a workspace runner config instead of improvising one
    assert.ok(scopeFor('senior-tester').includes('vitest.config.ts'));
  });
});

test('the router catch-all is declarable and matches the path routers actually use', () => {
  // 2cu: `*` was rejected by the input schema, `/*` never matched the
  // `path="*"` in code, so the app shipped with an unreachable NotFoundPage.
  assert.equal(validateArchitectureInput({
    ...INPUT,
    routes: [...INPUT.routes, { id: 'not-found-route', path: '*', moduleId: 'not-found' }],
    modules: [...INPUT.modules, { id: 'not-found', name: 'Not found page', kind: 'page' }],
  }).ok, true);

  const invalid = validateArchitectureInput({
    ...INPUT,
    routes: [{ id: 'bad-route', path: 'courses', moduleId: 'home' }],
  });
  assert.equal(invalid.ok, false);
  // the error states the accepted shape instead of only naming the field
  assert.ok(invalid.errors.some((error) => error.includes('catch-all') && error.includes('leading-slash')));

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'apps/web/src/pages'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, {
      ...INPUT,
      routes: [...INPUT.routes, { id: 'not-found-route', path: '*', moduleId: 'not-found' }],
      modules: [...INPUT.modules, { id: 'not-found', name: 'Not found page', kind: 'page' }],
    });
    // no path segments to derive from → falls back to the module name, exactly
    // like a page with no route (never `pages/*/...`, which is not a filename)
    const output = compiled.modules.find((module) => module.id === 'not-found')?.output;
    assert.equal(output, 'apps/web/src/pages/NotFoundPage.tsx');
    assert.equal(compiled.routes.find((route) => route.id === 'not-found-route')?.path, '*');
  });
});

test('flat next-app compiles styling/i18n homes and the workspace declaration for its backend package', () => {
  // 5cl-claude: the profile shipped only package.json/next.config/tsconfig, so
  // the frontend inlined 240 lines of CSS into a <style> tag, hardcoded every
  // string, and `packages/api-client` sat in a repo with NO pnpm-workspace.yaml
  // in any role's scope — an unresolvable workspace member.
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    const compiled = compileArchitecture(cwd, 'R', {
      ...REACT_STATE,
      stack: 'custom-frontend',
      frontend: 'nextjs',
      backend: 'supabase',
    }, {
      ...INPUT,
      modules: [
        ...INPUT.modules,
        { id: 'learning-repository', name: 'Learning Repository', kind: 'service' },
      ],
    });
    assert.equal(compiled.profile.profileId, 'next-app');
    const paths = (compiled.scaffoldOutputs || []).map((output) => output.path);
    for (const expected of [
      'postcss.config.mjs',
      'next-env.d.ts',
      'app/globals.css',
      'messages/en.json',
    ]) {
      assert.ok(paths.includes(expected), `missing frontend scaffold ${expected}`);
      assert.equal(
        (compiled.scaffoldOutputs || []).find((output) => output.path === expected)?.ownerRole,
        'senior-frontend',
      );
    }
    // backend package compiled under packages/ → the workspace declaration
    // must exist exactly once with a real owner
    assert.ok(paths.includes('packages/api-client/package.json'));
    const workspaceDecl = (compiled.scaffoldOutputs || [])
      .filter((output) => output.path === 'pnpm-workspace.yaml');
    assert.equal(workspaceDecl.length, 1);
    assert.equal(workspaceDecl[0]?.ownerRole, 'senior-frontend');
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

test('isDeletableStrayArtifact permits only untracked, uncompiled, non-baseline files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-stray-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    const architecture = compileArchitecture(dir, 'R', {
      mode: 'new-project',
      stack: 'react-vite',
      frontend: 'react',
      backend: 'none',
      mobile: { framework: 'none' },
    }, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
      ],
    });

    // The 6co shape: a stray raster beside owned icons that neither the child
    // nor the parent could remove.
    fs.mkdirSync(path.join(dir, 'public/icons'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public/icons/favicon.svg.png'), 'stray');
    assert.equal(isDeletableStrayArtifact(dir, 'public/icons/favicon.svg.png', architecture), true);

    // A compiled output is a contract change, never cleanup.
    const compiled = (architecture.scaffoldOutputs || [])
      .find((output) => output.path.endsWith('public/sitemap.xml'))!.path;
    fs.mkdirSync(path.join(dir, path.dirname(compiled)), { recursive: true });
    fs.writeFileSync(path.join(dir, compiled), '<urlset/>');
    assert.equal(isDeletableStrayArtifact(dir, compiled, architecture), false);

    // Directories, missing files, plugin state, and escapes all stay denied.
    assert.equal(isDeletableStrayArtifact(dir, 'public/icons', architecture), false);
    assert.equal(isDeletableStrayArtifact(dir, 'public/absent.png', architecture), false);
    assert.equal(isDeletableStrayArtifact(dir, '.traffic-one/runs/R/run.json', architecture), false);
    assert.equal(isDeletableStrayArtifact(dir, '../outside.png', architecture), false);
    assert.equal(isDeletableStrayArtifact(dir, 'public/icons/favicon.svg.png', null), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
