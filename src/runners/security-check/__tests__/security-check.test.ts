import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  createReporter,
  helpText,
  isDocumentationOrFixturePath,
  isRuntimeAppSecurityPath,
  isSecurityHeaderConfigPath,
  lineForIndex,
  missingToolInstallPrompt,
  normalizeTrafficState,
  parseArgs,
  parseAuditJson,
  relativePath,
  renderMarkdownReport,
  scanAppSecurity,
  scanMobile,
  scanSecrets,
  scanSupabaseSql,
  shouldIgnoreFingerprint,
  timestampSlug,
  toPosix,
  trafficStateHasOnlyStampFields,
  type Issue,
  type Report,
  type ScanReport,
  type TextFile,
} from '../lib';
import { computeProjectFingerprint } from '../fingerprint';
import { runSecurityCheck } from '../run';

function scanReport(): { report: ScanReport; issues: Issue[] } {
  const reporter = createReporter();
  const report = {
    generatedAt: 'x', status: 'passed', strict: false, cwd: '/tmp',
    fingerprint: { fingerprint: 'f', head: 'no-git', fileCount: 0 },
    tools: {}, externalReports: {}, issues: reporter.issues, addIssue: reporter.addIssue,
  } as ScanReport;
  return { report, issues: reporter.issues };
}
const tf = (filePath: string, text: string): TextFile => ({ filePath, text });

test('parseArgs reads the security-check flags', () => {
  const a = parseArgs(['--strict', '--stamp', '--report-dir', '/r', '--cwd', '/c']);
  assert.equal(a.strict, true);
  assert.equal(a.stamp, true);
  assert.equal(a.reportDir, '/r');
  assert.equal(a.cwd, '/c');
  assert.equal(parseArgs(['--no-stamp']).stamp, false);
  assert.equal(parseArgs(['-h']).help, true);
});

test('helpText documents the flags', () => {
  const h = helpText();
  assert.ok(h.includes('--strict'));
  assert.ok(h.includes('--stamp'));
});

test('parseAuditJson handles npm metadata, array, and advisories shapes', () => {
  assert.deepEqual(parseAuditJson(JSON.stringify({ metadata: { vulnerabilities: { high: 2, critical: 1 } } })), { parsed: true, high: 2, critical: 1 });
  assert.deepEqual(parseAuditJson(JSON.stringify({ vulnerabilities: [{ severity: 'high' }, { severity: 'critical' }, { severity: 'low' }] })), { parsed: true, high: 1, critical: 1 });
  assert.deepEqual(parseAuditJson(JSON.stringify({ advisories: { a: { severity: 'high' } } })), { parsed: true, high: 1, critical: 0 });
  assert.deepEqual(parseAuditJson('not json'), { parsed: false, high: 0, critical: 0 });
});

test('path classifiers + helpers', () => {
  assert.equal(toPosix(path.join('a', 'b', 'c')), 'a/b/c');
  assert.equal(relativePath('/repo', '/repo/src/x.ts'), 'src/x.ts');
  assert.equal(timestampSlug('2026-01-02T03:04:05Z'), '20260102-030405Z');
  assert.equal(lineForIndex('a\nb\nc', 4), 3);
  assert.equal(shouldIgnoreFingerprint('node_modules/x'), true);
  assert.equal(shouldIgnoreFingerprint('src/x.ts'), false);
  assert.equal(isDocumentationOrFixturePath('docs/readme.md'), true);
  assert.equal(isDocumentationOrFixturePath('src/app.test.ts'), true);
  assert.equal(isRuntimeAppSecurityPath('server/api.ts'), true);
  assert.equal(isRuntimeAppSecurityPath('docs/x.md'), false);
  assert.equal(isSecurityHeaderConfigPath('vercel.json'), true);
});

test('missingToolInstallPrompt names the tools + the install command', () => {
  const prompt = missingToolInstallPrompt(['gitleaks', 'trufflehog']);
  assert.ok(prompt.includes('Missing: gitleaks, trufflehog'));
  assert.ok(prompt.includes('brew install gitleaks trufflehog'));
});

test('normalizeTrafficState + trafficStateHasOnlyStampFields strip stamp fields', () => {
  const stampOnly = JSON.stringify({ lastSecurityCheckAt: 't', lastShipperApprovalAt: 't' });
  assert.equal(normalizeTrafficState(stampOnly).trim(), '{}');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sec-stamp-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), stampOnly, 'utf8');
    assert.equal(trafficStateHasOnlyStampFields(dir, '.traffic-one/.one.json'), true);
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'new-project', lastSecurityCheckAt: 't' }), 'utf8');
    assert.equal(trafficStateHasOnlyStampFields(dir, '.traffic-one/.one.json'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderMarkdownReport lists findings + fix lines', () => {
  const report: Report = {
    generatedAt: '2026-01-01T00:00:00Z', status: 'failed', strict: true, cwd: '/x',
    fingerprint: { fingerprint: 'abc', head: 'no-git', fileCount: 0 }, tools: {}, externalReports: {},
    issues: [{ severity: 'high', category: 'secrets', message: 'leak', file: 'a.ts', line: 3, evidence: null, remediation: 'rotate' }],
  };
  const md = renderMarkdownReport(report);
  assert.ok(md.includes('Status: FAILED'));
  assert.ok(md.includes('- [high] secrets — a.ts:3 — leak'));
  assert.ok(md.includes('Fix: rotate'));
});

test('scanSecrets flags client-prefixed secrets + localStorage tokens', () => {
  const { report, issues } = scanReport();
  scanSecrets('/tmp/no-such', [
    tf('src/config.ts', 'export const k = VITE_SUPABASE_SERVICE_ROLE_KEY;'),
    tf('src/auth.ts', 'localStorage.setItem("jwt", token);'),
  ], report);
  assert.ok(issues.some((i) => i.message.includes('Client-prefixed environment variable')));
  assert.ok(issues.some((i) => i.category === 'auth' && i.message.includes('localStorage')));
});

test('scanSupabaseSql flags missing RLS + role-less policies', () => {
  const { report, issues } = scanReport();
  scanSupabaseSql([tf('supabase/migrations/001.sql', 'create table public.users (id uuid);\ncreate policy p on public.users for select using (true);')], report);
  assert.ok(issues.some((i) => i.message.includes('Public table "users" is created without enabling RLS')));
  assert.ok(issues.some((i) => i.message.includes('missing an explicit TO role')));
});

test('scanAppSecurity flags unauthenticated state-changing endpoints', () => {
  const { report, issues } = scanReport();
  scanAppSecurity('/tmp/no-such', [tf('server/users.route.ts', 'export async function POST(req){ return db.update(x); }')], report);
  assert.ok(issues.some((i) => i.category === 'access-control' && i.message.includes('no server-side authentication evidence')));
});

test('scanMobile flags bundled secrets in mobile projects', () => {
  const { report, issues } = scanReport();
  scanMobile([
    tf('capacitor.config.ts', 'export default { appId: "x" }'),
    tf('src/env.ts', 'const k = "SUPABASE_SERVICE_ROLE_KEY=abc";'),
  ], report);
  assert.ok(issues.some((i) => i.category === 'mobile' && i.message.includes('bundled secret-looking configuration')));
});

test('computeProjectFingerprint is deterministic + excludes stamp-only state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sec-fp-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'world', 'utf8');
    const fp1 = computeProjectFingerprint(dir);
    const fp2 = computeProjectFingerprint(dir);
    assert.equal(fp1.fingerprint, fp2.fingerprint);
    assert.match(fp1.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(fp1.head, 'no-git');
    assert.equal(fp1.fileCount, 2);
    // A stamp-only traffic-one state file does not bump the file count.
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ lastSecurityCheckAt: 't' }), 'utf8');
    assert.equal(computeProjectFingerprint(dir).fileCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runSecurityCheck writes reports + a hex fingerprint (non-strict passes)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sec-run-'));
  try {
    fs.writeFileSync(path.join(dir, 'note.txt'), 'nothing secret here', 'utf8');
    const { report, paths, exitCode } = runSecurityCheck({ cwd: dir, strict: false, stamp: false });
    assert.equal(report.status, 'passed');
    assert.equal(exitCode, 0);
    assert.match(report.fingerprint.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok('gitleaks' in report.tools && 'trufflehog' in report.tools);
    assert.ok(fs.existsSync(path.join(dir, paths.relativeJsonPath)));
    assert.ok(fs.existsSync(path.join(dir, paths.relativeMarkdownPath)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
