import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPatchTargetPaths,
  commandAppearsToWriteFeatureSource,
  FEATURE_SOURCE_RE,
  isTestScopePath,
  roleCanWriteFeatureSource,
  shellWriteTargetsStateDir,
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
  assert.equal(commandAppearsToWriteFeatureSource('mkdir -p packages/ui/src'), false);
  assert.equal(commandAppearsToWriteFeatureSource('cat apps/web/src/x.ts 2>&1'), false);
  // write primitive but no feature path
  assert.equal(commandAppearsToWriteFeatureSource('echo hi > README.md'), false);
  // feature path but no write primitive
  assert.equal(commandAppearsToWriteFeatureSource('cat apps/web/src/x.ts'), false);
  assert.equal(commandAppearsToWriteFeatureSource(''), false);
  assert.equal(commandAppearsToWriteFeatureSource(undefined), false);
});

test('bare interpreter reads are not writes; eval writes still are (B5)', () => {
  // read-only inspection commands that previously false-positived
  assert.equal(commandAppearsToWriteFeatureSource(
    'python3 -c "import json;print(sorted(json.load(open(\'apps/web/src/locales/en.json\'))))"'), false);
  assert.equal(commandAppearsToWriteFeatureSource(
    'echo "=== en/common.json ===" && cat packages/i18n/src/locales/en/common.json'), false);
  assert.equal(commandAppearsToWriteFeatureSource('node --version && ls src/'), false);
  assert.equal(commandAppearsToWriteFeatureSource('node -e "console.log(require(\'./src/config.ts\'))"'), false);
  // interpreter eval writes remain gated
  assert.equal(commandAppearsToWriteFeatureSource(
    'python3 -c "open(\'src/x.ts\',\'w\').write(\'x\')"'), true);
  assert.equal(commandAppearsToWriteFeatureSource(
    'node -e "require(\'fs\').writeFileSync(\'src/x.ts\',\'x\')"'), true);
  assert.equal(commandAppearsToWriteFeatureSource(
    'perl -e "open(FH,\'>\',\'src/x.ts\')"'), true);
  // redirected interpreter output still gated via the redirect primitive
  assert.equal(commandAppearsToWriteFeatureSource('python3 gen.py > src/out.ts'), true);
});

test('shellWriteTargetsStateDir carves out run-state heredocs only', () => {
  // reviewer digest heredoc whose body cites feature paths
  assert.equal(shellWriteTargetsStateDir(
    "mkdir -p .traffic-one/digests/123 && cat > .traffic-one/digests/123/reviewer.md <<'EOF'\n## Touched\n- apps/web/src/features/courses/catalog.tsx\nEOF"), true);
  // orchestrator fix-cycle note
  assert.equal(shellWriteTargetsStateDir(
    "cat > .traffic-one/fix-cycles/123/senior-frontend-fix-1.md <<'EOF'\nfix src/app.ts\nEOF"), true);
  assert.equal(shellWriteTargetsStateDir('echo done >> ./.traffic-one/runs/123/log.txt'), true);
  // feature-source targets are never carved out
  assert.equal(shellWriteTargetsStateDir('cat > apps/web/src/x.ts <<EOF\nx\nEOF'), false);
  // mixed state-dir + feature target -> no carve-out
  assert.equal(shellWriteTargetsStateDir(
    'cat > .traffic-one/digests/123/r.md <<EOF\nx\nEOF\ncat > src/x.ts <<EOF\ny\nEOF'), false);
  // other write primitive classes disable the carve-out entirely
  assert.equal(shellWriteTargetsStateDir(
    'rm apps/web/src/x.ts && cat > .traffic-one/digests/123/r.md <<EOF\nx\nEOF'), false);
  assert.equal(shellWriteTargetsStateDir(
    'sed -i s/a/b/ src/x.ts > .traffic-one/runs/123/log.txt'), false);
  // plan.md is intentionally not carved out
  assert.equal(shellWriteTargetsStateDir('cat > .traffic-one/plan.md <<EOF\nplan\nEOF'), false);
  // no write target at all
  assert.equal(shellWriteTargetsStateDir('cat .traffic-one/digests/123/reviewer.md'), false);
  assert.equal(shellWriteTargetsStateDir(''), false);
  assert.equal(shellWriteTargetsStateDir(undefined), false);
});

test('isTestScopePath classifies test files and conventional test dirs', () => {
  assert.equal(isTestScopePath('apps/web/src/services/courses.test.ts'), true);
  assert.equal(isTestScopePath('src/components/Button.spec.tsx'), true);
  assert.equal(isTestScopePath('packages/ui/src/__tests__/btn.ts'), true);
  assert.equal(isTestScopePath('tests/i18n-integration.test.ts'), true);
  assert.equal(isTestScopePath('e2e/checkout.ts'), true);
  assert.equal(isTestScopePath('src/test/java/FooTest.java'), true);
  assert.equal(isTestScopePath('./tests/setup.ts'), true);
  assert.equal(isTestScopePath('apps/web/src/services/courses.ts'), false);
  assert.equal(isTestScopePath('src/latest/x.ts'), false);
  assert.equal(isTestScopePath('src/test-utils/render.tsx'), false);
  assert.equal(isTestScopePath(''), false);
  assert.equal(isTestScopePath(undefined), false);
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
