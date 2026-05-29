import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  createAuditUrl,
  detectPackageManager,
  dlxArgs,
  execArgs,
  findReportHtml,
  findReportJson,
  findViteAppDir,
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
  const a = parseArgs(['--route', '/pricing', '--performance-min', '80', '--skip-build', '--skip-preview']);
  assert.equal(a.route, '/pricing');
  assert.equal(a.performanceMin, 80);
  assert.equal(a.build, false);
  assert.equal(a.preview, false);
  assert.equal(parseArgs(['http://127.0.0.1:4173/']).url, 'http://127.0.0.1:4173/');
  assert.equal(parseArgs([]).route, '/');
  assert.equal(parseArgs(['-h']).help, true);
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
