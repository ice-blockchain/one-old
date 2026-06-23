import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPatchTargetPaths,
  commandAppearsToWriteFeatureSource,
  FEATURE_SOURCE_RE,
  roleCanWriteFeatureSource,
  subagentMayWriteFeatureSource,
} from '../feature-source';

test('FEATURE_SOURCE_RE matches monorepo + flat feature-source layouts', () => {
  assert.equal(FEATURE_SOURCE_RE.test('apps/web/src/main.ts'), true);
  assert.equal(FEATURE_SOURCE_RE.test('apps/mobile/app/index.tsx'), true);
  assert.equal(FEATURE_SOURCE_RE.test('packages/ui/src/button.tsx'), true);
  assert.equal(FEATURE_SOURCE_RE.test('services/api/src/server.ts'), true);
  assert.equal(FEATURE_SOURCE_RE.test('src/app.ts'), true);
  assert.equal(FEATURE_SOURCE_RE.test('README.md'), false);
  assert.equal(FEATURE_SOURCE_RE.test('.traffic-one/plan.md'), false);
});

test('roleCanWriteFeatureSource enforces per-role owned path patterns', () => {
  // senior-frontend owns app UI + flat root UI/SEO/i18n + ui/i18n/utils packages
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'apps/web/src/x.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/app/(public)/news/page.tsx'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/app/sitemap.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/features/news/news-page.tsx'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/i18n/resources.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/lib/seo.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'packages/ui/src/btn.tsx'), true);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'services/api/src/s.ts'), false);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/app/api/join/route.ts'), false);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/services/http.ts'), false);
  assert.equal(roleCanWriteFeatureSource('senior-frontend', 'src/lib/db.ts'), false);
  // senior-backend owns services + api/ws/utils packages + apps/root services/store/API
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'services/api/src/s.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'packages/api-client/src/c.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'apps/web/src/services/x.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'src/app/api/join/route.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'src/services/http.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'src/lib/db.ts'), true);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'packages/ui/src/btn.tsx'), false);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'src/app/(public)/news/page.tsx'), false);
  assert.equal(roleCanWriteFeatureSource('senior-backend', 'src/lib/seo.ts'), false);
  // quick-fix (maintenance worker) owns the union of frontend + backend paths
  assert.equal(roleCanWriteFeatureSource('quick-fix', 'src/app/(public)/news/page.tsx'), true);
  assert.equal(roleCanWriteFeatureSource('quick-fix', 'packages/ui/src/btn.tsx'), true);
  assert.equal(roleCanWriteFeatureSource('quick-fix', 'src/app/api/join/route.ts'), true);
  assert.equal(roleCanWriteFeatureSource('quick-fix', 'services/api/src/s.ts'), true);
  assert.equal(roleCanWriteFeatureSource('quick-fix', 'README.md'), false);
  // unknown role owns nothing
  assert.equal(roleCanWriteFeatureSource('senior-architect', 'apps/web/src/x.ts'), false);
});

test('subagentMayWriteFeatureSource prefers run-claim role, falls back to session role', () => {
  // explicit agent context: only its role's paths
  assert.equal(
    subagentMayWriteFeatureSource({}, 'apps/web/src/x.ts', { source: 's', runId: 'r', role: 'senior-frontend', spawnIndex: 1, sessionId: null, claimId: null }),
    true,
  );
  assert.equal(
    subagentMayWriteFeatureSource({}, 'services/api/src/s.ts', { source: 's', runId: 'r', role: 'senior-frontend', spawnIndex: 1, sessionId: null, claimId: null }),
    false,
  );
  // no context + not a subagent session → denied
  assert.equal(subagentMayWriteFeatureSource({ team: { mode: 'subagents' } }, 'apps/web/src/x.ts', null), false);
  // no context + a valid subagent session (currentRunId + materializedStack === fingerprint)
  // with a top-level activeAgentRole → allowed for any owned role's paths.
  const subState = {
    stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' },
    materializedStack: 'default|react-vite|supabase|none',
    currentRunId: 'run-1', activeAgentRole: 'senior-backend',
  };
  assert.equal(subagentMayWriteFeatureSource(subState, 'services/api/src/s.ts', null), true);
  assert.equal(subagentMayWriteFeatureSource(subState, 'apps/web/src/x.ts', null), true); // frontend fallback
});

test('commandAppearsToWriteFeatureSource needs both a write primitive and a feature path', () => {
  assert.equal(commandAppearsToWriteFeatureSource('echo hi > apps/web/src/x.ts'), true);
  assert.equal(commandAppearsToWriteFeatureSource('cat <<EOF > src/app.ts'), true);
  assert.equal(commandAppearsToWriteFeatureSource('sed -i s/a/b/ packages/ui/src/x.ts'), true);
  assert.equal(commandAppearsToWriteFeatureSource("find /tmp/project/apps/web/src -name '*.js' -delete"), true);
  assert.equal(commandAppearsToWriteFeatureSource('rm -f apps/web/src/stale.js'), true);
  assert.equal(commandAppearsToWriteFeatureSource('cat apps/web/src/x.ts 2>&1'), false);
  // write primitive but no feature path
  assert.equal(commandAppearsToWriteFeatureSource('echo hi > README.md'), false);
  // feature path but no write primitive
  assert.equal(commandAppearsToWriteFeatureSource('cat apps/web/src/x.ts'), false);
  assert.equal(commandAppearsToWriteFeatureSource(''), false);
  assert.equal(commandAppearsToWriteFeatureSource(undefined), false);
});

test('applyPatchTargetPaths extracts Add/Update/Delete/Move targets, normalized', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: ./apps/web/src/new.ts',
    '+const x = 1;',
    '*** Update File: packages\\ui\\src\\btn.tsx',
    '*** Delete File: src/old.ts',
    '*** Move to: src/moved.ts',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(applyPatchTargetPaths(patch), [
    'apps/web/src/new.ts',
    'packages/ui/src/btn.tsx',
    'src/old.ts',
    'src/moved.ts',
  ]);
  assert.deepEqual(applyPatchTargetPaths(''), []);
  assert.deepEqual(applyPatchTargetPaths(undefined), []);
});
