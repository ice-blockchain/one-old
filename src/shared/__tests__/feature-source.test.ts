import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPatchTargetPaths,
  commandAppearsToWriteBuildArtifact,
  commandAppearsToWriteFeatureSource,
  FEATURE_SOURCE_RE,
  isTestInfraConfigPath,
  isTestScopePath,
  roleCanWriteFeatureSource,
  shellAssetImportDest,
  shellTrafficOneWriteTargets,
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
  assert.equal(commandAppearsToWriteFeatureSource('ln -s /tmp/payload apps/web/src/linked'), true);
  assert.equal(commandAppearsToWriteFeatureSource('/bin/ln -s /tmp/payload apps/web/src/linked'), true);
  assert.equal(commandAppearsToWriteFeatureSource('ln /tmp/payload src/linked.ts'), true);
  assert.equal(commandAppearsToWriteFeatureSource('mkdir -p packages/ui/src'), false);
  assert.equal(commandAppearsToWriteFeatureSource('cat apps/web/src/x.ts 2>&1'), false);
  // write primitive but no feature path
  assert.equal(commandAppearsToWriteFeatureSource('echo hi > README.md'), false);
  // feature path but no write primitive
  assert.equal(commandAppearsToWriteFeatureSource('cat apps/web/src/x.ts'), false);
  assert.equal(commandAppearsToWriteFeatureSource(''), false);
  assert.equal(commandAppearsToWriteFeatureSource(undefined), false);
});

test('quoted text is data: comparison/prose ">" and quoted rm/tee never count as write primitives', () => {
  // 5cl-claude regression: the frontend's own collapse self-check was denied —
  // the awk comparison "length > m" read as an output redirect.
  assert.equal(commandAppearsToWriteFeatureSource(
    'for f in $(find src -name "*.tsx"); do awk \'{ if (length > m) m = length } END { print m }\' "$f"; done'), false);
  assert.equal(commandAppearsToWriteFeatureSource('echo "usage: gen > src/out.ts" && ls src/'), false);
  assert.equal(commandAppearsToWriteFeatureSource('grep -n "tee" src/app.ts'), false);
  assert.equal(commandAppearsToWriteFeatureSource('echo "rm -rf src/" && ls src/'), false);
  // stderr silencing is not a write
  assert.equal(commandAppearsToWriteFeatureSource('pkill -f "next start" 2>/dev/null; wc -L src/app.ts'), false);
  // real operators outside quotes stay gated, including quoted TARGETS
  assert.equal(commandAppearsToWriteFeatureSource('echo hi > "src/x file.ts"'), true);
  assert.equal(commandAppearsToWriteFeatureSource('printf x | tee src/x.ts'), true);
  // a nested shell body is real code — quotes there keep scanning raw
  assert.equal(commandAppearsToWriteFeatureSource("bash -c 'echo hi > src/x.ts'"), true);
  assert.equal(commandAppearsToWriteFeatureSource("sh -lc 'echo x > src/x.ts'"), true);
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
    'ln -s /tmp/payload apps/web/src/linked && cat > .traffic-one/digests/123/r.md <<EOF\nx\nEOF'), false);
  assert.equal(shellWriteTargetsStateDir(
    'sed -i s/a/b/ src/x.ts > .traffic-one/runs/123/log.txt'), false);
  // plan.md is intentionally not carved out
  assert.equal(shellWriteTargetsStateDir('cat > .traffic-one/plan.md <<EOF\nplan\nEOF'), false);
  // no write target at all
  assert.equal(shellWriteTargetsStateDir('cat .traffic-one/digests/123/reviewer.md'), false);
  assert.equal(shellWriteTargetsStateDir(''), false);
  assert.equal(shellWriteTargetsStateDir(undefined), false);
});

test('shellTrafficOneWriteTargets extracts real state targets but ignores heredoc prose', () => {
  assert.deepEqual(shellTrafficOneWriteTargets(
    "cat > .traffic-one/runs/R/architecture-v1.json <<'EOF'\n"
    + 'Mention .traffic-one/runs/R/claims.json only as prose.\nEOF',
  ), ['.traffic-one/runs/R/architecture-v1.json']);
  assert.deepEqual(shellTrafficOneWriteTargets(
    'python3 -c "open(\'.traffic-one/reports/qa/R/report-v2.json\',\'w\').write(\'{}\')"',
  ), ['.traffic-one/reports/qa/R/report-v2.json']);
  assert.deepEqual(shellTrafficOneWriteTargets(
    'cat .traffic-one/runs/R/architecture-v1.json',
  ), []);
});

test('sed -i detection anchors on sed option tokens, not any later "-i" text', () => {
  // the live 8c-codex tester denials: pure read chains where "-i" only appears
  // inside the filename `known-issues.md`
  assert.equal(commandAppearsToWriteBuildArtifact(
    "sed -n '1,240p' package.json && sed -n '1,240p' apps/web/package.json && sed -n '1,220p' vitest.config.ts"
    + " && sed -n '1,220p' playwright.config.ts && sed -n '1,180p' .traffic-one/.one.json && sed -n '1,180p' .traffic-one/known-issues.md",
  ), false);
  assert.equal(commandAppearsToWriteFeatureSource(
    "sed -n '1,50p' apps/web/src/App.tsx && sed -n '1,20p' .traffic-one/known-issues.md",
  ), false);
  // stdout-only sed whose SCRIPT merely contains "-i" stays a read
  assert.equal(commandAppearsToWriteFeatureSource("sed -e 's/-i/x/' src/a.ts"), false);
  // real in-place flag spellings stay writes
  assert.equal(commandAppearsToWriteFeatureSource("sed -i.bak 's/a/b/' src/x.ts"), true);
  assert.equal(commandAppearsToWriteFeatureSource("sed --in-place 's/a/b/' src/x.ts"), true);
  assert.equal(commandAppearsToWriteFeatureSource("sed -ni 's/a/b/p' src/x.ts"), true);
});

test('digests heredoc carve-out ignores write-primitive lookalikes inside the body', () => {
  // the live 8c-codex reviewer digest: body cites `sed -i`, `rm`, touch targets…
  const digestHeredoc = [
    'mkdir -p .traffic-one/digests/123',
    "cat > .traffic-one/digests/123/reviewer.md <<'EOF'",
    '# reviewer digest — run 123',
    '',
    'verdict: CHANGES_REQUESTED',
    '1. `apps/web/src/App.tsx` — replace the `sed -i` hack and the `rm -rf` cleanup step.',
    '2. touch targets under 44px on mobile.',
    'EOF',
  ].join('\n');
  assert.equal(shellWriteTargetsStateDir(digestHeredoc), true);
  // a redirect inside the body is quoted data, not a second write target
  assert.equal(shellWriteTargetsStateDir(
    "cat > .traffic-one/digests/123/tester.md <<'EOF'\nReproduce with: pnpm lint > lint.log\nEOF"), true);
  // real write primitives OUTSIDE the body still disable the carve-out
  assert.equal(shellWriteTargetsStateDir(`${digestHeredoc}\nrm -rf apps/web/src`), false);
});

test('shellAssetImportDest accepts only single outside→inside cp/mv imports', () => {
  const root = '/proj';
  const wd = '/proj';
  // the observed 10c shape: generated raster into an owned public path
  assert.equal(
    shellAssetImportDest('cp /Users/u/.codex/generated_images/s1/exec-abc.png apps/web/public/og-default.png', wd, root),
    'apps/web/public/og-default.png',
  );
  assert.equal(shellAssetImportDest('mv -f /outside/a.png public/a.png', wd, root), 'public/a.png');
  assert.equal(shellAssetImportDest("cp '/outside/with space.png' apps/web/public/a.png", wd, root), 'apps/web/public/a.png');
  assert.equal(shellAssetImportDest('cp /outside/a.png /proj/apps/web/public/a.png', wd, root), 'apps/web/public/a.png');
  // subdir workdir resolves the relative dest correctly
  assert.equal(shellAssetImportDest('cp /outside/a.png public/a.png', '/proj/apps/web', root), 'apps/web/public/a.png');
  // rejections: in-repo source, relative source, dest outside, dot-dirs, compounds, globs, redirects
  assert.equal(shellAssetImportDest('cp /proj/public/a.png public/b.png', wd, root), null);
  assert.equal(shellAssetImportDest('cp local.png public/a.png', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/a.png /elsewhere/a.png', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/a.png .traffic-one/a.png', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/a.png public/a.png && rm -rf src', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/*.png public/', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/a.png public/a.png > log.txt', wd, root), null);
  assert.equal(shellAssetImportDest('cp /outside/../etc/passwd public/a.png', wd, root), null);
  assert.equal(shellAssetImportDest('scp /outside/a.png public/a.png', wd, root), null);
  assert.equal(shellAssetImportDest('cp public/a.png', wd, root), null);
  assert.equal(shellAssetImportDest('', wd, root), null);
  assert.equal(shellAssetImportDest(undefined, wd, root), null);
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
  // Go side-by-side tests (13c: tester denied on a backend-owned _test.go)
  assert.equal(isTestScopePath('services/api/internal/middleware/middleware_test.go'), true);
  assert.equal(isTestScopePath('cmd/server/main.go'), false);
  assert.equal(isTestScopePath('internal/contest.go'), false); // no underscore — not a test
  // pytest side-by-side conventions
  assert.equal(isTestScopePath('app/models/test_user.py'), true);
  assert.equal(isTestScopePath('app/models/user_test.py'), true);
  assert.equal(isTestScopePath('app/models/latest.py'), false);
  assert.equal(isTestScopePath('app/models/protest.py'), false);
});

test('isTestInfraConfigPath classifies test-runner configs, not app bundler configs', () => {
  // the observed 8c/11c/12c tester denials
  assert.equal(isTestInfraConfigPath('apps/web/jest.config.js'), true);
  assert.equal(isTestInfraConfigPath('playwright.config.ts'), true);
  assert.equal(isTestInfraConfigPath('vitest.setup.ts'), true);
  // flavours
  assert.equal(isTestInfraConfigPath('vitest.config.mts'), true);
  assert.equal(isTestInfraConfigPath('vitest.workspace.ts'), true);
  assert.equal(isTestInfraConfigPath('cypress.config.cjs'), true);
  assert.equal(isTestInfraConfigPath('./jest.setup.js'), true);
  // app configs stay implementer-owned
  assert.equal(isTestInfraConfigPath('next.config.js'), false);
  assert.equal(isTestInfraConfigPath('vite.config.ts'), false);
  assert.equal(isTestInfraConfigPath('tailwind.config.ts'), false);
  // near-misses
  assert.equal(isTestInfraConfigPath('src/vitest.config.helper.ts'), false);
  assert.equal(isTestInfraConfigPath('myvitest.config.ts'), false);
  assert.equal(isTestInfraConfigPath(''), false);
  assert.equal(isTestInfraConfigPath(undefined), false);
});

test('applyPatchTargetPaths extracts Add/Update/Delete/Move targets, normalized', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: ./apps/web/src/new.ts',
    '+const x = 1;',
    '*** Update File: packages\\ui\\src\\btn.tsx',
    '@@',
    '-old',
    '+new',
    '*** Update File: src/move-source.ts',
    '*** Move to: src/moved.ts',
    '*** Delete File: src/old.ts',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(applyPatchTargetPaths(patch), [
    'apps/web/src/new.ts',
    'packages/ui/src/btn.tsx',
    'src/move-source.ts',
    'src/moved.ts',
    'src/old.ts',
  ]);
  assert.deepEqual(applyPatchTargetPaths(''), []);
  assert.deepEqual(applyPatchTargetPaths(undefined), []);
});
