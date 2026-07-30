// Unit coverage for the run-sim driver's own pure pieces. The end-to-end
// behaviour is proven by `npm run test:env --category=run-sim`; this guards the
// two places where a silent mistake would make that suite pass for the wrong
// reason: reading the wrong field out of assignments (an empty allowlist means
// "nothing to write", which looks like success), and a content resolver that
// quietly returns null for a path it should author.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CompiledArchitectureV1 } from '../../../shared/architecture-contract';
import { buildImplementContext } from './assignments';
import { sourceFor } from './sources';

function architecture(): CompiledArchitectureV1 {
  return {
    profile: {
      profileId: 'vite-react',
      roles: ['senior-frontend', 'senior-backend'],
      entrypoints: ['apps/web/src/main.tsx'],
    },
    modules: [
      { id: 'app-shell', kind: 'app-shell', name: 'App', output: 'apps/web/src/App.tsx', ownerRole: 'senior-frontend' },
      { id: 'home', kind: 'page', name: 'Home', output: 'apps/web/src/pages/Home.tsx', ownerRole: 'senior-frontend' },
      { id: 'card', kind: 'component', name: 'Card', output: 'apps/web/src/components/Card.tsx', ownerRole: 'senior-frontend' },
      { id: 'auth', kind: 'feature', name: 'Auth', output: 'apps/web/src/features/auth/index.ts', ownerRole: 'senior-frontend' },
      { id: 'api', kind: 'service', name: 'CoursesAPI', output: 'packages/api-client/src/CoursesAPI.ts', ownerRole: 'senior-backend' },
    ],
    routes: [{ id: 'home-route', path: '/', moduleId: 'home', moduleOutput: 'apps/web/src/pages/Home.tsx' }],
  } as unknown as CompiledArchitectureV1;
}

const assignments = {
  assignments: [
    { role: 'senior-frontend', summary: 'ui', scope: { include: ['apps/web/src/App.tsx', 'package.json'] } },
    { role: 'senior-backend', summary: 'api', scope: { include: ['packages/api-client/src/CoursesAPI.ts'] } },
  ],
};

test('buildImplementContext reads the allowlist from scope.include, not a guessed field', () => {
  const ctx = buildImplementContext('R', architecture(), assignments);
  // An empty list here would make phase 2 write nothing and still "succeed".
  assert.deepEqual(ctx.outputsFor('senior-frontend'), ['apps/web/src/App.tsx', 'package.json']);
  assert.deepEqual(ctx.outputsFor('senior-backend'), ['packages/api-client/src/CoursesAPI.ts']);
  assert.deepEqual(ctx.outputsFor('senior-tester'), []);
  assert.deepEqual(ctx.roles().sort(), ['senior-backend', 'senior-frontend']);
});

test('buildImplementContext maps module ids and paths in both directions', () => {
  const ctx = buildImplementContext('R', architecture(), assignments);
  assert.equal(ctx.outputOf('home'), 'apps/web/src/pages/Home.tsx');
  assert.equal(ctx.outputOf('nope'), null);
  assert.equal(ctx.moduleAt('apps/web/src/components/Card.tsx')?.kind, 'component');
  assert.equal(ctx.moduleAt('apps/web/src/nothing.tsx'), null);
});

test('sourceFor authors every planned module kind', () => {
  const ctx = buildImplementContext('R', architecture(), assignments);
  for (const module of architecture().modules) {
    const body = sourceFor(module.output, ctx);
    assert.ok(body, `${module.kind} module ${module.output} must be authored`);
    assert.ok(body!.split('\n').length >= 3, `${module.output} must not be collapsed`);
  }
});

test('the app shell wires planned routes AND feature modules', () => {
  const ctx = buildImplementContext('R', architecture(), assignments);
  const shell = sourceFor('apps/web/src/App.tsx', ctx) || '';
  assert.match(shell, /import Home from/, 'route pages are imported by the shell');
  assert.match(shell, /path="\/"/, 'the compiled route path is used');
  // A feature imported nowhere is STRUCT_ORPHAN_MODULE — dead code, not a
  // deliverable. The shell is where cross-cutting features attach.
  assert.match(shell, /features\/auth/, 'planned feature modules are wired in');
});

test('pages reference the planned components and the API client', () => {
  const ctx = buildImplementContext('R', architecture(), assignments);
  const page = sourceFor('apps/web/src/pages/Home.tsx', ctx) || '';
  assert.match(page, /components\/Card/, 'planned components are referenced');
  assert.match(page, /@app\/api-client/, 'the planned API package is consumed');
});

test('sourceFor declines binaries and crawl assets rather than faking them', () => {
  const ctx = buildImplementContext('R', architecture(), assignments);
  for (const rel of [
    'apps/web/public/favicon.ico',
    'apps/web/public/icons/icon-192.png',
    'apps/web/public/robots.txt',
    'apps/web/public/sitemap.xml',
  ]) {
    assert.equal(sourceFor(rel, ctx), null, `${rel} must not be fabricated`);
  }
});

test('the root manifest declares every tool its scripts name', () => {
  const ctx = buildImplementContext('R', architecture(), assignments);
  const manifest = JSON.parse(sourceFor('package.json', ctx) || '{}') as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  // Each of these is a completion gate: format coverage/parity, typecheck
  // toolchain, and test toolchain (runner + e2e script + lighthouse).
  assert.equal(manifest.scripts['format:check'], 'prettier --check .');
  assert.ok(manifest.scripts['test:e2e']);
  for (const dep of ['prettier', 'typescript', 'vitest', '@playwright/test', 'lighthouse']) {
    assert.ok(manifest.devDependencies[dep], `${dep} must be declared`);
  }
});
