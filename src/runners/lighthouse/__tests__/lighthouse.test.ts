import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULTS,
  classifyBlockedStatus,
  createAuditUrl,
  detectPackageManager,
  dlxArgs,
  execArgs,
  findFrontendApp,
  findReportHtml,
  findReportJson,
  findViteAppDir,
  lighthouseMissingMessage,
  nextConfigOutputExport,
  normalizeRoute,
  packageHasDependency,
  parseArgs,
  parseSummary,
  reportBaseName,
  runScriptArgs,
  usage,
} from '../lib';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-lh-'));
}

test('parseArgs reads flags, valued options, and a positional http url', () => {
  const a = parseArgs(['--route', '/pricing', '--performance-min', '80', '--timeout', '90000', '--skip-build', '--skip-preview']);
  assert.equal(a.route, '/pricing');
  assert.equal(a.performanceMin, 80);
  assert.equal(a.timeoutMs, 90000);
  assert.equal(a.build, false);
  assert.equal(a.preview, false);
  assert.equal(parseArgs(['http://127.0.0.1:4173/']).url, 'http://127.0.0.1:4173/');
  assert.equal(parseArgs([]).route, '/');
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs reads --local-only and defaults it off', () => {
  assert.equal(parseArgs(['--local-only']).localOnly, true);
  assert.equal(parseArgs([]).localOnly, false);
});

test('the missing-binary refusal maps to blocked:lighthouse-missing with a package-manager remedy', () => {
  // Approval layers that deny registry-download execution (Codex Desktop
  // guardian) deny the WHOLE runner when the dlx branch is reachable; the
  // --local-only refusal must classify to a structured status with the exact
  // devDependency remedy instead (observed 12c: perf shipped unverified).
  const message = lighthouseMissingMessage('pnpm', DEFAULTS.lighthouseVersion);
  assert.equal(classifyBlockedStatus(message), 'blocked:lighthouse-missing');
  assert.match(message, new RegExp(`pnpm add -D lighthouse@${DEFAULTS.lighthouseVersion.replace(/\./g, '\\.')}`));
  assert.match(lighthouseMissingMessage('npm', '13.2.0'), /npm install -D lighthouse@13\.2\.0/);
  assert.match(lighthouseMissingMessage('yarn', '13.2.0'), /yarn add -D lighthouse@13\.2\.0/);
});

test('parseArgs reads the runner budgets and falls back on invalid values', () => {
  const a = parseArgs(['--lighthouse-timeout', '60000', '--max-runtime', '300000']);
  assert.equal(a.lighthouseTimeoutMs, 60000);
  assert.equal(a.maxRuntimeMs, 300000);
  const bad = parseArgs(['--lighthouse-timeout', 'soon', '--max-runtime', '0']);
  assert.equal(bad.lighthouseTimeoutMs, DEFAULTS.lighthouseTimeoutMs);
  assert.equal(bad.maxRuntimeMs, DEFAULTS.maxRuntimeMs);
  assert.equal(parseArgs([]).lighthouseTimeoutMs, DEFAULTS.lighthouseTimeoutMs);
  assert.equal(parseArgs([]).maxRuntimeMs, DEFAULTS.maxRuntimeMs);
});

test('classifyBlockedStatus maps sandbox, usage-limit, and timeout failures', () => {
  assert.equal(classifyBlockedStatus('listen EPERM: operation not permitted "127.0.0.1"'), 'blocked:sandbox');
  assert.equal(classifyBlockedStatus('fetch failed: ECONNREFUSED'), 'blocked:sandbox');
  assert.equal(classifyBlockedStatus('You have hit your usage limit'), 'blocked:usage-limit');
  assert.equal(classifyBlockedStatus('API quota exceeded'), 'blocked:usage-limit');
  assert.equal(classifyBlockedStatus('lighthouse http://x timed out after 120000ms'), 'blocked:timeout');
  assert.equal(classifyBlockedStatus('Lighthouse runner exceeded 240000ms budget; aborting to avoid a silent hang.'), 'blocked:timeout');
  assert.equal(classifyBlockedStatus('Could not read Lighthouse report'), null);
});

test('usage describes the runner', () => {
  assert.ok(usage().includes('Lighthouse runner'));
});

test('normalizeRoute + createAuditUrl', () => {
  assert.equal(normalizeRoute('/'), '/');
  assert.equal(normalizeRoute('pricing'), '/pricing');
  assert.equal(normalizeRoute('/about'), '/about');
  assert.equal(createAuditUrl('http://127.0.0.1:4173/', 'pricing'), 'http://127.0.0.1:4173/pricing');
});

test('reportBaseName slugifies the route + appends a timestamp', () => {
  const name = reportBaseName('http://127.0.0.1:4173/blog/post');
  assert.match(name, /^blog-post-\d{4}-\d{2}-\d{2}T/);
  assert.match(reportBaseName('http://127.0.0.1:4173/'), /^home-/);
});

test('package-manager arg builders', () => {
  assert.deepEqual(runScriptArgs('npm', 'build'), ['run', 'build']);
  assert.deepEqual(runScriptArgs('yarn', 'build'), ['build']);
  assert.deepEqual(execArgs('npm', 'vite', ['preview']), ['exec', '--', 'vite', 'preview']);
  assert.deepEqual(execArgs('pnpm', 'vite', ['preview']), ['exec', 'vite', 'preview']);
  assert.deepEqual(dlxArgs('npm', 'lighthouse@13', ['x']), ['exec', '--yes', '--package', 'lighthouse@13', '--', 'lighthouse', 'x']);
  assert.deepEqual(dlxArgs('pnpm', 'lighthouse@13', ['x']), ['dlx', 'lighthouse@13', 'x']);
});

test('detectPackageManager keys off lockfiles + packageManager field', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');
    assert.equal(detectPackageManager(dir), 'npm');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '', 'utf8');
    assert.equal(detectPackageManager(dir), 'pnpm');
    fs.rmSync(path.join(dir, 'pnpm-lock.yaml'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0' }), 'utf8');
    assert.equal(detectPackageManager(dir), 'yarn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packageHasDependency + findViteAppDir (root and monorepo app)', () => {
  assert.equal(packageHasDependency({ dependencies: { vite: '5' } }, 'vite'), true);
  assert.equal(packageHasDependency({ devDependencies: { x: '1' } }, 'vite'), false);
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { vite: '5' } }), 'utf8');
    assert.equal(findViteAppDir(dir), dir);
    // monorepo: root without vite, apps/web with vite
    const mono = tmp();
    fs.writeFileSync(path.join(mono, 'package.json'), JSON.stringify({ name: 'root' }), 'utf8');
    const web = path.join(mono, 'apps', 'web');
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ devDependencies: { vite: '5' } }), 'utf8');
    assert.equal(findViteAppDir(mono), web);
    fs.rmSync(mono, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findFrontendApp detects Next.js before Vite fallbacks', () => {
  const mono = tmp();
  try {
    fs.writeFileSync(path.join(mono, 'package.json'), JSON.stringify({ name: 'root', devDependencies: { vite: '5' } }), 'utf8');
    const web = path.join(mono, 'apps', 'web');
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({
      dependencies: { next: '15', react: '19' },
      scripts: { build: 'next build', start: 'next start' },
    }), 'utf8');
    const found = findFrontendApp(mono);
    assert.equal(found.appDir, web);
    assert.equal(found.previewKind, 'next');
  } finally {
    fs.rmSync(mono, { recursive: true, force: true });
  }
});

test('findFrontendApp detects Next static export output mode', () => {
  const mono = tmp();
  try {
    fs.writeFileSync(path.join(mono, 'package.json'), JSON.stringify({ name: 'root' }), 'utf8');
    const web = path.join(mono, 'apps', 'web');
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({
      dependencies: { next: '15', react: '19' },
      scripts: { build: 'next build' },
    }), 'utf8');
    fs.writeFileSync(path.join(web, 'next.config.mjs'), 'export default { output: "export" };\n', 'utf8');
    assert.equal(nextConfigOutputExport(web), true);
    const found = findFrontendApp(mono);
    assert.equal(found.appDir, web);
    assert.equal(found.previewKind, 'static');
    assert.equal(found.staticDir, path.join(web, 'out'));
  } finally {
    fs.rmSync(mono, { recursive: true, force: true });
  }
});

test('findReportJson / findReportHtml resolve exact + fallback names', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'home-x.report.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dir, 'home-x.report.html'), '<html>', 'utf8');
    assert.equal(findReportJson(dir, 'home-x'), path.join(dir, 'home-x.report.json'));
    assert.equal(findReportHtml(dir, 'home-x'), path.join(dir, 'home-x.report.html'));
    assert.equal(findReportJson(dir, 'missing'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSummary computes score, threshold failures, and top opportunities', () => {
  const report = {
    categories: { performance: { score: 0.5 } },
    audits: {
      'first-contentful-paint': { numericValue: 3000, displayValue: '3.0 s' },
      'largest-contentful-paint': { numericValue: 1000, displayValue: '1.0 s' },
      'unused-js': { details: { type: 'opportunity' }, score: 0, numericSavingsMs: 800, title: 'Reduce unused JS', displayValue: '0.8 s' },
      'small-op': { details: { type: 'opportunity' }, score: 0, numericSavingsMs: 100, title: 'Tiny', displayValue: '0.1 s' },
    },
  };
  const thresholds = { performanceMin: 90, fcpMax: 1500, lcpMax: 2500, tbtMax: 200, clsMax: 0.1 };
  const summary = parseSummary(report, thresholds);
  assert.equal(summary.metrics.performance, 50);
  assert.ok(summary.failures.some((f) => f.startsWith('Performance 50 < 90')));
  assert.ok(summary.failures.some((f) => f.startsWith('FCP 3000ms > 1500ms')));
  assert.ok(!summary.failures.some((f) => f.startsWith('LCP'))); // 1000 < 2500, no failure
  assert.equal(summary.topOpportunities[0]?.title, 'Reduce unused JS'); // sorted by savings desc
  assert.equal(summary.topOpportunities[0]?.savingsMs, 800);
});

// Tolerance band + free category extraction (items measured live in the 1g run:
// three fix cycles chased a stable 5–6ms FCP residue; a11y data was discarded).
test('parseSummary: a metric within the tolerance band warns instead of failing', () => {
  const report = {
    categories: { performance: { score: 0.98 }, accessibility: { score: 0.95 } },
    audits: {
      'first-contentful-paint': { id: 'first-contentful-paint', numericValue: 1530, displayValue: '1.5 s' },
      'largest-contentful-paint': { id: 'largest-contentful-paint', numericValue: 2000, displayValue: '2.0 s' },
      'total-blocking-time': { id: 'total-blocking-time', numericValue: 0, displayValue: '0 ms' },
      'cumulative-layout-shift': { id: 'cumulative-layout-shift', numericValue: 0, displayValue: '0' },
    },
  } as never;
  const s = parseSummary(report, { performanceMin: 90, fcpMax: 1500, lcpMax: 2500, tbtMax: 200, clsMax: 0.1 });
  assert.equal(s.failures.length, 0, 'FCP 1530 vs 1500 is inside the 3% band');
  assert.equal(s.withinTolerance.length, 1);
  assert.match(s.withinTolerance[0] as string, /FCP 1530ms > 1500ms/);
  assert.equal(s.metrics.accessibility, 95);
});

test('parseSummary: beyond the tolerance band still fails; low a11y warns with worst audits', () => {
  const report = {
    categories: { performance: { score: 0.98 }, accessibility: { score: 0.72 }, 'best-practices': { score: 1 }, seo: { score: 0.9 } },
    audits: {
      'first-contentful-paint': { id: 'first-contentful-paint', numericValue: 1800, displayValue: '1.8 s' },
      'largest-contentful-paint': { id: 'largest-contentful-paint', numericValue: 2000, displayValue: '2.0 s' },
      'total-blocking-time': { id: 'total-blocking-time', numericValue: 0, displayValue: '0 ms' },
      'cumulative-layout-shift': { id: 'cumulative-layout-shift', numericValue: 0, displayValue: '0' },
      'color-contrast': { id: 'color-contrast', score: 0, title: 'Background and foreground colors do not have a sufficient contrast ratio.' },
    },
  } as never;
  const s = parseSummary(report, { performanceMin: 90, fcpMax: 1500, lcpMax: 2500, tbtMax: 200, clsMax: 0.1 });
  assert.equal(s.failures.length, 1);
  assert.match(s.failures[0] as string, /FCP 1800ms > 1500ms/);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0] as string, /Accessibility 72 < 90/);
  assert.match(s.warnings[0] as string, /contrast/i);
  assert.equal(s.metrics.bestPractices, 100);
  assert.equal(s.metrics.seo, 90);
});

test('findViteAppDir prefers the apps/* vite config over a hoisted root vite devDependency', () => {
  const mono = fs.mkdtempSync(path.join(os.tmpdir(), 't1-lh-mono-'));
  try {
    // Monorepo shape from a real run: vite hoisted to root devDeps for tooling,
    // no root vite.config — the buildable app is apps/web with a real config.
    fs.writeFileSync(path.join(mono, 'package.json'), JSON.stringify({ name: 'root', devDependencies: { vite: '^6' } }), 'utf8');
    const web = path.join(mono, 'apps', 'web');
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'web' }), 'utf8');
    fs.writeFileSync(path.join(web, 'vite.config.ts'), 'export default {};', 'utf8');
    assert.equal(findViteAppDir(mono), web);
    // A root config wins outright.
    fs.writeFileSync(path.join(mono, 'vite.config.ts'), 'export default {};', 'utf8');
    assert.equal(findViteAppDir(mono), mono);
  } finally {
    fs.rmSync(mono, { recursive: true, force: true });
  }
});
