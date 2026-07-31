// Diagnosable invalid-schema rejections (observed live, 13cl): the tester
// looped 6+ times in 90 seconds on a byte-identical "QA sidecar does not match
// QaReportV2." deny that named no field. The parser now records the CONCRETE
// violations — missing required fields, wrong-typed fields, unknown keys — and
// the formatter caps the list so the deny stays readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatSchemaIssues,
  newSchemaIssues,
  parseReport,
  QA_V2_SCHEMA_ISSUE_DISPLAY_CAP,
} from '../qa-report-v2/schema';

const BASE_REPORT = {
  schemaVersion: 2,
  runId: '1785341588480',
  verificationContractHash: 'a'.repeat(64),
  generatedAt: '2026-07-30T00:00:00.000Z',
  producer: 'parent-runner',
  status: 'failed',
  sourceHash: 'b'.repeat(64),
  checks: [{ id: 'stack-build', status: 'failed', summary: 'x' }],
  routes: [],
};

function reportWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...BASE_REPORT, ...overrides };
}

function reportWithout(...fields: string[]): Record<string, unknown> {
  const report: Record<string, unknown> = { ...BASE_REPORT };
  for (const field of fields) delete report[field];
  return report;
}

test('a valid report parses unchanged with a collector attached', () => {
  const issues = newSchemaIssues();
  const parsed = parseReport({ ...BASE_REPORT }, issues);
  assert.ok(parsed);
  assert.deepEqual(issues, { issues: [], total: 0 });
});

test('missing required fields are rejected AND named', () => {
  const issues = newSchemaIssues();
  assert.equal(parseReport(reportWithout('status', 'sourceHash'), issues), null);
  const message = formatSchemaIssues(issues);
  assert.match(message, /status: missing \(required\)/);
  assert.match(message, /sourceHash: missing \(required\)/);
});

test('wrong-typed fields are rejected and named with the expected type', () => {
  const issues = newSchemaIssues();
  assert.equal(parseReport(reportWith({ routes: 'not-an-array', generatedAt: 12345 }), issues), null);
  const message = formatSchemaIssues(issues);
  assert.match(message, /routes: must be an array of route objects/);
  assert.match(message, /generatedAt: must be an ISO-8601 UTC instant/);
});

test('nested wrong-typed fields are named with their full path', () => {
  const issues = newSchemaIssues();
  assert.equal(parseReport(reportWith({
    checks: [{ id: 'stack-build', status: 'maybe' }],
  }), issues), null);
  assert.match(formatSchemaIssues(issues), /checks\[0\]\.status: must be "passed", "failed", or "not-applicable"/);
});

test('unknown top-level keys are rejected and named', () => {
  const issues = newSchemaIssues();
  assert.equal(parseReport(reportWith({ verdict: 'passed', screenshots: [] }), issues), null);
  assert.match(formatSchemaIssues(issues), /unknown top-level keys: verdict, screenshots/);
});

test('non-object input is rejected with a message, never an empty enumeration', () => {
  const issues = newSchemaIssues();
  assert.equal(parseReport('not json object', issues), null);
  assert.match(formatSchemaIssues(issues), /must be a JSON object/);
});

test('the enumeration is capped: at most 6 entries shown, the rest counted', () => {
  const issues = newSchemaIssues();
  // 7+ violations: everything required is missing.
  assert.equal(parseReport({}, issues), null);
  assert.ok(issues.total > QA_V2_SCHEMA_ISSUE_DISPLAY_CAP);
  const message = formatSchemaIssues(issues);
  const shown = message.split(';').filter((entry) => entry.includes(':')).length;
  assert.ok(shown <= QA_V2_SCHEMA_ISSUE_DISPLAY_CAP + 1, `too many entries shown: ${message}`);
  assert.match(message, /\+\d+ more$/);
});

test('unknown key names from the untrusted file are sanitized and bounded', () => {
  const issues = newSchemaIssues();
  const hostile = 'evil\u0007' + 'x'.repeat(200);
  assert.equal(parseReport(reportWith({ [hostile]: true }), issues), null);
  const message = formatSchemaIssues(issues);
  assert.ok(!message.includes('\u0007'), 'control characters must not reach deny prose');
  assert.ok(!message.includes('x'.repeat(41)), 'key names must be truncated');
});

test('parseReport without a collector still rejects (back-compat call shape)', () => {
  assert.equal(parseReport(reportWithout('status')), null);
  assert.ok(parseReport({ ...BASE_REPORT }));
});
