import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  globToRegExp,
  matchesPattern,
  matchesScope,
  normalizeRelPath,
  scopesOverlap,
  type AssignedScope,
} from '../scope';

test('normalizeRelPath converts backslashes and strips leading ./', () => {
  assert.equal(normalizeRelPath('src\\app\\page.tsx'), 'src/app/page.tsx');
  assert.equal(normalizeRelPath('./src/x.ts'), 'src/x.ts');
  assert.equal(normalizeRelPath(undefined), '');
});

test('matchesPattern: literal prefix matches dir contents but not sibling prefixes', () => {
  assert.equal(matchesPattern('src/app/page.tsx', 'src/app/'), true);
  assert.equal(matchesPattern('src/app/page.tsx', 'src/app'), true);     // no trailing slash
  assert.equal(matchesPattern('src/application.ts', 'src/app/'), false); // not a sibling-prefix bleed
  assert.equal(matchesPattern('src/application.ts', 'src/app'), false);
  assert.equal(matchesPattern('src/app/(public)/news/page.tsx', 'src/app/'), true); // route-group parens
});

test('matchesPattern: exact file pattern', () => {
  assert.equal(matchesPattern('src/main.ts', 'src/main.ts'), true);
  assert.equal(matchesPattern('src/main.tsx', 'src/main.ts'), false);
});

test('matchesPattern: glob * stays within a segment, ** crosses, ? is one char', () => {
  assert.equal(matchesPattern('app/models.py', '*/models.py'), true);
  assert.equal(matchesPattern('app/sub/models.py', '*/models.py'), false); // * does not cross '/'
  assert.equal(matchesPattern('app/sub/models.py', '**/models.py'), true);  // ** crosses '/'
  assert.equal(matchesPattern('app/migrations/0001.py', '*/migrations/**'), true);
  assert.equal(matchesPattern('a/migrations/x', '?/migrations/x'), true);
  assert.equal(matchesPattern('ab/migrations/x', '?/migrations/x'), false); // ? is exactly one char
});

test('globToRegExp escapes regex metachars and anchors', () => {
  const re = globToRegExp('src/a.b/*');
  assert.equal(re.test('src/a.b/x'), true);
  assert.equal(re.test('src/aXb/x'), false); // '.' is literal, not "any char"
  assert.equal(globToRegExp('src/a.b/*'), re); // memoized -> same instance
});

test('matchesScope: include-only', () => {
  const scope: AssignedScope = { include: ['resources/js/', 'resources/views/'] };
  assert.equal(matchesScope('resources/js/app.vue', scope), true);
  assert.equal(matchesScope('resources/views/home.blade.php', scope), true);
  assert.equal(matchesScope('app/Http/Controller.php', scope), false);
  assert.equal(matchesScope('anything', { include: [] }), false); // empty include owns nothing
});

test('matchesScope: a feature-directory literal covers every extension variant, exactly', () => {
  // Extension freedom relies on this: assignments include a folder-shaped
  // module's DIRECTORY as a plain literal, and matchesScope treats that as
  // exact-or-directory-prefix — so index.tsx AND index.ts (and companions)
  // are writable, while sibling directories sharing the prefix are not.
  const scope: AssignedScope = { include: ['apps/web/src/features/auth'] };
  assert.equal(matchesScope('apps/web/src/features/auth', scope), true);
  assert.equal(matchesScope('apps/web/src/features/auth/index.tsx', scope), true);
  assert.equal(matchesScope('apps/web/src/features/auth/index.ts', scope), true);
  assert.equal(matchesScope('apps/web/src/features/auth/use-auth.ts', scope), true);
  assert.equal(matchesScope('apps/web/src/features/auth-admin/index.tsx', scope), false);
  assert.equal(matchesScope('apps/web/src/features/authx.ts', scope), false);
});

test('matchesScope: include + exclude carve-out (two agents split one subtree)', () => {
  const fe: AssignedScope = { include: ['src/'], exclude: ['src/app/api/', 'src/server/'] };
  const be: AssignedScope = { include: ['src/app/api/', 'src/server/'] };
  assert.equal(matchesScope('src/app/page.tsx', fe), true);
  assert.equal(matchesScope('src/app/api/route.ts', fe), false); // carved out of FE
  assert.equal(matchesScope('src/app/api/route.ts', be), true);  // owned by BE
  assert.equal(matchesScope('src/server/db.ts', fe), false);
});

test('matchesScope: cross-stack patterns (Laravel / Django / Flutter) work without code change', () => {
  const laravelBe: AssignedScope = { include: ['app/Http/', 'app/Models/', 'routes/', 'database/'] };
  assert.equal(matchesScope('app/Http/Controllers/NewsController.php', laravelBe), true);
  assert.equal(matchesScope('database/migrations/2026_create_news.php', laravelBe), true);

  const djangoBe: AssignedScope = { include: ['*/models.py', '*/views.py', '*/migrations/**'] };
  assert.equal(matchesScope('news/models.py', djangoBe), true);
  assert.equal(matchesScope('news/migrations/0001_initial.py', djangoBe), true);

  const flutter: AssignedScope = { include: ['lib/'] };
  assert.equal(matchesScope('lib/screens/home.dart', flutter), true);
});

test('scopesOverlap: disjoint manifests have no overlap, sloppy ones do', () => {
  const fe: AssignedScope = { include: ['src/'], exclude: ['src/app/api/'] };
  const be: AssignedScope = { include: ['src/app/api/'] };
  const probes = ['src/app/page.tsx', 'src/app/api/route.ts', 'src/lib/util.ts'];
  assert.equal(scopesOverlap(fe, be, probes), false);

  const sloppyFe: AssignedScope = { include: ['src/'] };          // forgot to carve out api
  const sloppyBe: AssignedScope = { include: ['src/app/api/'] };
  assert.equal(scopesOverlap(sloppyFe, sloppyBe, probes), true); // src/app/api/route.ts matches both
});
