import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import {
  architectureInputPath,
  buildRuntimeAssignments,
  captureArchitectureBaseline,
  compileArchitecture,
  ensureScaffoldContent,
  compileArchitectureForRun,
  compiledArchitecturePath,
  createWorkUnitContract,
  ensureArchitectureRunSnapshot,
  isDeletableStrayArtifact,
  isScanSkippedPath,
  moduleOutputVariants,
  publishRuntimeAssignments,
  readArchitectureRunBaseline,
  legacyCustomBackendMigration,
  readArchitectureRunSnapshot,
  readCompiledArchitecture,
  readRuntimeAssignments,
  runtimeAssignmentsPath,
  scanSkipPredicate,
  stableContractJson,
  uiAstLintLayer,
  validateArchitectureInput,
  type ArchitectureInputV1,
} from '../architecture-contract';
import { matchesScope } from '../scope';
import { resolveInitialScaffoldOwners } from '../architecture-contract/scaffold';
import { sha256 } from '../text';
import { browserRequired, deriveUiImpact } from '../verification-contract/impact';
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

test('React-family feature modules compile to TSX entries that can contain JSX', () => {
  const featureInput: ArchitectureInputV1 = {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'contact-section', name: 'Contact Section', kind: 'feature' }],
  };
  const fixtures = [
    {
      name: 'vite-react',
      state: REACT_STATE,
      setupPaths: [],
      expectedProfile: 'vite-react',
      expectedOutput: 'apps/web/src/features/contact-section/index.tsx',
    },
    {
      name: 'next-app',
      state: {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: 'nextjs',
        backend: 'none',
        mobile: { framework: 'none' },
      },
      setupPaths: [],
      expectedProfile: 'next-app',
      expectedOutput: 'apps/web/features/contact-section/index.tsx',
    },
    {
      name: 'next-pages',
      state: {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: 'nextjs',
        backend: 'none',
        mobile: { framework: 'none' },
      },
      setupPaths: ['apps/web/pages'],
      expectedProfile: 'next-pages',
      expectedOutput: 'apps/web/features/contact-section/index.tsx',
    },
    {
      name: 'react-native',
      state: {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: 'none',
        backend: 'none',
        mobile: { framework: 'react-native-expo' },
      },
      setupPaths: [],
      expectedProfile: 'react-native',
      expectedOutput: 'src/features/contact-section/index.tsx',
    },
  ];

  for (const fixture of fixtures) {
    withProject((cwd) => {
      for (const setupPath of fixture.setupPaths || []) {
        fs.mkdirSync(path.join(cwd, setupPath), { recursive: true });
      }
      const compiled = compileArchitecture(cwd, fixture.name, fixture.state, featureInput);
      assert.equal(compiled.profile.profileId, fixture.expectedProfile);
      assert.equal(compiled.modules[0]?.output, fixture.expectedOutput);
      assert.ok(compiled.allowedOutputs.includes(fixture.expectedOutput));
    });
  }
});

test('the compiled feature entry takes the framework-native default plus an allowed extension set on every profile', () => {
  // The regression this exists for: `feature` was bucketed with service/store
  // and compiled to `index.ts` on EVERY profile, so a React UI section had to
  // hold JSX in a file TypeScript forbids it in, and a Vue/Svelte/Astro section
  // had to be a single-file component that was not a `.vue`/`.svelte`/`.astro`
  // file. One case per profile so the whole matrix is pinned, not one corner.
  //
  // Extension freedom (12co): the contract pins the BASE PATH; the default is
  // the first allowed extension and the implementer may deliver any other
  // allowed one (a headless `.ts` feature on React) — tsc/build arbitrates.
  const featureInput: ArchitectureInputV1 = {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'contact-section', name: 'Contact Section', kind: 'feature' }],
  };
  const web = (frontend: string): Record<string, unknown> => ({
    mode: 'new-project',
    stack: 'custom-frontend',
    frontend,
    backend: 'none',
    mobile: { framework: 'none' },
  });
  const fixtures: Array<{
    name: string;
    state: Record<string, unknown>;
    setupPaths?: string[];
    setupFiles?: Record<string, string>;
    expectedProfile: string;
    expectedExtension: string;
    expectedAllowed: string[];
  }> = [
    { name: 'vite-react', state: REACT_STATE, expectedProfile: 'vite-react', expectedExtension: '.tsx', expectedAllowed: ['.tsx', '.ts'] },
    { name: 'next-app', state: web('nextjs'), expectedProfile: 'next-app', expectedExtension: '.tsx', expectedAllowed: ['.tsx', '.ts'] },
    {
      name: 'next-pages',
      state: web('nextjs'),
      setupPaths: ['apps/web/pages'],
      expectedProfile: 'next-pages',
      expectedExtension: '.tsx',
      expectedAllowed: ['.tsx', '.ts'],
    },
    {
      name: 'react-native',
      state: { ...web('none'), mobile: { framework: 'react-native-expo' } },
      expectedProfile: 'react-native',
      expectedExtension: '.tsx',
      expectedAllowed: ['.tsx', '.ts'],
    },
    {
      // Inertia React: the server-rendered profile whose UI is React.
      name: 'inertia-react',
      state: { ...REACT_STATE, stack: 'custom-backend', frontend: 'none', backend: 'laravel' },
      setupPaths: ['resources/js/Pages'],
      setupFiles: {
        'resources/js/app.tsx': 'export {};\n',
        'composer.json': JSON.stringify({
          require: { 'laravel/framework': '^12.0', 'inertiajs/inertia-laravel': '^2.0' },
        }),
        'package.json': JSON.stringify({ dependencies: { '@inertiajs/react': '^2.0', react: '^19.0' } }),
      },
      expectedProfile: 'server-rendered',
      expectedExtension: '.tsx',
      expectedAllowed: ['.tsx', '.ts'],
    },
    { name: 'nuxt', state: web('nuxt'), expectedProfile: 'nuxt', expectedExtension: '.vue', expectedAllowed: ['.vue', '.ts'] },
    { name: 'vue', state: web('vue'), expectedProfile: 'vue', expectedExtension: '.vue', expectedAllowed: ['.vue', '.ts'] },
    { name: 'svelte', state: web('svelte'), expectedProfile: 'svelte', expectedExtension: '.svelte', expectedAllowed: ['.svelte', '.ts'] },
    {
      // SvelteKit is detected from its config artifact, never from state — the
      // wizard only knows `svelte`.
      name: 'sveltekit',
      state: web('svelte'),
      setupFiles: { 'svelte.config.js': 'export default {};\n' },
      expectedProfile: 'sveltekit',
      expectedExtension: '.svelte',
      expectedAllowed: ['.svelte', '.ts'],
    },
    { name: 'astro', state: web('astro'), expectedProfile: 'astro', expectedExtension: '.astro', expectedAllowed: ['.astro', '.ts'] },
    // Angular is the deliberate exception: its components ARE `.ts` classes,
    // so there is no second legal form.
    { name: 'angular', state: web('angular'), expectedProfile: 'angular', expectedExtension: '.ts', expectedAllowed: ['.ts'] },
  ];

  for (const fixture of fixtures) {
    withProject((cwd) => {
      for (const setupPath of fixture.setupPaths || []) {
        fs.mkdirSync(path.join(cwd, setupPath), { recursive: true });
      }
      for (const [rel, body] of Object.entries(fixture.setupFiles || {})) {
        fs.mkdirSync(path.join(cwd, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(cwd, rel), body);
      }
      const compiled = compileArchitecture(cwd, fixture.name, fixture.state, featureInput);
      assert.equal(compiled.profile.profileId, fixture.expectedProfile, fixture.name);
      const feature = compiled.modules[0];
      const output = feature?.output || '';
      assert.equal(
        output.endsWith(`/index${fixture.expectedExtension}`),
        true,
        `${fixture.name}: expected a feature entry ending in index${fixture.expectedExtension}, got ${output}`,
      );
      assert.deepEqual(feature?.allowedExtensions, fixture.expectedAllowed, fixture.name);
      assert.equal(
        `${feature?.outputBase}${feature?.allowedExtensions?.[0]}`,
        output,
        `${fixture.name}: output must be outputBase + default extension`,
      );
      assert.deepEqual(
        moduleOutputVariants(feature!),
        fixture.expectedAllowed.map((ext) => `${feature?.outputBase}${ext}`),
        fixture.name,
      );
      assert.ok(compiled.allowedOutputs.includes(output), fixture.name);
    });
  }
});

test('framework-dictated filenames stay pinned while flat React kinds gain the .ts/.tsx pair', () => {
  withProject((cwd) => {
    const compiled = compileArchitecture(cwd, 'pinning', {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'nextjs',
      backend: 'none',
      mobile: { framework: 'none' },
    }, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
        { id: 'nav', name: 'Nav', kind: 'component' },
      ],
    });
    const byId = new Map(compiled.modules.map((module) => [module.id, module]));
    // Next App Router reads `layout.tsx`/`page.tsx` by NAME — no freedom there.
    assert.deepEqual(byId.get('app-shell')?.allowedExtensions, ['.tsx']);
    assert.deepEqual(byId.get('home')?.allowedExtensions, ['.tsx']);
    assert.deepEqual(moduleOutputVariants(byId.get('home')!), [byId.get('home')!.output]);
    // A non-route module is free: the toolchain, not the runtime, judges form.
    assert.deepEqual(byId.get('nav')?.allowedExtensions, ['.tsx', '.ts']);
  });
  withProject((cwd) => {
    // A React-family `.ts` default (service) may grow a provider and need JSX:
    // the same 12co class in the opposite direction.
    const compiled = compileArchitecture(cwd, 'service-freedom', REACT_STATE, SERVICE_INPUT);
    assert.deepEqual(compiled.modules[0]?.allowedExtensions, ['.ts', '.tsx']);
  });
});

test('a legacy compiled module without the additive fields keeps single-path behavior', () => {
  assert.deepEqual(
    moduleOutputVariants({ output: 'apps/web/src/features/auth/index.tsx' }),
    ['apps/web/src/features/auth/index.tsx'],
  );
});

test('uiPrimitives are safe, deduplicated, demand-driven adapter outputs', () => {
  const uiInput: ArchitectureInputV1 = {
    ...INPUT,
    uiPrimitives: [
      'progress',
      'dialog',
      'alert-dialog',
      'sheet',
      'data-table',
      'date-picker',
      'combobox',
      'progress',
    ],
    modules: [
      ...INPUT.modules,
      {
        id: 'status-summary',
        name: 'Status Summary',
        kind: 'component',
        placement: 'shared-ui',
      },
    ],
  };
  assert.equal(validateArchitectureInput(uiInput).ok, true);
  withProject((cwd) => {
    const compiled = compileArchitecture(cwd, 'ui-react', {
      ...REACT_STATE,
      backend: 'none',
    }, uiInput);
    assert.deepEqual(compiled.uiPrimitives, [
      'alert-dialog',
      'combobox',
      'data-table',
      'date-picker',
      'dialog',
      'progress',
      'sheet',
    ]);
    for (const primitive of compiled.uiPrimitives || []) {
      assertScaffoldOwner(
        compiled,
        `packages/ui/src/components/ui/${primitive}.tsx`,
        'senior-frontend',
      );
    }
    assertScaffoldOwner(compiled, 'packages/ui/components.json', 'senior-frontend');
    assertScaffoldOwner(compiled, 'packages/ui/src/index.ts', 'senior-frontend');
    assert.equal(
      compiled.modules.find((module) => module.id === 'status-summary')?.output,
      'packages/ui/src/components/StatusSummary.tsx',
    );
  });

  for (const fixture of [
    { frontend: 'vue', adapterPath: 'packages/ui/src/components/ui/progress/**', shared: 'packages/ui/src/components/StatusSummary.vue' },
    { frontend: 'svelte', adapterPath: 'packages/ui/src/components/ui/progress/**', shared: 'packages/ui/src/components/StatusSummary.svelte' },
  ]) {
    withProject((cwd) => {
      const compiled = compileArchitecture(cwd, `ui-${fixture.frontend}`, {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: fixture.frontend,
        backend: 'none',
        mobile: { framework: 'none' },
      }, {
        ...INPUT,
        uiPrimitives: ['progress'],
        modules: [
          ...INPUT.modules,
          { id: 'status-summary', name: 'Status Summary', kind: 'component', placement: 'shared-ui' },
        ],
      });
      assertScaffoldOwner(compiled, fixture.adapterPath, 'senior-frontend');
      assert.equal(
        compiled.modules.find((module) => module.id === 'status-summary')?.output,
        fixture.shared,
      );
    });
  }
});

test('uiPrimitives and shared-ui placement reject unsafe or unsupported intent', () => {
  for (const primitive of ['../dialog', 'Dialog', 'dialog button', '@registry/dialog', '']) {
    assert.equal(validateArchitectureInput({
      ...INPUT,
      uiPrimitives: [primitive],
    }).ok, false, primitive);
  }
  assert.equal(validateArchitectureInput({
    ...INPUT,
    modules: [{ id: 'bad', name: 'Bad', kind: 'page', placement: 'shared-ui' }],
  }).ok, false);
  assert.equal(validateArchitectureInput({
    ...INPUT,
    modules: [{ id: 'bad', name: 'Bad', kind: 'component', placement: 'package' }],
  }).ok, false);

  withProject((cwd) => {
    assert.throws(() => compileArchitecture(cwd, 'angular-ui', {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'angular',
      backend: 'none',
      mobile: { framework: 'none' },
    }, {
      ...INPUT,
      uiPrimitives: ['progress'],
    }), /uiPrimitives require a resolved shadcn component system/);
  });
});

test('existing projects adopt packages/ui gradually and reuse installed primitives', () => {
  withProject((cwd) => {
    for (const dir of [
      'src',
      'packages/ui/src/components/ui',
      'packages/ui/src/lib',
    ]) fs.mkdirSync(path.join(cwd, dir), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'packages/ui/components.json'), JSON.stringify({
      $schema: 'https://ui.shadcn.com/schema.json',
      aliases: { ui: '@app/ui/components/ui' },
    }));
    fs.writeFileSync(
      path.join(cwd, 'packages/ui/src/components/ui/progress.tsx'),
      'export function Progress(){return null}\n',
    );

    const state = {
      ...REACT_STATE,
      mode: 'existing-codebase',
      backend: 'none',
    };
    const unchanged = compileArchitecture(cwd, 'existing-unchanged', state, INPUT);
    assert.equal(unchanged.profile.uiSystem?.source, 'detected');
    assert.ok(!(unchanged.scaffoldOutputs || []).some((output) => (
      output.path.startsWith('packages/ui/')
    )));

    const incremental = compileArchitecture(cwd, 'existing-incremental', state, {
      ...INPUT,
      uiPrimitives: ['progress', 'dialog'],
    });
    assertScaffoldOwner(
      incremental,
      'packages/ui/src/components/ui/progress.tsx',
      'senior-frontend',
    );
    assertScaffoldOwner(
      incremental,
      'packages/ui/src/components/ui/dialog.tsx',
      'senior-frontend',
    );
    assert.ok(!(incremental.scaffoldOutputs || []).some((output) => (
      /components\/ui\/(button|card|input)\./.test(output.path)
    )));
  });
});

test('architecture i18n validates locale intent and compiles locale/namespace parity outputs', () => {
  const localized: ArchitectureInputV1 = {
    ...INPUT,
    modules: [
      ...INPUT.modules,
      { id: 'courses-feature', name: 'Courses', kind: 'feature' },
    ],
    i18n: {
      sourceLocale: 'en',
      locales: ['en', 'ro'],
      literalBrands: ['Traffic One'],
    },
  };
  assert.equal(validateArchitectureInput(localized).ok, true);
  withProject((cwd) => {
    const compiled = compileArchitecture(cwd, 'localized', REACT_STATE, localized);
    assert.deepEqual(compiled.i18n?.locales, ['en', 'ro']);
    assert.deepEqual(compiled.i18n?.literalBrands, ['Traffic One']);
    assert.deepEqual(compiled.i18n?.namespaces, [
      'common',
      'courses-feature',
      'home-route',
      'news-route',
    ]);
    for (const locale of ['en', 'ro']) {
      for (const namespace of ['common', 'courses-feature', 'home-route', 'news-route']) {
        assertScaffoldOwner(
          compiled,
          `packages/i18n/src/locales/${locale}/${namespace}.json`,
          'senior-frontend',
        );
      }
    }
  });

  for (const i18n of [
    { sourceLocale: 'en', locales: ['ro'] },
    { sourceLocale: '../en', locales: ['../en'] },
    { sourceLocale: 'en', locales: ['en', 'en'] },
    { sourceLocale: 'en', locales: ['en'], literalBrands: ['<script>'] },
  ]) {
    assert.equal(validateArchitectureInput({ ...INPUT, i18n }).ok, false);
  }
});

test('new UI defaults to en while existing UI opts in explicitly', () => {
  withProject((cwd) => {
    const greenfield = compileArchitecture(cwd, 'new-ui', REACT_STATE, INPUT);
    assert.equal(greenfield.i18n?.sourceLocale, 'en');
    assert.deepEqual(greenfield.i18n?.locales, ['en']);

    const existing = compileArchitecture(cwd, 'existing-ui', {
      ...REACT_STATE,
      mode: 'existing-codebase',
    }, INPUT);
    assert.equal(existing.i18n, undefined);
    assert.ok(!existing.allowedOutputs.some((output) => output.includes('/locales/')));

    const explicit = compileArchitecture(cwd, 'existing-i18n-request', {
      ...REACT_STATE,
      mode: 'existing-codebase',
    }, {
      ...INPUT,
      i18n: { sourceLocale: 'en', locales: ['en', 'ro'] },
    });
    assert.deepEqual(explicit.i18n?.locales, ['en', 'ro']);
    assert.ok(explicit.allowedOutputs.includes('packages/i18n/src/locales/ro/common.json'));
  });
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
      // 12co: the reviewer's docs baseline REQUIRES a served `/llms.txt` and
      // `auto-documentation-generator` names `public/llms.txt` as its home, but
      // nothing compiled it — an `apps/*/public/**` path is a build artifact, so
      // the write was hard-denied with STRUCT_ASSIGNMENT_ALLOWLIST_GAP whose only
      // remedy is a replan the fix cycle cannot perform. The requirement is kept
      // and the path is compiled; the served copy is the ONLY llms.txt.
      'apps/web/public/llms.txt',
    ]) {
      assert.equal(byPath.get(asset), 'senior-frontend', `missing frontend asset grant: ${asset}`);
    }
    assert.ok(!scaffoldOutputs.some((output) => output.path === 'llms.txt'),
      'a root llms.txt is not compiled: one owned home, not two');
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
    // README + every compiled locale/namespace catalog have an owner.
    assert.equal(byPath.get('README.md'), 'senior-frontend');
    assert.equal(byPath.get('packages/i18n/src/locales/en/common.json'), 'senior-frontend');
    assert.equal(byPath.get('packages/i18n/src/locales/en/home-route.json'), 'senior-frontend');
    assert.equal(byPath.get('packages/i18n/src/locales/en/news-route.json'), 'senior-frontend');
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
    for (const output of workspaceOnly) assertScaffoldOwner(compiled, output, 'senior-frontend');
    assertScaffoldOwner(compiled, 'apps/web/package.json', 'senior-frontend');
    assertScaffoldOwner(compiled, 'packages/ui/package.json', 'senior-frontend');
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
    assertScaffoldOwner(compiled, 'apps/web/package.json', 'senior-frontend');
    assertScaffoldOwner(compiled, 'package.json', 'senior-frontend');
    assert.ok(!compiled.allowedOutputs.includes('web/package.json'));
    for (const output of repositoryOutputs) assertScaffoldOwner(compiled, output, 'senior-frontend');
    for (const output of nodeTooling) {
      assertScaffoldOwner(compiled, output, 'senior-frontend');
      assert.ok(!compiled.allowedOutputs.includes(`web/${output}`));
    }
    assert.ok(!compiled.allowedOutputs.includes('.env.example'));
    for (const output of workspaceOnly) assertScaffoldOwner(compiled, output, 'senior-frontend');
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
    assertScaffoldOwner(compiled, 'apps/web/package.json', 'senior-frontend');
    assert.ok(!compiled.allowedOutputs.includes('web/package.json'));
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
    expectedI18n: string;
    setupPaths?: string[];
    workspace: boolean;
  }> = [
    {
      frontend: 'nextjs',
      profileId: 'next-app',
      frameworkScaffolds: ['apps/web/package.json', 'apps/web/next.config.ts', 'apps/web/tsconfig.json'],
      expectedI18n: 'apps/web/i18n/locales/en/common.json',
      workspace: true,
    },
    {
      frontend: 'nextjs',
      profileId: 'next-pages',
      frameworkScaffolds: ['apps/web/package.json', 'apps/web/next.config.ts', 'apps/web/tsconfig.json'],
      expectedI18n: 'apps/web/i18n/locales/en/common.json',
      setupPaths: ['apps/web/pages'],
      workspace: true,
    },
    {
      frontend: 'nuxt',
      profileId: 'nuxt',
      frameworkScaffolds: ['apps/web/package.json', 'apps/web/nuxt.config.ts', 'apps/web/tsconfig.json'],
      expectedI18n: 'apps/web/i18n/locales/en.json',
      workspace: true,
    },
    {
      frontend: 'vue',
      profileId: 'vue',
      frameworkScaffolds: ['apps/web/package.json', 'apps/web/vite.config.ts', 'apps/web/tsconfig.json'],
      expectedI18n: 'apps/web/src/locales/en.json',
      workspace: true,
    },
    {
      frontend: 'sveltekit',
      profileId: 'sveltekit',
      frameworkScaffolds: ['apps/web/package.json', 'apps/web/svelte.config.js', 'apps/web/vite.config.ts', 'apps/web/tsconfig.json'],
      expectedI18n: 'apps/web/src/lib/i18n/en.json',
      workspace: true,
    },
    {
      frontend: 'svelte',
      profileId: 'svelte',
      frameworkScaffolds: ['apps/web/package.json', 'apps/web/vite.config.ts', 'apps/web/tsconfig.json'],
      expectedI18n: 'apps/web/src/lib/i18n/en.json',
      workspace: true,
    },
    {
      frontend: 'astro',
      profileId: 'astro',
      frameworkScaffolds: ['package.json', 'astro.config.mjs', 'tsconfig.json'],
      expectedI18n: 'src/i18n/en.json',
      workspace: false,
    },
    {
      frontend: 'angular',
      profileId: 'angular',
      frameworkScaffolds: ['package.json', 'angular.json', 'tsconfig.json'],
      expectedI18n: 'src/locale/messages.en.xlf',
      workspace: false,
    },
    {
      frontend: 'other',
      profileId: 'generic-web',
      frameworkScaffolds: ['package.json'],
      expectedI18n: 'src/locales/en.json',
      workspace: false,
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
      assertScaffoldOwner(compiled, fixture.expectedI18n, 'senior-frontend');
      for (const output of ['.prettierrc', '.prettierignore', '.nvmrc']) {
        assertScaffoldOwner(compiled, output, 'senior-frontend');
      }
      for (const output of ['pnpm-workspace.yaml', 'turbo.json', 'tsconfig.base.json']) {
        if (fixture.workspace) assertScaffoldOwner(compiled, output, 'senior-frontend');
        else assert.ok(!compiled.allowedOutputs.includes(output), `${fixture.profileId} excludes ${output}`);
      }
      if (fixture.workspace) assertScaffoldOwner(compiled, 'packages/ui/package.json', 'senior-frontend');
      assertNoRuntimeContextScaffolds(compiled);
    });
  }
});

test('native profiles compile their platform-native localization resources', () => {
  const fixtures = [
    {
      framework: 'react-native-expo',
      profileId: 'react-native',
      expected: ['src/i18n/index.ts', 'src/i18n/locales/en/common.json'],
    },
    {
      framework: 'swift-native',
      profileId: 'swift-native',
      expected: ['Localizable.xcstrings'],
    },
    {
      framework: 'kotlin-android',
      profileId: 'kotlin-native',
      expected: ['app/src/main/res/values/strings.xml'],
    },
    {
      framework: 'flutter',
      profileId: 'flutter-native',
      expected: ['l10n.yaml', 'lib/l10n/app_en.arb'],
    },
  ] as const;
  for (const fixture of fixtures) {
    withProject((cwd) => {
      const compiled = compileArchitecture(cwd, `i18n-${fixture.profileId}`, {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: 'none',
        backend: 'none',
        mobile: { framework: fixture.framework },
      }, INPUT);
      assert.equal(compiled.profile.profileId, fixture.profileId);
      for (const expected of fixture.expected) {
        assertScaffoldOwner(compiled, expected, 'senior-frontend');
      }
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
    assertScaffoldOwner(compiled, 'lang/en/common.php', 'senior-frontend');
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
      expected: 'apps/web/app/news/page.tsx',
    },
    {
      deps: { nuxt: '4.0.0', vue: '3.0.0' },
      dirs: ['pages'],
      state: { ...REACT_STATE, frontend: 'nuxt' },
      expected: 'apps/web/app/pages/news.vue',
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

test('a snapshot frozen as unsupported-hybrid is superseded once architectureTarget arrives', () => {
  // The 1785681001843 wedge: the run snapshot minted BEFORE the hybrid question
  // was answered froze `unsupported-hybrid` (a fail-closed state that authorized
  // no roots or roles), and mint-once then wedged the run forever — assignments
  // could never compile, maintenance writes failed closed, rotation was refused.
  // Completing the missing input must supersede the blocked profile in place.
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'packages/dashboard/app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'packages/dashboard/package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { expo: '55.0.0', react: '19.0.0', 'react-native': '0.83.0' },
    }));
    const state: Record<string, unknown> = {
      mode: 'existing-codebase',
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { framework: 'react-native-expo' },
    };
    const blocked = ensureArchitectureRunSnapshot(cwd, 'WEDGE', state);
    assert.equal(blocked.profile.profileId, 'unsupported-hybrid');
    assert.equal(blocked.profile.blockingIssues?.[0]?.code, 'CAPABILITY_HYBRID_UI_TARGET_REQUIRED');

    // Still blocked: a re-ensure WITHOUT the target changes nothing.
    const stillBlocked = ensureArchitectureRunSnapshot(cwd, 'WEDGE', state);
    assert.equal(stillBlocked.snapshotHash, blocked.snapshotHash);

    // The user answers the hybrid question → the SAME run supersedes in place:
    // clean profile, SAME immutable baseline (diff evidence preserved), new hash.
    const healed = ensureArchitectureRunSnapshot(cwd, 'WEDGE', { ...state, architectureTarget: 'native-ui' });
    assert.equal(healed.profile.profileId, 'react-native');
    assert.equal(healed.profile.blockingIssues, undefined);
    assert.equal(healed.baselineHash, blocked.baselineHash);
    assert.notEqual(healed.snapshotHash, blocked.snapshotHash);

    // Mint-once resumes: a healthy snapshot is NEVER superseded, even when the
    // live state would now resolve differently.
    const stable = ensureArchitectureRunSnapshot(cwd, 'WEDGE', { ...state, architectureTarget: 'web-ui' });
    assert.equal(stable.snapshotHash, healed.snapshotHash);
    assert.equal(stable.profile.profileId, 'react-native');
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

// ── backend framework wiring homes ─────────────────────────────────────────
// THE DEFECT THAT CLOSED. Compiling only the dependency manifest for every
// non-supabase backend left the framework's own wiring — routes, migrations,
// provider/DI registration, framework config — owned by nobody. Measured over 15
// probes driven through real compiled Laravel/Python/Go runs: 4 hard-denied at
// write time with STRUCT_ASSIGNMENT_ALLOWLIST_GAP, 11 ALLOWED (no gate engages,
// because `plan-runteam`'s `writingRunTeamTarget` guard never recognizes the
// path) and then refused at `IMPLEMENTED` for "changed paths outside the frozen
// verification/WorkUnit authority". Zero completed cleanly. The second shape is
// the one to keep an eye on here: it needs the ASSIGNMENT SCOPE to cover the
// path, not merely the write gate to stay quiet, which is why each case below
// asserts through `matchesScope` over the published manifest.

const LARAVEL_API_STATE = {
  mode: 'new-project',
  stack: 'custom-backend',
  frontend: 'none',
  backend: 'laravel',
  mobile: { framework: 'none' },
};

/** senior-backend's published scope for a compiled run — the exact matcher and
 *  manifest both the run-team write gate and the verification refresh use. */
function backendScope(
  cwd: string,
  state: Record<string, unknown>,
  input: ArchitectureInputV1 = SERVICE_INPUT,
  runId = 'R',
): { include: string[]; owns: (target: string) => boolean } {
  const architecture = compileArchitecture(cwd, runId, state, input);
  const verification = compileVerificationContract(cwd, runId, state, architecture, { changedPaths: [] });
  const assignments = buildRuntimeAssignments(architecture, verification.contractHash);
  const scope = assignments.assignments
    .find((assignment) => assignment.role === 'senior-backend')?.scope || { include: [], exclude: [] };
  return { include: scope.include, owns: (target: string) => matchesScope(target, scope) };
}

test('a Laravel backend owns its routes, migrations, providers and framework config', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
    }));
    const scope = backendScope(cwd, LARAVEL_API_STATE);

    // Every category the framework fixes a location for, per
    // laravel.com/docs/12.x/structure.
    for (const wiring of [
      'routes/web.php',
      'routes/api.php',
      'routes/console.php',
      'bootstrap/app.php',
      'bootstrap/providers.php',
      'app/Providers/AppServiceProvider.php',
      'config/database.php',
      'database/seeders/DatabaseSeeder.php',
    ]) {
      assert.ok(scope.owns(wiring), wiring);
    }

    // The directory arms exist because the FRAMEWORK generates these names —
    // `make:migration` stamps a timestamp, `make:controller` and `make:model`
    // take the feature's name — so no closed set of filenames can cover them and
    // a literal directory entry is what `matchesPattern` already reads as a
    // prefix. A pinned first-migration filename (the supabase arm's
    // `0001_init.sql`) buys the second migration nothing.
    for (const generated of [
      'database/migrations/2026_08_08_000000_create_projects_table.php',
      'database/factories/ProjectFactory.php',
      'app/Http/Controllers/ProjectController.php',
      'app/Models/Project.php',
      'config/projects.php',
    ]) {
      assert.ok(scope.owns(generated), generated);
    }

    // Not a source root: `app` itself is never compiled, because a
    // server-rendered profile's frontend lib root is `app/View`.
    assert.equal(scope.include.includes('app'), false);
    assert.ok(scope.owns('app/Services/SyncService.php'), 'the module output still stands');
  });
});

test('Laravel wiring follows the app into a nested workspace root, and never splits from composer.json', () => {
  // The monorepo shape, driven off a FROZEN profile whose roots are nested —
  // which is the only way this shape reaches the compiler. Measured while writing
  // this: a `apps/web/**` Laravel tree does NOT detect as a nested
  // server-rendered profile at all, it detects as `backend-only` with the default
  // `[src, app, cmd, internal]` roots, so `webPackageRoot` sees nothing nested
  // and every arm anchors at `.`. That is a detection question, not a wiring one;
  // what this pins is that WHEN the profile is nested, `composer.json`/`artisan`
  // and the wiring below cannot end up in different packages.
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'resources/views'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'resources/views/home.blade.php'), '<h1>Home</h1>\n');
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
    }));
    // new-project, so the MANIFEST arm compiles too and the two anchors can be
    // compared against each other in one contract.
    const state = {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'laravel',
      mobile: { framework: 'none' },
    };
    const flat = compileArchitecture(cwd, 'R', state, SERVICE_INPUT);
    assert.equal(flat.profile.profileId, 'server-rendered', 'premise: the flat tree is server-rendered');

    const nested = compileArchitecture(cwd, 'R', state, SERVICE_INPUT, flat.baseline, {
      ...flat.profile,
      sourceRoots: flat.profile.sourceRoots.map((root) => `apps/web/${root}`),
      layerRoots: {
        pages: flat.profile.layerRoots.pages.map((root) => `apps/web/${root}`),
        components: flat.profile.layerRoots.components.map((root) => `apps/web/${root}`),
        features: flat.profile.layerRoots.features.map((root) => `apps/web/${root}`),
        lib: flat.profile.layerRoots.lib.map((root) => `apps/web/${root}`),
      },
      entrypoints: flat.profile.entrypoints.map((entry) => `apps/web/${entry}`),
    });
    const paths = (nested.scaffoldOutputs || [])
      .filter((output) => output.ownerRole === 'senior-backend')
      .map((output) => output.path);
    for (const wiring of [
      'apps/web/routes/api.php',
      'apps/web/bootstrap/app.php',
      'apps/web/config',
      'apps/web/database',
    ]) {
      assert.ok(paths.includes(wiring), `${wiring} not in ${paths.join(' ')}`);
    }
    // The manifest arm anchors identically — they share `backendAppRoot`, so they
    // cannot disagree about where the application is.
    assert.ok(paths.includes('apps/web/composer.json'));
    assert.ok(paths.includes('apps/web/artisan'));
    // And nothing at the repo root: a root-anchored `config/` would claim the
    // monorepo's own tooling directory.
    assert.equal(paths.includes('config'), false);
    assert.equal(paths.includes('routes/api.php'), false);
  });
});

test('two roles cannot own one file through a directory output that contains another', () => {
  // The owner check keys on the EXACT path, which saw every collision while
  // every output was a filename. Directory outputs (`config`, `app/Http`,
  // `alembic`) broke that: `matchesPattern` reads a literal as
  // exact-or-directory-prefix, so `app` and `app/View` never collide as
  // strings while both claim `app/View/home.blade.php`. Measured before the
  // guard existed: both survived, no error, two roles owning one file.
  //
  // The shipped tables avoid this by naming `app/Http` and `app/Models`
  // rather than `app`. This is what makes that a checked property instead of
  // a thing the last author happened to get right.
  const profile = { roles: ['senior-frontend', 'senior-backend'] } as never;
  const output = (p: string, ownerRole: string) => (
    { path: p, ownerRole, kind: 'source' } as never
  );

  assert.throws(
    () => resolveInitialScaffoldOwners(profile, [
      output('app', 'senior-backend'),
      output('app/View', 'senior-frontend'),
    ]),
    /app\/View \(senior-frontend\) is inside app \(senior-backend\)/,
  );

  // Order must not decide it: the containing path arriving second is the same
  // fact, and a guard that only looked forward would miss half the inputs.
  assert.throws(
    () => resolveInitialScaffoldOwners(profile, [
      output('app/View', 'senior-frontend'),
      output('app', 'senior-backend'),
    ]),
    /is inside/,
  );

  // Two bounds, or the guard would refuse the shipped tables. SIBLINGS are
  // not containment — `app/Http` and `app/Models` are precisely how the
  // Laravel arm is spelled, and they must coexist.
  assert.deepEqual(
    resolveInitialScaffoldOwners(profile, [
      output('app/Http', 'senior-backend'),
      output('app/View', 'senior-frontend'),
    ]).map((entry: { path: string }) => entry.path),
    ['app/Http', 'app/View'],
  );

  // And ONE role may nest freely inside its own directory: there is no second
  // owner, so there is no ambiguity about who writes the file.
  assert.equal(
    resolveInitialScaffoldOwners(profile, [
      output('config', 'senior-backend'),
      output('config/projects.php', 'senior-backend'),
    ]).length,
    2,
  );
});

test('routes/web.php gets exactly one owner: the frontend when pages exist, the backend on an API', () => {
  // `routeRegistrationOutputs` hands the file to senior-frontend, but only on a
  // server-rendered profile. A Laravel API ships the same file and had no owner
  // at all; compiling it in both arms would make resolveInitialScaffoldOwners
  // throw instead, so the two must stay mutually exclusive.
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
    }));
    assert.ok(backendScope(cwd, LARAVEL_API_STATE).owns('routes/web.php'));
  });

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'resources/views'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'resources/views/home.blade.php'), '<h1>Home</h1>\n');
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
    }));
    const state = {
      mode: 'existing-codebase',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'laravel',
      mobile: { framework: 'none' },
    };
    const input: ArchitectureInputV1 = {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    };
    const architecture = compileArchitecture(cwd, 'R', state, input);
    const owner = (architecture.scaffoldOutputs || [])
      .filter((output) => output.path === 'routes/web.php');
    assert.equal(owner.length, 1);
    assert.equal(owner[0]?.ownerRole, 'senior-frontend');
    assert.equal(backendScope(cwd, state, input).include.includes('routes/web.php'), false);
  });
});

test('framework wiring is compiled on an existing codebase too, not only on a greenfield tree', () => {
  // The asymmetry against `backendScaffoldOutputs`, which is greenfield-only:
  // a scaffold output CREATES a skeleton, a wiring home is the integration edge
  // of a framework that already exists. The established-app case is the one that
  // needs it most — the run's whole job is to add a route to a file already on
  // disk — and the compiled scope measured just as empty there.
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'routes/api.php'), "<?php\n\nreturn [];\n");
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
    }));
    const scope = backendScope(cwd, { ...LARAVEL_API_STATE, mode: 'existing-codebase' });
    assert.ok(scope.owns('routes/api.php'));
    assert.ok(scope.owns('database/migrations/2026_08_08_000000_create_projects_table.php'));
    // The manifest arm really is greenfield-only, so this is a genuine
    // difference in behavior rather than two spellings of the same gate.
    assert.equal(scope.include.includes('composer.json'), false);
  });
});

test('each backend framework compiles the wiring homes its own toolchain fixes, and no others', () => {
  // One row per advertised backend. Where a framework fixes no single location
  // the row is EMPTY on purpose and says why — an invented path is worse than an
  // absent one, because a compiled home the toolchain does not read sends the
  // role to write in the wrong place with the product's authority behind it.
  const rows: Array<{ backend: string; owns: string[]; absent: string[] }> = [
    {
      // `alembic init alembic` writes alembic.ini beside the project and an
      // alembic/ tree holding env.py and versions/.
      backend: 'python',
      owns: ['alembic.ini', 'alembic/env.py', 'alembic/versions/0001_init.py'],
      // Raw SQL under `migrations/` is not the Python convention (Alembic is),
      // and `src/**` is the module tree the architect already declares into.
      absent: ['migrations/0001_init.sql', 'src/main.py'],
    },
    {
      // Cargo reads src/main.rs and src/lib.rs by name; `migrations/` at the
      // crate root is sqlx's DEFAULT_PATH and the location diesel mandates.
      backend: 'rust',
      owns: ['src/main.rs', 'src/lib.rs', 'migrations/0001_init/up.sql'],
      absent: ['diesel.toml'],
    },
    {
      // The Maven/Gradle standard layout fixes the resource root, and both
      // Spring Boot config and Flyway/Liquibase migrations live inside it.
      backend: 'java',
      owns: ['src/main/resources/application.yml', 'src/main/resources/db/migration/V1__init.sql'],
      // The CODE root is a source root, and the base package under it is not
      // derivable from anything the profile knows.
      absent: ['src/main/java/com/example/Application.java'],
    },
    {
      backend: 'kotlin',
      owns: ['src/main/resources/application.yml'],
      absent: ['src/main/kotlin/com/example/Application.kt'],
    },
    {
      // `dotnet new webapi` emits Program.cs and both appsettings files;
      // `dotnet ef migrations add` defaults its output to Migrations/.
      backend: 'dotnet',
      owns: ['Program.cs', 'appsettings.json', 'appsettings.Development.json', 'Migrations/20260808_Init.cs'],
      // Startup.cs is the pre-.NET-6 hosting model, the .csproj is named after
      // the project, and controller-based layouts are opt-in on `dotnet new`.
      absent: ['Startup.cs', 'Api.csproj', 'Controllers/ProductController.cs'],
    },
    {
      // Go has no framework and no agreed migration home (goose, golang-migrate
      // and atlas each name a different directory), while `internal`, `cmd` and
      // `pkg` are this product's own declared Go source roots. Nothing to fix.
      backend: 'go',
      owns: [],
      absent: ['migrations/0001_init.sql', 'internal/routes.go', 'cmd/api/main.go'],
    },
  ];

  for (const row of rows) {
    withProject((cwd) => {
      const scope = backendScope(cwd, {
        mode: 'new-project',
        stack: 'custom-backend',
        frontend: 'none',
        backend: row.backend,
        mobile: { framework: 'none' },
      });
      for (const wiring of row.owns) {
        assert.ok(scope.owns(wiring), `${row.backend} must own ${wiring}`);
      }
      for (const wiring of row.absent) {
        assert.equal(scope.owns(wiring), false, `${row.backend} must not claim ${wiring}`);
      }
    });
  }
});

test('a Django settings package is derived from baseline evidence, never invented', () => {
  // The package name is whatever was passed to `django-admin startproject`, and
  // `config/` (cookiecutter-django) and `<projectname>/` (the startproject
  // default) are both widespread. So the greenfield arm ships `manage.py` alone,
  // and the package is owned only where the tree proves which one it is.
  const state = {
    mode: 'existing-codebase',
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'django',
    mobile: { framework: 'none' },
  };

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'mysite'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'manage.py'), '# manage\n');
    fs.writeFileSync(path.join(cwd, 'mysite/settings.py'), 'DEBUG = False\n');
    fs.writeFileSync(path.join(cwd, 'mysite/urls.py'), 'urlpatterns = []\n');
    const scope = backendScope(cwd, state);
    assert.ok(scope.owns('manage.py'));
    assert.ok(scope.owns('mysite/urls.py'), 'the evidence names the package');
    assert.ok(scope.owns('mysite/settings.py'));
    assert.equal(scope.include.includes('config'), false);
  });

  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'manage.py'), '# manage\n');
    const scope = backendScope(cwd, state);
    assert.ok(scope.owns('manage.py'));
    // No settings.py anywhere, so nothing may be guessed.
    assert.equal(scope.owns('config/settings.py'), false);
    assert.equal(scope.owns('mysite/settings.py'), false);
  });
});

test('a wiring home is a permission: nothing seeds it, and a run that needs none pays nothing', () => {
  // Measured on the composed pipeline before this table was written: `go.sum` is
  // compiled for every Go run, run-sim never authors it on purpose, and the run
  // still reaches IMPLEMENTED, verified and settled with the file absent. This is
  // the unit-level half of that guarantee — `ensureScaffoldContent` is the ONLY
  // thing that puts a compiled scaffold path on disk unasked, and no wiring home
  // may have a body there, or every Laravel feature would grow a migration.
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
    }));
    const architecture = compileArchitecture(cwd, 'R', LARAVEL_API_STATE, SERVICE_INPUT);
    const wiring = (architecture.scaffoldOutputs || [])
      .filter((output) => /^(?:app\/|bootstrap\/|config$|database$|routes\/)/.test(output.path));
    assert.ok(wiring.length >= 8, `premise: this compile declares the wiring table (${wiring.length})`);

    const written = ensureScaffoldContent(cwd, architecture.scaffoldOutputs || [], architecture.profile, {
      compiled: architecture,
      newProject: true,
    });
    for (const output of wiring) {
      assert.equal(written.includes(output.path), false, `${output.path} must not be seeded`);
      assert.equal(fs.existsSync(path.join(cwd, output.path)), false, `${output.path} must not reach disk`);
    }
  });
});

test('an edge function is a declarable module kind that lands on the backend, off the app runtime', () => {
  // The architect hit a hard blocker and refused PLAN_READY: a Supabase
  // function had no representable kind. `service`/`store` are mandatorily
  // mapped into the app's own TypeScript project (`packages/api-client/src/
  // *.ts`) and `placement` is component-only, so there was no escape hatch.
  const input: ArchitectureInputV1 = {
    ...INPUT,
    modules: [
      ...INPUT.modules,
      { id: 'send-invite', name: 'Send Invite', kind: 'edge-function' },
    ],
  };
  assert.equal(validateArchitectureInput(input).ok, true);

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'apps/web/src/pages'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    const inputPath = architectureInputPath(cwd, 'R');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify(input));
    const architecture = compileArchitectureForRun(cwd, 'R', REACT_STATE);

    const compiled = architecture.modules.find((module) => module.id === 'send-invite');
    // The Supabase CLI deploys by directory name — this layout is the only one.
    assert.equal(compiled?.output, 'supabase/functions/send-invite/index.ts');
    assert.equal(compiled?.ownerRole, 'senior-backend');
    assert.ok(architecture.allowedOutputs.includes('supabase/functions/send-invite/index.ts'));

    const verification = compileVerificationContract(cwd, 'R', REACT_STATE, architecture, { changedPaths: [] });
    const assignments = publishRuntimeAssignments(cwd, architecture, verification.contractHash);
    const scopeFor = (role: string): string[] => assignments.assignments
      .find((assignment) => assignment.role === role)?.scope.include || [];
    assert.ok(scopeFor('senior-backend').includes('supabase/functions/send-invite/index.ts'));
    // Server code, single owner: the frontend can never write the function.
    assert.equal(scopeFor('senior-frontend').some((entry) => entry.startsWith('supabase/')), false);

    // Deno source gets no compiled unit test from the app runner: every edge
    // function's basename is `index`, so derived test paths would collide and
    // abort compilation outright.
    const scaffoldPaths = (architecture.scaffoldOutputs || []).map((output) => output.path);
    assert.equal(scaffoldPaths.includes('tests/index.test.ts'), false);
    assert.equal(scopeFor('senior-tester').some((entry) => entry.startsWith('supabase/functions/')), false);
  });

  // `supabase/functions/**` deploys nowhere on another backend, so the kind is
  // refused rather than compiled into a directory no toolchain reads.
  withProject((cwd) => {
    assert.throws(() => compileArchitecture(cwd, 'R', {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
    }, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'send-invite', name: 'Send Invite', kind: 'edge-function' }],
    }), /edge-function modules require a Supabase-family backend/);
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
      'apps/web/postcss.config.mjs',
      'apps/web/next-env.d.ts',
      'apps/web/app/globals.css',
      'apps/web/i18n/index.ts',
      'apps/web/i18n/locales/en/common.json',
      'apps/web/i18n/locales/en/home-route.json',
      'apps/web/i18n/locales/en/news-route.json',
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
  const featureInput: ArchitectureInputV1 = {
    ...INPUT,
    modules: [
      ...INPUT.modules,
      { id: 'contact-section', name: 'Contact Section', kind: 'feature' },
    ],
  };

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
    }, featureInput);
    assert.equal(compiled.profile.profileId, 'next-app');
    assert.equal(compiled.modules.find((module) => module.id === 'app-shell')?.output, 'apps/web/app/layout.tsx');
    assert.equal(compiled.modules.find((module) => module.id === 'news')?.output, 'apps/web/app/news/page.tsx');
    assert.equal(
      compiled.modules.find((module) => module.id === 'contact-section')?.output,
      'apps/web/features/contact-section/index.tsx',
    );
    assert.ok(compiled.allowedOutputs.includes('apps/web/i18n/locales/en/common.json'));
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
    }, featureInput);
    assert.equal(compiled.profile.profileId, 'nuxt');
    assert.equal(compiled.modules.find((module) => module.id === 'app-shell')?.output, 'apps/web/ui/app/app.vue');
    assert.equal(compiled.modules.find((module) => module.id === 'news')?.output, 'apps/web/ui/app/pages/news.vue');
    assert.equal(
      compiled.modules.find((module) => module.id === 'contact-section')?.output,
      'apps/web/ui/app/features/contact-section/index.vue',
    );
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
    }, featureInput);
    assert.equal(compiled.profile.router, 'inertia-react-router');
    // CHANGED (every path was prefixed `apps/web/`): unlike the two cases above,
    // whose apps already live at `apps/web`, this Laravel app is on disk AT THE
    // ROOT — composer.json, `resources/js/app.tsx` — and it keeps that root. The
    // Inertia conventions this case exists for (router, Pages/, Features/, the
    // i18n home under the JS root) are unchanged.
    assert.ok(compiled.allowedOutputs.includes('resources/js/i18n/locales/en/common.json'));
    assert.equal(compiled.modules.find((module) => module.id === 'app-shell')?.output, 'resources/js/app.tsx');
    assert.equal(compiled.modules.find((module) => module.id === 'news')?.output, 'resources/js/Pages/News.tsx');
    assert.equal(
      compiled.modules.find((module) => module.id === 'contact-section')?.output,
      'resources/js/Features/contact-section/index.tsx',
    );
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

test('assignments give features their directory and flat kinds every allowed variant', () => {
  withProject((cwd) => {
    const inputPath = architectureInputPath(cwd, 'R');
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(inputPath, JSON.stringify({
      ...INPUT,
      modules: [
        ...INPUT.modules,
        { id: 'contact-section', name: 'Contact Section', kind: 'feature' },
      ],
    }));
    const architecture = compileArchitectureForRun(cwd, 'R', REACT_STATE);
    const verification = compileVerificationContract(cwd, 'R', REACT_STATE, architecture, {
      changedPaths: [],
    });
    const published = publishRuntimeAssignments(cwd, architecture, verification.contractHash);
    const frontend = published.assignments.find((entry) => entry.role === 'senior-frontend');
    assert.ok(frontend);
    // Folder-shaped kind: the DIRECTORY is the scope literal (matchesScope
    // treats it as exact-or-directory-prefix), never the single default file.
    assert.ok(frontend.scope.include.includes('apps/web/src/features/contact-section'));
    assert.equal(
      frontend.scope.include.includes('apps/web/src/features/contact-section/index.tsx'),
      false,
    );
    for (const variant of ['index.tsx', 'index.ts']) {
      assert.ok(
        matchesScope(`apps/web/src/features/contact-section/${variant}`, frontend.scope),
        `feature ${variant} must be writable via the directory literal`,
      );
    }
    // Flat kind: every allowed-extension variant is a literal.
    const home = architecture.modules.find((module) => module.id === 'home');
    assert.ok(home?.outputBase);
    for (const variant of moduleOutputVariants(home!)) {
      assert.ok(frontend.scope.include.includes(variant), variant);
    }
    // The published manifest revalidates deterministically with the new shape.
    assert.equal(readRuntimeAssignments(cwd, 'R')?.assignmentsHash, published.assignmentsHash);
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

test('scan skip covers every ecosystem dependency root plus host config', () => {
  // Each of these blocked or nearly blocked a real run. `vendor` is the Laravel
  // incident (8,569 files hashed into the baseline); `.claude` is the plugin's
  // own host-permission file blocking all QA settlement.
  for (const skipped of [
    'vendor/autoload.php', 'vendor/github.com/x/y.go',
    '.claude/settings.local.json', '.cursor/rules/x.md', '.codex/config.toml',
    '.vscode/settings.json', '.idea/workspace.xml',
    '__pycache__/mod.cpython-312.pyc', '.venv/lib/python3.12/site.py', 'venv/bin/activate',
    '.pytest_cache/v/cache/lastfailed', '.mypy_cache/3.12/x.json', '.tox/py312/log',
    'target/debug/app', '.gradle/caches/x.bin', '.dart_tool/package_config.json',
    '.bundle/config', '_build/dev/lib/app.beam', 'deps/phoenix/mix.exs',
    'obj/Debug/app.dll', 'Pods/Manifest.lock', 'Carthage/Build/x',
    '.stack-work/dist/x', '.terraform/providers/x',
    '.svelte-kit/generated/root.svelte', '.astro/types.d.ts', '.output/server/index.mjs',
    '.vite/deps/react.js', 'composer.lock', 'Cargo.lock', 'poetry.lock', 'uv.lock',
    'apps/web/tsconfig.tsbuildinfo', 'Thumbs.db',
  ]) {
    assert.equal(isScanSkippedPath(skipped), true, `expected skip: ${skipped}`);
  }

  // Real source must stay visible — over-skipping would HIDE changes, which is
  // worse than the stray path the skip exists for. `bin` and `lib` are source
  // directory names in enough ecosystems to stay off the list.
  for (const kept of [
    'src/main.ts', 'app/Models/User.php', 'cmd/server/main.go', 'lib/util.rb',
    'bin/console', 'internal/api/handler.go', 'packages/ui/src/Button.tsx',
    'resources/views/home.blade.php', 'supabase/migrations/0001_init.sql',
  ]) {
    assert.equal(isScanSkippedPath(kept), false, `expected keep: ${kept}`);
  }
});

test('a file-manifest baseline honours the project gitignore and agrees with the git side', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-baseline-ignore-'));
  try {
    // `git init` with no commit is the greenfield shape: `gitHead()` finds no
    // sha so capture takes the file-manifest walk, while `git ls-files` still
    // answers ignore questions.
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'secrets/\nbuild-cache.txt\n');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# ctx\n');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/main.ts'), 'export const a = 1;\n');
    // Ignored by the project but named in no static skip list.
    fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'secrets/key.pem'), 'x\n');
    fs.writeFileSync(path.join(dir, 'build-cache.txt'), 'x\n');
    // Covered by the static list, so it must be skipped with or without git.
    fs.mkdirSync(path.join(dir, 'vendor/pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor/pkg/autoload.php'), '<?php\n');

    const baseline = captureArchitectureBaseline(dir, {} as never);
    assert.equal(baseline.kind, 'file-manifest');
    const captured = (baseline.files || []).map((entry) => entry.path).sort();
    assert.deepEqual(captured, ['.gitignore', 'AGENTS.md', 'src/main.ts']);

    // The predicate a scan builds must agree with the static one on static
    // names and additionally cover whatever the project ignores.
    const skipped = scanSkipPredicate(dir);
    assert.equal(skipped('secrets/key.pem'), true);
    assert.equal(skipped('build-cache.txt'), true);
    assert.equal(skipped('vendor/pkg/autoload.php'), true);
    assert.equal(skipped('src/main.ts'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a gitignore broad enough to hide the project falls back to the static skip list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-baseline-degenerate-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    // `*` makes git report the root itself as ignored. Trusting that would hide
    // every source file — a worse failure than the stray path being skipped.
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/main.ts'), 'export const a = 1;\n');

    const skipped = scanSkipPredicate(dir);
    assert.equal(skipped('src/main.ts'), false);
    assert.equal(skipped('node_modules/react/index.js'), true);

    const baseline = captureArchitectureBaseline(dir, {} as never);
    const captured = (baseline.files || []).map((entry) => entry.path);
    assert.ok(captured.includes('src/main.ts'), 'source must survive a degenerate ignore rule');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scan skip works outside a work tree, where git cannot be consulted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-baseline-nogit-'));
  try {
    fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n');
    fs.mkdirSync(path.join(dir, 'vendor/x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor/x/y.go'), 'package x\n');

    const baseline = captureArchitectureBaseline(dir, {} as never);
    assert.equal(baseline.kind, 'file-manifest');
    assert.deepEqual((baseline.files || []).map((entry) => entry.path), ['main.go']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the quality toolchain is compiled per stack and seeded before implementers run', () => {
  withProject((cwd) => {
    // Web stack: prettier makes collapsed source impossible and eslint owns the
    // size and boundary rules that used to be regex heuristics in the write gate.
    const web = compileArchitecture(cwd, 'R', REACT_STATE, INPUT);
    const webPaths = (web.scaffoldOutputs || []).map((output) => output.path);
    for (const expected of ['eslint.config.js', '.prettierrc', '.prettierignore']) {
      assert.ok(webPaths.includes(expected), `web stack must scaffold ${expected}`);
    }

    // Seeding happens from the compiled outputs, so the configs exist on disk the
    // moment the architecture is compiled — i.e. at PLAN_READY, before any
    // implementer writes a line.
    const written = ensureScaffoldContent(cwd, web.scaffoldOutputs || [], web.profile);
    assert.ok(written.includes('eslint.config.js'));
    const eslintBody = fs.readFileSync(path.join(cwd, 'eslint.config.js'), 'utf8');
    assert.match(eslintBody, /max-lines/, 'the retired STRUCT_MODULE_LOC budget must live here now');
    assert.match(eslintBody, /no-restricted-imports/, 'page/layer boundaries must be expressed as import rules');
    const prettierBody = fs.readFileSync(path.join(cwd, '.prettierrc'), 'utf8');
    assert.match(prettierBody, /printWidth/);
  });
});

// Coverage proof for the retired lexical Phase-5 layer: every bug class the
// removed createElement/i18n scanners caught must be owned by the compiled AST
// lint layer. This repo does not install the plugins (the hook runtime is
// dependency-free), so these assert the compiled config CONTAINS the rules;
// the behavioral fixtures live in `src/test-environment/lint-corpus.md`,
// marked for Part-7 corpus verification against a real install.
test('React-family scaffolds the AST i18n lint layer with matching devDependencies', () => {
  withProject((cwd) => {
    const web = compileArchitecture(cwd, 'R', REACT_STATE, INPUT);
    assert.equal(uiAstLintLayer(web.profile), 'react-i18next');
    const written = ensureScaffoldContent(cwd, web.scaffoldOutputs || [], web.profile);
    assert.ok(written.includes('eslint.config.js'));
    const eslintBody = fs.readFileSync(path.join(cwd, 'eslint.config.js'), 'utf8');
    // `mode: 'all'` is what covers copy handed to createElement() calls — the
    // shape the retired lexical parity tests exercised — as well as JSX text
    // inside ternaries, `&&` branches, and `.map()` callbacks (13co).
    assert.match(eslintBody, /i18next\/no-literal-string/);
    assert.match(eslintBody, /mode: 'all'/);
    // One files-glob covers every workspace package: coverage is structural,
    // never per-package opt-in (13co: "ESLint … ignores this package").
    assert.match(eslintBody, /files: \['\*\*\/\*\.\{js,jsx,mjs,cjs,ts,tsx\}'\]/);

    // The config imports real plugins, so the tooling manifest is seeded with
    // the matching devDependencies and the lint scripts — or `npm run lint`
    // would be broken on arrival.
    assert.ok(written.includes('package.json'));
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(manifest.scripts.lint, 'eslint .');
    assert.ok((manifest.scripts['lint:css'] || '').includes('stylelint'));
    for (const dependency of [
      'eslint', 'eslint-plugin-i18next', 'typescript-eslint', 'stylelint', 'stylelint-config-standard', 'prettier',
    ]) {
      assert.ok(manifest.devDependencies[dependency], `manifest must seed ${dependency}`);
    }

    // CSS through the community parser (13co: a 424-char one-line @theme block
    // was invisible to every lexical gate), with the Tailwind at-rules the
    // stack itself selects carved out so the standard config never false-denies.
    assert.ok(written.includes('.stylelintrc.json'));
    const stylelintBody = fs.readFileSync(path.join(cwd, '.stylelintrc.json'), 'utf8');
    assert.match(stylelintBody, /stylelint-config-standard/);
    assert.match(stylelintBody, /"theme"/);

    // Idempotence contract unchanged: a non-empty agent-authored manifest is
    // never overwritten.
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"private":true}\n');
    const again = ensureScaffoldContent(cwd, web.scaffoldOutputs || [], web.profile);
    assert.ok(!again.includes('package.json'));
    assert.equal(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'), '{"private":true}\n');
  });
});

test('Vue/Nuxt scaffold the vue-i18n AST layer; Svelte/Astro stay on the dependency-free config', () => {
  withProject((cwd) => {
    const vue = compileArchitecture(cwd, 'R', { ...REACT_STATE, frontend: 'vue', backend: 'none' }, INPUT);
    assert.equal(uiAstLintLayer(vue.profile), 'vue-i18n');
    ensureScaffoldContent(cwd, vue.scaffoldOutputs || [], vue.profile);
    const config = (vue.scaffoldOutputs || [])
      .map((output) => output.path)
      .find((output) => output.endsWith('eslint.config.js'))!;
    const body = fs.readFileSync(path.join(cwd, config), 'utf8');
    assert.match(body, /@intlify\/vue-i18n\/no-raw-text/);
    const manifestPath = path.posix.join(path.posix.dirname(config), 'package.json');
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, manifestPath), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    assert.ok(manifest.devDependencies['@intlify/eslint-plugin-vue-i18n']);
    assert.ok(manifest.devDependencies['vue-eslint-parser']);
  });
  // No mature AST no-raw-text equivalent exists for Svelte/Astro, so those
  // profiles keep the dependency-free config AND the blocking lexical scanner
  // (asserted in integration-findings.test.ts) — no coverage gap.
  withProject((cwd) => {
    const svelte = compileArchitecture(cwd, 'R', { ...REACT_STATE, frontend: 'svelte', backend: 'none' }, INPUT);
    assert.equal(uiAstLintLayer(svelte.profile), null);
    ensureScaffoldContent(cwd, svelte.scaffoldOutputs || [], svelte.profile);
    const config = (svelte.scaffoldOutputs || [])
      .map((output) => output.path)
      .find((output) => output.endsWith('eslint.config.js'))!;
    const body = fs.readFileSync(path.join(cwd, config), 'utf8');
    assert.match(body, /Dependency-free by design/);
    assert.ok(!body.includes('import '), 'no plugin imports without seeded dependencies');
  });
});

test('non-npm backends get their own formatter and linter config', () => {
  for (const [backend, expected] of [
    ['python', 'ruff.toml'],
    ['go', '.golangci.yml'],
    ['rust', 'rustfmt.toml'],
  ] as Array<[string, string]>) {
    withProject((cwd) => {
      const state = {
        mode: 'new-project',
        stack: 'custom-stack',
        frontend: 'none',
        backend,
        mobile: { framework: 'none' },
      };
      const architecture = compileArchitecture(cwd, 'R', state, SERVICE_INPUT);
      const paths = (architecture.scaffoldOutputs || []).map((output) => output.path);
      assert.ok(paths.includes(expected), `${backend} must scaffold ${expected}`);
      const written = ensureScaffoldContent(cwd, architecture.scaffoldOutputs || []);
      assert.ok(written.includes(expected), `${expected} must be seeded with canonical content`);
      if (backend === 'go') {
        // Seeding a syntactically valid but semantically dead config must not
        // pass. golangci-lint v2 validates against a schema with
        // `additionalProperties: false`, so the v1 top-level `linters-settings`
        // key does not soften the bar — it terminates the run outright
        // ("additional properties 'linters-settings' not allowed", reproduced on
        // 2.12.2). The negative row is the load-bearing half of this pair.
        const body = fs.readFileSync(path.join(cwd, expected), 'utf8');
        assert.match(body, /^linters:\n(?:.*\n)*? {2}settings:\n {4}funlen:$/m, 'funlen must sit under linters.settings');
        assert.doesNotMatch(body, /^linters-settings:/m, 'the v1 top-level key makes golangci-lint v2 refuse to run');
      }
    });
  }
});

test('.gitignore is written from the shared skip authority, keeping digests', () => {
  withProject((cwd) => {
    const architecture = compileArchitecture(cwd, 'R', REACT_STATE, INPUT);
    const paths = (architecture.scaffoldOutputs || []).map((output) => output.path);
    assert.ok(paths.includes('.gitignore'));
    ensureScaffoldContent(cwd, architecture.scaffoldOutputs || []);
    const body = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    // Ignoring what the verifier already skips is the whole point: the two lists
    // cannot drift because they come from the same authority.
    for (const expected of ['node_modules/', 'vendor/', '__pycache__/', 'target/', '.claude/']) {
      assert.ok(body.includes(expected), `.gitignore must cover ${expected}`);
    }
    // The prose this replaces was inverted — it omitted `runs/` (the real churn)
    // and named `digests/` (the handoff record worth committing).
    assert.ok(body.includes('.traffic-one/runs/'));
    assert.ok(body.includes('.traffic-one/reports/'));
    // Precondition for the decision-log work item: retention.ts sweeps
    // `.traffic-one/debug/*` directly, and `.traffic-one/runs/<id>/debug/*`
    // transitively — a directory pattern ignores everything beneath it — so
    // only the project-level line needs to exist here.
    assert.ok(body.includes('.traffic-one/debug/'));
    assert.ok(!body.includes('.traffic-one/digests/'), 'digests must stay committed');
    assert.ok(body.includes('!.env.example'));

    // Git semantics are not verifier semantics. Observed 10co: a bare
    // `.traffic-one/` line shadowed the explicit run-state rules above (git
    // never descends into an ignored directory), so `rules/`, `skills/`,
    // `digests/` and `.one.json` were all ignored while the committed
    // AGENTS.md kept pointing at them. Asserting the absence of the digests
    // substring is not enough — the parent rule must be gone too.
    const lines = body.split('\n').map((line) => line.trim());
    assert.ok(!lines.includes('.traffic-one/'), 'the .traffic-one tree must stay committed');
    for (const tracked of ['.traffic-one/rules/', '.traffic-one/skills/', '.traffic-one/.one.json']) {
      assert.ok(!lines.includes(tracked), `${tracked} must stay committed`);
    }
    // A project that does not commit its lockfile cannot reproduce its install.
    for (const lockfile of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'composer.lock']) {
      assert.ok(!lines.includes(lockfile), `${lockfile} must stay committed`);
    }
    // OS droppings are the one part of SKIP_FILES git should still ignore.
    assert.ok(lines.includes('.DS_Store'));
  });
});

// A web-surface PROFILE described the project; role scope was assigned from it
// as if it described the RUN. So a service-only plan in a web project handed
// senior-frontend the `.tsx` entrypoint and senior-tester a browser smoke spec —
// neither of which the plan calls for — and both classify ABOVE the plan's own
// nonvisual floor (`.tsx` visual, a `.ts` spec behavioral). A role that writes
// what it was given then raises its own run into an impact class requiring
// `playwright-local`, which a machine with no Chromium cannot produce: the run
// cannot settle, on evidence the run manufactured for itself.
test('a plan with no UI gets neither the web entrypoint nor a browser smoke in scope', () => {
  const WEB_STATE = {
    mode: 'existing-codebase',
    stack: 'custom-frontend',
    frontend: 'react-vite',
    backend: 'none',
    mobile: { framework: 'none' },
  };
  const seedWebApp = (cwd: string): void => {
    fs.mkdirSync(path.join(cwd, 'web/src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'web/package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'web/src/main.tsx'), 'export {};\n');
  };
  const scopeFor = (
    assignments: ReturnType<typeof buildRuntimeAssignments>,
    role: string,
  ): string[] => (
    assignments.assignments.find((entry) => entry.role === role)?.scope.include || []
  );

  withProject((cwd) => {
    seedWebApp(cwd);
    const compiled = compileArchitecture(cwd, 'R', WEB_STATE, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'sync-service', name: 'Sync Service', kind: 'service' }],
    });
    // The project HAS a web surface — this is not a backend-only profile, which
    // is what makes the run-scoped question the only one that separates them.
    assert.ok(compiled.profile.surfaces.includes('web-ui'));
    assert.deepEqual(compiled.entrypoints, ['web/src/main.tsx']);

    const paths = (compiled.scaffoldOutputs || []).map((output) => output.path);
    assert.ok(!paths.includes('tests/e2e/smoke.spec.ts'));
    // The unit runner config stays: every plan compiles unit tests, and without a
    // config the tester improvises a parallel harness (2cu).
    assert.ok(paths.includes('vitest.config.ts'));

    const assignments = buildRuntimeAssignments(compiled, 'vhash');
    assert.ok(!scopeFor(assignments, 'senior-frontend').includes('web/src/main.tsx'));
    assert.ok(!scopeFor(assignments, 'senior-tester').includes('tests/e2e/smoke.spec.ts'));

    // The invariant behind both: no path granted because the PROJECT has a web
    // surface — as opposed to a variant of a module this plan actually asked for
    // — may carry the run above the nonvisual floor the plan declares.
    const verification = compileVerificationContract(cwd, 'R', WEB_STATE, compiled);
    assert.equal(verification.uiImpact, 'nonvisual');
    assert.equal(verification.browserRequired, false);

    // Asserted over the WHOLE scope now. This loop used to run over the
    // profile-granted paths only, because the plan's own unit test
    // (`tests/sync-service.test.ts`) also derived `behavioral`: deriveUiImpact
    // read any `.ts` outside its nonvisual path list that way, while
    // plannedUiImpactFloor deliberately skips tester-owned outputs. That
    // asymmetry was a defect in the classifier rather than in scope assignment
    // and is now closed — non-recognition no longer raises impact — so the
    // invariant can be enforced where it was always meant to apply.
    //
    // The plan's own modules are the stated exception and are excluded: a role
    // that writes `SyncService` as `.tsx` escalates its run, but that is the plan
    // asking for a variant of its own module, not the profile handing out a path.
    const plannedModuleVariants = new Set(compiled.modules.flatMap(moduleOutputVariants));
    const anyRoleMayWrite = [...new Set(
      assignments.assignments.flatMap((entry) => entry.scope.include),
    )].filter((candidate) => !plannedModuleVariants.has(candidate));
    assert.ok(anyRoleMayWrite.length > 0, 'fixture guard: the nonvisual plan grants a writable scope');
    for (const candidate of anyRoleMayWrite) {
      const derived = deriveUiImpact(cwd, compiled.profile, [candidate]);
      assert.ok(
        !browserRequired(derived.impact),
        `${candidate} derives ${derived.impact} yet a role may write it on a nonvisual plan`,
      );
    }
  });

  // A plan that DOES hold UI keeps both: the entrypoint is where a new shell is
  // mounted, and the smoke spec is the browser evidence such a plan owes.
  withProject((cwd) => {
    seedWebApp(cwd);
    const compiled = compileArchitecture(cwd, 'R', WEB_STATE, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
      ],
    });
    const paths = (compiled.scaffoldOutputs || []).map((output) => output.path);
    assert.ok(paths.includes('tests/e2e/smoke.spec.ts'));
    const assignments = buildRuntimeAssignments(compiled, 'vhash');
    assert.ok(scopeFor(assignments, 'senior-frontend').includes('web/src/main.tsx'));
    assert.ok(scopeFor(assignments, 'senior-tester').includes('tests/e2e/smoke.spec.ts'));
    assert.equal(compileVerificationContract(cwd, 'R', WEB_STATE, compiled).browserRequired, true);
  });

  // A feature-only plan is behavioral, so it owes browser evidence too and the
  // smoke spec is real work — the gate is "plans UI", not "plans a page".
  withProject((cwd) => {
    seedWebApp(cwd);
    const compiled = compileArchitecture(cwd, 'R', WEB_STATE, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'contact-section', name: 'Contact Section', kind: 'feature' }],
    });
    const paths = (compiled.scaffoldOutputs || []).map((output) => output.path);
    assert.ok(paths.includes('tests/e2e/smoke.spec.ts'));
    assert.ok(
      buildRuntimeAssignments(compiled, 'vhash')
        .assignments.find((entry) => entry.role === 'senior-frontend')
        ?.scope.include.includes('web/src/main.tsx'),
    );
  });
});
