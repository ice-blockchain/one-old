// The PLAN_READY satisfiability sweep: a compiled contract that demands a file
// its own write gates deny must fail compile with `contract-self-conflict`
// naming both sides — and every canonical profile compile must pass the sweep
// (the actual invariant). See plan-readiness/satisfiability.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildRuntimeAssignments,
  compileArchitecture,
  ensureScaffoldContent,
  moduleSkeletonContent,
  scaffoldFileContent,
  type ArchitectureInputV1,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import { analyzeI18nSourceText } from '../../../shared/i18n-enforcement';
import {
  contractSelfConflictFallback,
  contractSelfConflictSummary,
  contractSelfConflicts,
} from '../plan-readiness/satisfiability';
import { noImplementerRoleFallback } from '../plan-readiness/checks';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-satisfiability-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

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
    { id: 'nav-bar', name: 'Nav Bar', kind: 'component' },
    { id: 'catalog', name: 'Course Catalog', kind: 'feature' },
    { id: 'sync-service', name: 'Sync Service', kind: 'service' },
  ],
};

const SERVICE_INPUT: ArchitectureInputV1 = {
  schemaVersion: 1,
  routes: [],
  modules: [{ id: 'sync-service', name: 'Sync Service', kind: 'service' }],
};

const DEFAULT_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

function compiledWithAssignments(
  cwd: string,
  runId: string,
  state: Record<string, unknown>,
  input: ArchitectureInputV1,
): { compiled: CompiledArchitectureV1; assignments: ReturnType<typeof buildRuntimeAssignments> } {
  const compiled = compileArchitecture(cwd, runId, state, input);
  return { compiled, assignments: buildRuntimeAssignments(compiled, 'verification-hash') };
}

test('a scaffold whose canonical content trips a blocking gate is a contract self-conflict naming both sides', () => {
  withProject((cwd) => {
    const { compiled, assignments } = compiledWithAssignments(cwd, 'R', DEFAULT_STATE, INPUT);
    // Synthetic canonical content: rendered body copy in the mandatory entry
    // html — the 13co shape, but OUTSIDE the pre-boot metadata carve-out, so
    // the same scanner an implementer faces must still deny it.
    const conflicts = contractSelfConflicts(compiled, assignments, {
      isNative: false,
      enforceI18n: true,
      contentOverrides: {
        'apps/web/index.html': [
          '<!doctype html>',
          '<html lang="en">',
          '  <body>',
          '    <h1>Welcome to the platform</h1>',
          '    <div id="root"></div>',
          '  </body>',
          '</html>',
        ].join('\n'),
      },
    });
    const copy = conflicts.find((conflict) => conflict.gate === 'STRUCT_HARDCODED_COPY');
    assert.ok(copy, `expected STRUCT_HARDCODED_COPY, got: ${JSON.stringify(conflicts)}`);
    assert.equal(copy!.output, 'apps/web/index.html');
    // The deny names BOTH sides: the demanding output and the forbidding gate.
    const summary = contractSelfConflictSummary(conflicts);
    assert.ok(summary.includes('apps/web/index.html'));
    assert.ok(summary.includes('STRUCT_HARDCODED_COPY'));
    const fallback = contractSelfConflictFallback(summary);
    assert.ok(fallback.includes('Contract satisfiability gate'));
    assert.ok(fallback.includes(summary));
  });
});

test('a demanded module output the write gates deny — or no allowlist covers — is a self-conflict (12co class)', () => {
  withProject((cwd) => {
    const { compiled, assignments } = compiledWithAssignments(cwd, 'R', DEFAULT_STATE, INPUT);
    // Synthetic contract: a mandatory module output that the static plan gate
    // hard-denies by path, and that the (stale) runtime allowlist never covers.
    const conflicted: CompiledArchitectureV1 = {
      ...compiled,
      modules: [
        ...compiled.modules,
        {
          id: 'orders-service',
          name: 'Orders Service',
          kind: 'service',
          ownerRole: 'senior-frontend',
          output: 'apps/web/src/pages/orders.service.ts',
        },
      ],
    };
    const conflicts = contractSelfConflicts(conflicted, assignments, {
      isNative: false,
      enforceI18n: true,
    });
    assert.ok(
      conflicts.some((conflict) => (
        conflict.gate === 'pages-service-files'
        && conflict.output === 'apps/web/src/pages/orders.service.ts'
      )),
      `expected pages-service-files, got: ${JSON.stringify(conflicts)}`,
    );
    assert.ok(
      conflicts.some((conflict) => (
        conflict.gate === 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP'
        && conflict.output === 'apps/web/src/pages/orders.service.ts'
      )),
      'a demanded output covered by no work-unit allowlist is unsatisfiable',
    );
  });
});

test('the vite-react canonical entry html passes the sweep (13co) and its metadata carve-out stays narrow', () => {
  withProject((cwd) => {
    const { compiled, assignments } = compiledWithAssignments(cwd, 'R', DEFAULT_STATE, INPUT);
    const entry = scaffoldFileContent('apps/web/index.html');
    assert.ok(entry && entry.includes('<title>') && entry.includes('<noscript>'),
      'the entry html scaffold must carry canonical pre-boot metadata content');
    assert.deepEqual(
      contractSelfConflicts(compiled, assignments, { isNative: false, enforceI18n: true }),
      [],
      'the canonical vite-react compile must be satisfiable by its own gates',
    );

    // Carve-out precision: pre-boot <title>/<noscript>/<meta> in the ENTRY
    // document are exempt; rendered body copy in the same file is not, and a
    // non-entry html file keeps the strict scanner everywhere.
    assert.deepEqual(
      analyzeI18nSourceText('apps/web/index.html', entry!, compiled.profile, compiled.i18n).findings,
      [],
    );
    const withBodyCopy = entry!.replace('<div id="root"></div>', '<div id="root"></div>\n    <h1>Browse all courses</h1>');
    assert.ok(
      analyzeI18nSourceText('apps/web/index.html', withBodyCopy, compiled.profile, compiled.i18n)
        .findings.some((finding) => finding.id === 'STRUCT_HARDCODED_COPY'),
      'rendered body copy in the entry html stays denied',
    );
    assert.ok(
      analyzeI18nSourceText('apps/web/about.html', '<title>About the product</title>', compiled.profile, compiled.i18n)
        .findings.some((finding) => finding.id === 'STRUCT_HARDCODED_COPY'),
      'non-entry html keeps the strict scanner',
    );
  });
});

test('astro and angular compile owners for the crawl assets the reviewer baseline demands', () => {
  for (const fixture of [
    { frontend: 'astro', profileId: 'astro' },
    { frontend: 'angular', profileId: 'angular' },
  ]) {
    withProject((cwd) => {
      const compiled = compileArchitecture(cwd, `crawl-${fixture.profileId}`, {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: fixture.frontend,
        backend: 'none',
        mobile: { framework: 'none' },
      }, INPUT);
      assert.equal(compiled.profile.profileId, fixture.profileId);
      for (const asset of ['public/robots.txt', 'public/sitemap.xml', 'public/llms.txt', 'public/og-image.png']) {
        const owners = (compiled.scaffoldOutputs || []).filter((output) => output.path === asset);
        assert.equal(owners.length, 1, `${fixture.profileId} must compile exactly one owner for ${asset}`);
        assert.equal(owners[0]!.ownerRole, 'senior-frontend');
      }
    });
  }
});

test('every canonical profile compile is satisfiable by its own write gates (the invariant)', () => {
  const webFixtures: Array<{ frontend: string; profileId: string; setupPaths?: string[] }> = [
    { frontend: 'nextjs', profileId: 'next-app' },
    { frontend: 'nextjs', profileId: 'next-pages', setupPaths: ['apps/web/pages'] },
    { frontend: 'nuxt', profileId: 'nuxt' },
    { frontend: 'vue', profileId: 'vue' },
    { frontend: 'sveltekit', profileId: 'sveltekit' },
    { frontend: 'svelte', profileId: 'svelte' },
    { frontend: 'astro', profileId: 'astro' },
    { frontend: 'angular', profileId: 'angular' },
    { frontend: 'other', profileId: 'generic-web' },
  ];
  for (const fixture of webFixtures) {
    withProject((cwd) => {
      for (const setupPath of fixture.setupPaths || []) {
        fs.mkdirSync(path.join(cwd, setupPath), { recursive: true });
      }
      const { compiled, assignments } = compiledWithAssignments(cwd, `sat-${fixture.profileId}`, {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: fixture.frontend,
        backend: 'none',
        mobile: { framework: 'none' },
      }, INPUT);
      assert.equal(compiled.profile.profileId, fixture.profileId);
      assert.deepEqual(
        contractSelfConflicts(compiled, assignments, { isNative: false, enforceI18n: true }),
        [],
        `${fixture.profileId} canonical compile must be satisfiable`,
      );
    });
  }

  withProject((cwd) => {
    const { compiled, assignments } = compiledWithAssignments(cwd, 'sat-default', DEFAULT_STATE, INPUT);
    assert.deepEqual(
      contractSelfConflicts(compiled, assignments, { isNative: false, enforceI18n: true }),
      [],
      'default vite-react+supabase compile must be satisfiable',
    );
  });

  for (const framework of ['react-native-expo', 'swift-native', 'kotlin-android', 'flutter']) {
    withProject((cwd) => {
      const { compiled, assignments } = compiledWithAssignments(cwd, `sat-${framework}`, {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: 'none',
        backend: 'none',
        mobile: { framework },
      }, INPUT);
      assert.deepEqual(
        contractSelfConflicts(compiled, assignments, { isNative: true, enforceI18n: true }),
        [],
        `${framework} canonical compile must be satisfiable`,
      );
    });
  }

  for (const backend of ['go', 'python']) {
    withProject((cwd) => {
      const { compiled, assignments } = compiledWithAssignments(cwd, `sat-${backend}`, {
        mode: 'new-project',
        stack: 'custom-backend',
        frontend: 'none',
        backend,
        mobile: { framework: 'none' },
      }, SERVICE_INPUT);
      assert.deepEqual(
        contractSelfConflicts(compiled, assignments, { isNative: false, enforceI18n: false }),
        [],
        `${backend} canonical compile must be satisfiable`,
      );
    });
  }

  withProject((cwd) => {
    const { compiled, assignments } = compiledWithAssignments(cwd, 'sat-laravel', {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'laravel-ui',
      backend: 'laravel',
      mobile: { framework: 'none' },
    }, INPUT);
    assert.equal(compiled.profile.profileId, 'server-rendered');
    assert.deepEqual(
      contractSelfConflicts(compiled, assignments, { isNative: false, enforceI18n: true }),
      [],
      'laravel server-rendered canonical compile must be satisfiable',
    );
  });
});

test('the sweep certifies the REAL materialized skeletons: every react/vue UI module has one and it passes every blocking gate', () => {
  // Part 6: models edit, they don't author. The bodies the sweep judges must be
  // the exact bodies ensureScaffoldContent materializes at PLAN_READY — so a
  // zero-conflict sweep here proves the greenfield skeletons themselves are
  // writable under every blocking write gate, not just the empty-module
  // fallback. Asserted explicitly for one React and one Vue profile.
  const fixtures: Array<{ profileId: string; state: Record<string, unknown> }> = [
    { profileId: 'vite-react', state: DEFAULT_STATE },
    {
      profileId: 'vue',
      state: {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: 'vue',
        backend: 'none',
        mobile: { framework: 'none' },
      },
    },
  ];
  for (const fixture of fixtures) {
    withProject((cwd) => {
      const { compiled, assignments } = compiledWithAssignments(
        cwd,
        `skel-${fixture.profileId}`,
        fixture.state,
        INPUT,
      );
      assert.equal(compiled.profile.profileId, fixture.profileId);
      const uiModules = compiled.modules.filter((module) => (
        ['app-shell', 'page', 'component', 'feature'].includes(module.kind)
      ));
      assert.ok(uiModules.length >= 4, 'fixture must exercise every UI kind');
      for (const module of uiModules) {
        assert.ok(
          moduleSkeletonContent(compiled, module),
          `${fixture.profileId} must generate a compliant skeleton for ${module.output}`,
        );
      }

      const written = ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
        compiled,
        newProject: true,
      });
      for (const module of uiModules) {
        assert.ok(written.includes(module.output), `${module.output} must be materialized`);
        assert.equal(
          fs.readFileSync(path.join(cwd, module.output), 'utf8'),
          moduleSkeletonContent(compiled, module),
          'the on-disk skeleton must be byte-identical to the sweep candidate',
        );
      }

      assert.deepEqual(
        contractSelfConflicts(compiled, assignments, { isNative: false, enforceI18n: true }),
        [],
        `${fixture.profileId} skeletons must pass every blocking write gate`,
      );
    });
  }
});

test('the contract-self-conflict deny prose renders from its own T1BLOCK', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8');
  const begin = '<!-- T1BLOCK:BEGIN contract-self-conflict -->';
  const end = '<!-- T1BLOCK:END contract-self-conflict -->';
  const beginAt = skill.indexOf(begin);
  const endAt = skill.indexOf(end);
  assert.ok(beginAt >= 0 && endAt > beginAt, 'missing T1BLOCK contract-self-conflict');
  const rendered = skill.slice(beginAt + begin.length, endAt).trim()
    .split('{{CONFLICTS}}').join('SAMPLE');
  assert.equal(rendered, contractSelfConflictFallback('SAMPLE'),
    'contract-self-conflict prose/fallback drift');
});

test('the capability-no-implementer deny prose renders from its own T1BLOCK', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8');
  const begin = '<!-- T1BLOCK:BEGIN capability-no-implementer-gate -->';
  const end = '<!-- T1BLOCK:END capability-no-implementer-gate -->';
  const beginAt = skill.indexOf(begin);
  const endAt = skill.indexOf(end);
  assert.ok(beginAt >= 0 && endAt > beginAt, 'missing T1BLOCK capability-no-implementer-gate');
  const rendered = skill.slice(beginAt + begin.length, endAt).trim()
    .split('{{PROFILE}}').join('SAMPLE')
    .split('{{RUN_ID}}').join('RUNID');
  assert.equal(rendered, noImplementerRoleFallback('SAMPLE', 'RUNID'),
    'capability-no-implementer-gate prose/fallback drift');
});
