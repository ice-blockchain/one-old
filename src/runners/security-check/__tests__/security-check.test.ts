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
  projectFiles,
  relativePath,
  renderMarkdownReport,
  scanAppSecurity,
  scanMobile,
  scanSecrets,
  scanSupabaseSql,
  shouldIgnoreFingerprint,
  securityCheckCanStamp,
  stampState,
  stripComments,
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
import { SECURITY_STAMP_FIELDS } from '../../../config/security';

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
  assert.ok(SECURITY_STAMP_FIELDS.includes('lastSecurityCheckStrict'));
  const stampOnly = JSON.stringify({ lastSecurityCheckAt: 't', lastSecurityCheckStrict: true, lastShipperApprovalAt: 't' });
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

// The app-security rules match code SHAPES, and prose is not code. Every row here
// is a finding this scanner actually reported against Traffic One's own source, on
// a comment or an identifier, with no vulnerability anywhere near it.
test('the app-security rules do not fire on comments or on identifiers that merely look like calls', () => {
  const { report, issues } = scanReport();
  scanAppSecurity('/tmp/no-such', [
    // qa-evidence/stack.ts: `EXECUTE\s+[^;]*\|\|` crossed newlines, so "execute"
    // in a sentence paired with a `||` anywhere later in the file.
    tf('src/runners/qa-evidence/stack.ts',
      '// the execute bit — reported `stack-test: not-applicable`, was excused\n'
      + 'const ok = a || b;\n'),
    // session-start.ts: `marked\(` matched any identifier ending in those letters.
    tf('src/modules/session/session-start.ts',
      'function updatesNotMarked(env) { return "[traffic-one] not recorded"; }\n'
      + 'if (marked) return result;\n'),
    // doctor/bundle.ts: a comment documenting the redactor's own fake vectors,
    // reported as an admin route gated only in UI code (`/admin` inside the URL).
    tf('src/runners/doctor/bundle.ts',
      '// redacts `postgres://admin:pass@host` under `databaseUrl`, an `sk-` key\n'
      + 'export const redact = (s) => s;\n'),
    // A template literal in a comment is not a query either.
    tf('src/db/notes.ts', '// avoid sql(`select ${id}`) — use a bound parameter\nexport const q = 1;\n'),
  ], report);
  assert.deepEqual(issues.map((i) => `${i.category}:${i.file}`), [],
    'a comment that DISCUSSES a vulnerable shape is not that shape');
});

// The other half: stripping comments must not blind the rules to real code.
test('the app-security rules still catch the shapes they exist for, in code', () => {
  const { report, issues } = scanReport();
  scanAppSecurity('/tmp/no-such', [
    tf('src/db/query.ts', 'export const run = (id) => sql(`select * from t where id = ${id}`);'),
    tf('src/ui/Note.tsx', 'import Markdown from "react-markdown";\nexport const N = () => <Markdown>{body}</Markdown>;'),
    tf('src/admin/panel.tsx', 'export const Panel = () => (role === "admin" ? <Secret/> : null);'),
    tf('src/ui/Raw.tsx', 'export const R = () => <div dangerouslySetInnerHTML={{ __html: body }} />;'),
  ], report);
  const found = (category: string, file: string): boolean =>
    issues.some((i) => i.category === category && i.file === file);
  assert.ok(found('injection', 'src/db/query.ts'), 'interpolation INSIDE the query template still matches');
  assert.ok(found('xss', 'src/ui/Note.tsx'), 'an actual react-markdown import with no sanitizer still matches');
  assert.ok(found('access-control', 'src/admin/panel.tsx'), 'admin gating in client code still matches');
  assert.ok(found('xss', 'src/ui/Raw.tsx'), 'dangerouslySetInnerHTML still matches');
});

test('stripComments blanks comments, keeps strings, and preserves line numbers', () => {
  const text = 'const a = 1; // note\nconst url = "https://x/y";\n/* block\n   more */\nconst b = 2;\n';
  const out = stripComments(text);
  assert.equal(out.length, text.length, 'offsets are preserved, so a line number computed from either agrees');
  assert.equal(lineForIndex(out, out.indexOf('const b')), lineForIndex(text, text.indexOf('const b')));
  assert.ok(!out.includes('note'), 'the line comment is gone');
  assert.ok(!out.includes('more'), 'the block comment is gone, including its second line');
  assert.ok(out.includes('"https://x/y"'), 'a // inside a string opens no comment');
  assert.ok(out.includes('const b = 2;'), 'code after a block comment survives');
  // A regex literal spelling an escaped slash is not a comment either.
  assert.ok(stripComments('const re = /\\/\\//; const keep = 1;').includes('const keep = 1;'));
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

test('security-check state stamping preserves the immutable One MCP report id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sec-one-uid-'));
  try {
    const reportId = '019f6f33-2b60-7dda-a232-eee6dfebb860';
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'existing-codebase',
      'one-uid': reportId,
    }), 'utf8');
    const report: Report = {
      generatedAt: '2026-07-17T12:00:00Z',
      status: 'passed',
      strict: false,
      cwd: dir,
      fingerprint: { fingerprint: 'a'.repeat(64), head: 'no-git', fileCount: 1 },
      tools: {},
      externalReports: {},
      issues: [],
    };

    stampState(dir, report, '.traffic-one/reports/security.json');

    const state = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(state['one-uid'], reportId);
    assert.equal(state.lastSecurityCheckFingerprint, 'a'.repeat(64));
    assert.equal(state.lastSecurityCheckStrict, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('projectFiles skips template/detector/onboarding trees ONLY on the plugin authoring root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sec-authoring-'));
  try {
    // Make `authoring/` look like the Traffic One source repo (package.json name
    // + a source-tree entry → isPluginAuthoringRoot true).
    const authoring = path.join(base, 'authoring');
    fs.mkdirSync(path.join(authoring, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(authoring, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    fs.writeFileSync(path.join(authoring, 'src', 'gen', 'index.ts'), '// gen entry\n', 'utf8');
    // Skipped: skill template (example creds) + the scanner's own source.
    fs.mkdirSync(path.join(authoring, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(authoring, 'skills', 'demo', 'SKILL.md'), '# example\npostgres://u:p@h/db\n', 'utf8');
    fs.mkdirSync(path.join(authoring, 'src', 'runners', 'security-check'), { recursive: true });
    fs.writeFileSync(path.join(authoring, 'src', 'runners', 'security-check', 'detector.ts'), '// regex\n', 'utf8');
    // Kept: real plugin code outside the authoring trees stays in scope.
    fs.mkdirSync(path.join(authoring, 'src', 'app'), { recursive: true });
    fs.writeFileSync(path.join(authoring, 'src', 'app', 'real.ts'), 'export const x = 1;\n', 'utf8');

    const picked = projectFiles(authoring);
    assert.equal(picked.includes('skills/demo/SKILL.md'), false, 'skill template skipped on authoring root');
    assert.equal(picked.includes('src/runners/security-check/detector.ts'), false, 'detector source skipped on authoring root');
    assert.equal(picked.includes('src/app/real.ts'), true, 'real app code must still be scanned');

    // A non-authoring project keeps the same tree fully in scope.
    const plain = path.join(base, 'plain');
    fs.mkdirSync(path.join(plain, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ name: 'my-app' }), 'utf8');
    fs.writeFileSync(path.join(plain, 'skills', 'demo', 'SKILL.md'), '# example\npostgres://u:p@h/db\n', 'utf8');
    assert.equal(projectFiles(plain).includes('skills/demo/SKILL.md'), true, 'non-authoring project keeps full coverage');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// REGRESSION: stampState dropped writeJson's refusal and returned void, so
// `security-check --strict --stamp` printed `PASSED` and exited 0 with nothing
// stamped — while deploy-gate.ts, which reads lastSecurityCheckStatus and
// lastSecurityCheckFingerprint straight back out of `.one.json`, denied the
// deploy for a missing stamp. Two Traffic One components reporting opposite
// answers about one fact, with nothing in either message connecting them; the
// shipper role's only recourse was to re-run the scan that "passed".
//
// The gate's direction is correct and untouched: no stamp must deny. What is
// fixed is the producer certifying a stamp it never landed.
//
// Fenced with the SYMLINK half of fsjson.ts's write guard: it refuses this one
// path while the reports directory beside it stays writable, so the scan still
// completes normally and the only difference is the stamp.
test('a refused security stamp is reported as a failed run, not a passed one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sec-stamp-refused-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    const statePath = path.join(dir, '.traffic-one', '.one.json');
    const report: Report = {
      generatedAt: '2026-07-17T12:00:00Z',
      status: 'passed',
      strict: false,
      cwd: dir,
      fingerprint: { fingerprint: 'a'.repeat(64), head: 'no-git', fileCount: 1 },
      tools: {},
      externalReports: {},
      issues: [],
    };

    // Baseline: the same call on a writable path stamps and reads back.
    assert.equal(stampState(dir, report, '.traffic-one/reports/security.json'), true);
    assert.equal(
      JSON.parse(fs.readFileSync(statePath, 'utf8')).lastSecurityCheckStatus,
      'passed',
    );

    fs.rmSync(statePath);
    fs.symlinkSync(path.join(dir, '.traffic-one', 'absent.json'), statePath);
    assert.equal(
      stampState(dir, report, '.traffic-one/reports/security.json'),
      false,
      'the refusal must reach the caller instead of a void',
    );
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'absent.json')), false,
      'fixture guard: nothing was written through the link');

    // End to end: the runner must not headline PASSED, and must not exit 0, for a
    // stamp the deploy gate cannot find. Only characterize the WRITE refusal
    // when the scan itself is stamp-eligible — a missing scanner is a high
    // finding and refuses the stamp for a different reason.
    const result = runSecurityCheck({ cwd: dir, stamp: true, reportDir: '.traffic-one/reports' });
    const highs = result.report.issues.filter((issue) => issue.severity === 'high');
    if (highs.length === 0) {
      assert.equal(result.report.status, 'passed', 'fixture guard: the scan itself found nothing');
      assert.equal(result.stamped, false, 'the requested stamp did not land');
      assert.equal(result.exitCode, 1, 'a run that was asked to stamp and did not is not a success');
    } else {
      assert.equal(result.stamped, false, 'high findings also refuse the stamp; write refusal is covered above');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function passingReport(dir: string, extras: Partial<Report> = {}): Report {
  return {
    generatedAt: '2026-07-17T12:00:00Z',
    status: 'passed',
    strict: false,
    cwd: dir,
    fingerprint: { fingerprint: 'a'.repeat(64), head: 'no-git', fileCount: 1 },
    tools: {},
    externalReports: {},
    issues: [],
    ...extras,
  };
}

function highIssue(): Issue {
  return {
    severity: 'high', category: 'secrets', message: 'leak',
    file: '.env', line: 1, evidence: null, remediation: 'rotate',
  };
}

test('securityCheckCanStamp refuses high findings even when status is still passed', () => {
  assert.equal(securityCheckCanStamp({ status: 'passed', issues: [] }), true);
  assert.equal(securityCheckCanStamp({ status: 'passed', issues: [highIssue()] }), false);
  assert.equal(securityCheckCanStamp({ status: 'failed', issues: [] }), false);
  assert.equal(securityCheckCanStamp({
    status: 'passed',
    issues: [{ ...highIssue(), severity: 'medium' }],
  }), true, 'warnings do not block a stamp');
});

test('stampState refuses high findings and records lastSecurityCheckStrict on a clean stamp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sec-stamp-strict-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    const statePath = path.join(dir, '.traffic-one', '.one.json');
    fs.writeFileSync(statePath, JSON.stringify({ mode: 'existing-codebase' }), 'utf8');

    assert.equal(
      stampState(dir, passingReport(dir, { issues: [highIssue()] }), '.traffic-one/reports/security.json'),
      false,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(statePath, 'utf8')).lastSecurityCheckStatus,
      undefined,
      'a high-finding report must not write a deploy stamp',
    );

    assert.equal(stampState(dir, passingReport(dir, { strict: true }), '.traffic-one/reports/security.json'), true);
    const strictState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(strictState.lastSecurityCheckStatus, 'passed');
    assert.equal(strictState.lastSecurityCheckStrict, true);

    assert.equal(stampState(dir, passingReport(dir, { strict: false }), '.traffic-one/reports/security.json'), true);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).lastSecurityCheckStrict, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withScanProject(plantHigh: boolean, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sec-run-stamp-'));
  try {
    fs.writeFileSync(path.join(dir, 'note.txt'), 'nothing secret here', 'utf8');
    if (plantHigh) {
      fs.writeFileSync(path.join(dir, '.env'), 'SECRET=x\n', 'utf8');
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function stateAfter(dir: string): Record<string, unknown> | null {
  const statePath = path.join(dir, '.traffic-one', '.one.json');
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
}

test('high findings + --stamp without --strict is not stamped', () => {
  withScanProject(true, (dir) => {
    const result = runSecurityCheck({ cwd: dir, strict: false, stamp: true });
    assert.ok(result.report.issues.some((issue) => issue.severity === 'high'));
    assert.equal(result.report.status, 'passed', 'non-strict still reports passed as a diagnostic');
    assert.equal(result.stamped, false);
    assert.equal(result.exitCode, 1);
    const state = stateAfter(dir);
    assert.equal(state?.lastSecurityCheckStatus, undefined);
  });
});

test('high findings + --strict --stamp is failed and not stamped', () => {
  withScanProject(true, (dir) => {
    const result = runSecurityCheck({ cwd: dir, strict: true, stamp: true });
    assert.ok(result.report.issues.some((issue) => issue.severity === 'high'));
    assert.equal(result.report.status, 'failed');
    assert.equal(result.stamped, undefined, 'a failed scan does not report a refused stamp');
    assert.equal(result.exitCode, 1);
    const state = stateAfter(dir);
    assert.equal(state?.lastSecurityCheckStatus, undefined);
  });
});

test('clean + --strict --stamp writes lastSecurityCheckStrict true when the scan is clean', (t) => {
  withScanProject(false, (dir) => {
    const result = runSecurityCheck({ cwd: dir, strict: true, stamp: true });
    const highs = result.report.issues.filter((issue) => issue.severity === 'high');
    if (highs.length > 0) {
      t.skip(`live scan is not clean here (${highs.map((issue) => issue.message).join('; ')}); stampState covers the clean-stamp field`);
      return;
    }
    assert.equal(result.report.status, 'passed');
    assert.equal(result.stamped, true);
    assert.equal(result.exitCode, 0);
    const state = stateAfter(dir);
    assert.equal(state?.lastSecurityCheckStatus, 'passed');
    assert.equal(state?.lastSecurityCheckStrict, true);
    assert.equal(state?.lastSecurityCheckFingerprint, result.report.fingerprint.fingerprint);
  });
});

test('clean + --stamp without --strict still stamps lastSecurityCheckStrict false when the scan is clean', (t) => {
  withScanProject(false, (dir) => {
    const result = runSecurityCheck({ cwd: dir, strict: false, stamp: true });
    const highs = result.report.issues.filter((issue) => issue.severity === 'high');
    if (highs.length > 0) {
      t.skip(`live scan is not clean here (${highs.map((issue) => issue.message).join('; ')}); stampState covers the clean-stamp field`);
      return;
    }
    assert.equal(result.report.status, 'passed');
    assert.equal(result.stamped, true);
    assert.equal(result.exitCode, 0);
    assert.equal(stateAfter(dir)?.lastSecurityCheckStrict, false);
  });
});
