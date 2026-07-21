import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  isQaBrowserBridgeEligible,
  qaReportDirectory,
  qaReportPath,
  readQaReportV1,
  validateQaReportV1,
  type QaReportV1,
} from '../qa-report';

const RUN_STARTED_AT = Date.parse('2026-07-20T12:00:00.000Z');
const RUN_ID = String(RUN_STARTED_AT);
const GENERATED_AT = '2026-07-20T12:01:00.000Z';
const NOW_MS = Date.parse('2026-07-20T12:02:00.000Z');

interface Fixture {
  root: string;
  qaDirectory: string;
  report: QaReportV1;
  cleanup(): void;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-report-'));
  const qaDirectory = qaReportDirectory(root, RUN_ID);
  fs.mkdirSync(qaDirectory, { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path.join(qaDirectory, 'home-mobile.png'), png);
  fs.writeFileSync(path.join(qaDirectory, 'home-desktop.png'), png);
  const report: QaReportV1 = {
    schemaVersion: 1,
    runId: RUN_ID,
    generatedAt: GENERATED_AT,
    producer: 'senior-tester',
    status: 'passed',
    routes: [{
      route: '/',
      viewports: [
        {
          width: 390,
          status: 'passed',
          consoleErrorCount: 0,
          documentOverflow: false,
          elementOverflow: false,
          primaryAction: { status: 'reachable' },
          screenshotPath: 'home-mobile.png',
        },
        {
          width: 768,
          status: 'passed',
          consoleErrorCount: 0,
          documentOverflow: false,
          elementOverflow: false,
          primaryAction: { status: 'not-applicable', reason: 'This route has no primary action at tablet width.' },
        },
        {
          width: 1440,
          status: 'passed',
          consoleErrorCount: 0,
          documentOverflow: false,
          elementOverflow: false,
          primaryAction: { status: 'reachable' },
          screenshotPath: `.traffic-one/reports/qa/${RUN_ID}/home-desktop.png`,
        },
      ],
    }],
  };
  return {
    root,
    qaDirectory,
    report,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeCanonicalReport(item: Fixture, value: unknown = item.report): void {
  fs.writeFileSync(qaReportPath(item.root, RUN_ID), `${JSON.stringify(value, null, 2)}\n`);
}

function browserBlockedReport(item: Fixture): QaReportV1 {
  const report: QaReportV1 = {
    ...item.report,
    status: 'blocked:browser-unavailable',
    routes: structuredClone(item.report.routes),
    blocker: {
      code: 'browser-unavailable',
      summary: 'The delegated tester has no browser tool in this host.',
    },
  };
  for (const route of report.routes) {
    for (const viewport of route.viewports) viewport.status = 'blocked:browser-unavailable';
  }
  return report;
}

test('accepts a complete passing route matrix with confined mobile and desktop screenshots', () => {
  const item = fixture();
  try {
    writeCanonicalReport(item);
    const result = readQaReportV1(item.root, RUN_ID, { nowMs: NOW_MS });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.report.runId, RUN_ID);
      assert.equal(result.report.routes[0]?.viewports.length, 3);
      assert.equal(result.reportPath, qaReportPath(item.root, RUN_ID));
    }
  } finally {
    item.cleanup();
  }
});

test('fails closed on malformed JSON, malformed schema, and unknown fields', () => {
  const item = fixture();
  try {
    fs.writeFileSync(qaReportPath(item.root, RUN_ID), '{not-json');
    assert.equal(readQaReportV1(item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-json');

    const malformed = structuredClone(item.report) as unknown as Record<string, unknown>;
    delete malformed.producer;
    assert.equal(validateQaReportV1(malformed, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-schema');

    const extra = { ...item.report, arbitraryEvidence: true };
    assert.equal(validateQaReportV1(extra, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-schema');
  } finally {
    item.cleanup();
  }
});

test('rejects a report whose embedded run id does not exactly match the current run', () => {
  const item = fixture();
  try {
    const report = { ...item.report, runId: '1784548800001' };
    const result = validateQaReportV1(report, item.root, RUN_ID, { nowMs: NOW_MS });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'run-id-mismatch');
  } finally {
    item.cleanup();
  }
});

test('rejects stale evidence before the numeric run epoch or an explicit freshness boundary', () => {
  const item = fixture();
  try {
    const beforeRun = { ...item.report, generatedAt: '2026-07-20T11:59:59.999Z' };
    assert.equal(
      validateQaReportV1(beforeRun, item.root, RUN_ID, { nowMs: NOW_MS }).code,
      'stale-report',
    );
    assert.equal(
      validateQaReportV1(item.report, item.root, RUN_ID, {
        nowMs: NOW_MS,
        minimumGeneratedAtMs: Date.parse('2026-07-20T12:01:30.000Z'),
      }).code,
      'stale-report',
    );
  } finally {
    item.cleanup();
  }
});

test('rejects non-canonical or implausibly future generatedAt timestamps', () => {
  const item = fixture();
  try {
    const offsetIso = { ...item.report, generatedAt: '2026-07-20T15:01:00+03:00' };
    assert.equal(validateQaReportV1(offsetIso, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-schema');
    const future = { ...item.report, generatedAt: '2026-07-20T13:00:00.000Z' };
    assert.equal(validateQaReportV1(future, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'future-report');
  } finally {
    item.cleanup();
  }
});

test('requires each route to contain widths 390, 768, and 1440 exactly once', () => {
  const item = fixture();
  try {
    const missing = structuredClone(item.report);
    missing.routes[0]?.viewports.splice(1, 1);
    assert.equal(validateQaReportV1(missing, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'missing-viewport');

    const duplicate = structuredClone(item.report);
    const viewport = duplicate.routes[0]?.viewports[0];
    if (viewport) duplicate.routes[0]?.viewports.push(viewport);
    assert.equal(validateQaReportV1(duplicate, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'missing-viewport');
  } finally {
    item.cleanup();
  }
});

test('requires existing 390 and 1440 screenshots and validates an optional 768 screenshot', () => {
  const item = fixture();
  try {
    const missingMobile = structuredClone(item.report);
    delete missingMobile.routes[0]?.viewports[0]?.screenshotPath;
    assert.equal(validateQaReportV1(missingMobile, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-screenshot');

    const missingDesktop = structuredClone(item.report);
    const desktop = missingDesktop.routes[0]?.viewports[2];
    if (desktop) desktop.screenshotPath = 'does-not-exist.png';
    assert.equal(validateQaReportV1(missingDesktop, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-screenshot');

    const missingTablet = structuredClone(item.report);
    const tablet = missingTablet.routes[0]?.viewports[1];
    if (tablet) tablet.screenshotPath = 'does-not-exist.png';
    assert.equal(validateQaReportV1(missingTablet, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-screenshot');

    writeCanonicalReport(item);
    const jsonAsScreenshot = structuredClone(item.report);
    const jsonMobile = jsonAsScreenshot.routes[0]?.viewports[0];
    if (jsonMobile) jsonMobile.screenshotPath = 'report.json';
    assert.equal(validateQaReportV1(jsonAsScreenshot, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-screenshot');

    fs.writeFileSync(path.join(item.qaDirectory, 'fake.png'), 'not an image');
    const fakeImage = structuredClone(item.report);
    const fakeMobile = fakeImage.routes[0]?.viewports[0];
    if (fakeMobile) fakeMobile.screenshotPath = 'fake.png';
    assert.equal(validateQaReportV1(fakeImage, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-screenshot');
  } finally {
    item.cleanup();
  }
});

test('rejects screenshot traversal and a symlink that escapes the run QA directory', () => {
  const item = fixture();
  const external = path.join(item.root, 'outside.png');
  try {
    fs.writeFileSync(external, 'outside');
    const traversal = structuredClone(item.report);
    const mobile = traversal.routes[0]?.viewports[0];
    if (mobile) mobile.screenshotPath = '../../../../outside.png';
    assert.equal(validateQaReportV1(traversal, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-screenshot');

    fs.symlinkSync(external, path.join(item.qaDirectory, 'escaped.png'));
    const symlink = structuredClone(item.report);
    const symlinkMobile = symlink.routes[0]?.viewports[0];
    if (symlinkMobile) symlinkMobile.screenshotPath = 'escaped.png';
    assert.equal(validateQaReportV1(symlink, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-screenshot');
  } finally {
    item.cleanup();
  }
});

test('rejects any non-passing matrix entry even when the overall status says passed', () => {
  const item = fixture();
  try {
    const statusFailed = structuredClone(item.report);
    const mobile = statusFailed.routes[0]?.viewports[0];
    if (mobile) mobile.status = 'failed';
    assert.equal(validateQaReportV1(statusFailed, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'matrix-not-passed');

    const consoleFailure = structuredClone(item.report);
    const tablet = consoleFailure.routes[0]?.viewports[1];
    if (tablet) tablet.consoleErrorCount = 1;
    assert.equal(validateQaReportV1(consoleFailure, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'matrix-not-passed');

    const overflowFailure = structuredClone(item.report);
    const desktop = overflowFailure.routes[0]?.viewports[2];
    if (desktop) desktop.elementOverflow = true;
    assert.equal(validateQaReportV1(overflowFailure, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'matrix-not-passed');

    const unreachable = structuredClone(item.report);
    const action = unreachable.routes[0]?.viewports[0];
    if (action) action.primaryAction = { status: 'unreachable', reason: 'Button is covered.' };
    assert.equal(validateQaReportV1(unreachable, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'matrix-not-passed');
  } finally {
    item.cleanup();
  }
});

test('recognizes failed and blocked reports without accepting either as QA evidence', () => {
  const item = fixture();
  try {
    const failed: QaReportV1 = {
      ...item.report,
      status: 'failed',
      routes: structuredClone(item.report.routes),
    };
    const failedViewport = failed.routes[0]?.viewports[0];
    if (failedViewport) failedViewport.status = 'failed';
    assert.equal(validateQaReportV1(failed, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'report-failed');

    const blocked = browserBlockedReport(item);
    const blockedWithScreenshots = structuredClone(blocked);
    delete blocked.routes[0]?.viewports[0]?.screenshotPath;
    delete blocked.routes[0]?.viewports[2]?.screenshotPath;
    const blockedResult = validateQaReportV1(blocked, item.root, RUN_ID, { nowMs: NOW_MS });
    assert.equal(blockedResult.ok, false);
    assert.equal(blockedResult.code, 'invalid-screenshot');
    assert.equal(blockedResult.status, 'blocked:browser-unavailable');
    assert.equal(blockedResult.blockerCode, 'browser-unavailable');
    assert.equal(blockedResult.report?.producer, 'senior-tester');
    assert.equal(isQaBrowserBridgeEligible(blockedResult), true);

    const blockedWithScreenshotsResult = validateQaReportV1(
      blockedWithScreenshots,
      item.root,
      RUN_ID,
      { nowMs: NOW_MS },
    );
    assert.equal(blockedWithScreenshotsResult.code, 'report-blocked');
    assert.equal(isQaBrowserBridgeEligible(blockedWithScreenshotsResult), true);
  } finally {
    item.cleanup();
  }
});

test('blocked reports require a bounded matching blocker code and safe single-line summary', () => {
  const item = fixture();
  try {
    const noBlocker = { ...item.report, status: 'blocked:sandbox' as const };
    assert.equal(validateQaReportV1(noBlocker, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-schema');
    const mismatch = {
      ...noBlocker,
      blocker: { code: 'timeout' as const, summary: 'Sandbox denied the required browser process.' },
    };
    assert.equal(validateQaReportV1(mismatch, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-schema');
    const multiline = {
      ...noBlocker,
      blocker: { code: 'sandbox' as const, summary: 'Denied\nraw output follows' },
    };
    assert.equal(validateQaReportV1(multiline, item.root, RUN_ID, { nowMs: NOW_MS }).code, 'invalid-schema');

    for (const summary of [
      'API_KEY=sk-proj-abc123456789',
      'Authorization: Bearer abc.def.ghi123456789',
      'The rejected credential was sk-proj-abc123456789.',
      'access_token: "very-secret-token-value"',
      'OPENAI_API_KEY=abc123456789',
      'config.AWS_ACCESS_KEY_ID=AKIA123456789',
      'SUPABASE_SERVICE_ROLE_KEY: secret-value-123',
    ]) {
      const leaked = {
        ...noBlocker,
        blocker: { code: 'sandbox' as const, summary },
      };
      assert.equal(
        validateQaReportV1(leaked, item.root, RUN_ID, { nowMs: NOW_MS }).code,
        'invalid-schema',
        summary,
      );
    }

    const safeTokenWording = {
      ...noBlocker,
      routes: structuredClone(item.report.routes),
      blocker: {
        code: 'sandbox' as const,
        summary: 'The Bearer authentication helper and browser process were unavailable.',
      },
    };
    for (const route of safeTokenWording.routes) {
      for (const viewport of route.viewports) viewport.status = 'blocked:sandbox';
    }
    assert.notEqual(
      validateQaReportV1(safeTokenWording, item.root, RUN_ID, { nowMs: NOW_MS }).code,
      'invalid-schema',
    );
  } finally {
    item.cleanup();
  }
});

test('requires consistent top-level and viewport statuses', () => {
  const item = fixture();
  try {
    const failedWithoutFailedViewport = { ...item.report, status: 'failed' as const };
    assert.equal(
      validateQaReportV1(failedWithoutFailedViewport, item.root, RUN_ID, { nowMs: NOW_MS }).code,
      'matrix-not-passed',
    );

    const blockedWithoutBlockedViewport = browserBlockedReport(item);
    for (const route of blockedWithoutBlockedViewport.routes) {
      for (const viewport of route.viewports) viewport.status = 'passed';
    }
    const noBlockedViewport = validateQaReportV1(
      blockedWithoutBlockedViewport,
      item.root,
      RUN_ID,
      { nowMs: NOW_MS },
    );
    assert.equal(noBlockedViewport.code, 'matrix-not-passed');
    assert.equal(isQaBrowserBridgeEligible(noBlockedViewport), false);

    const conflictingBlocker = browserBlockedReport(item);
    const mobile = conflictingBlocker.routes[0]?.viewports[0];
    if (mobile) mobile.status = 'blocked:timeout';
    assert.equal(
      validateQaReportV1(conflictingBlocker, item.root, RUN_ID, { nowMs: NOW_MS }).code,
      'matrix-not-passed',
    );

    const blockedWithKnownFailure = browserBlockedReport(item);
    const failingDesktop = blockedWithKnownFailure.routes[0]?.viewports[2];
    if (failingDesktop) failingDesktop.consoleErrorCount = 1;
    const knownFailureResult = validateQaReportV1(
      blockedWithKnownFailure,
      item.root,
      RUN_ID,
      { nowMs: NOW_MS },
    );
    assert.equal(knownFailureResult.code, 'matrix-not-passed');
    assert.equal(isQaBrowserBridgeEligible(knownFailureResult), false);
  } finally {
    item.cleanup();
  }
});

test('browser bridge metadata is exposed only after schema, identity, freshness, and width checks', () => {
  const item = fixture();
  try {
    const validCandidate = browserBlockedReport(item);
    delete validCandidate.routes[0]?.viewports[0]?.screenshotPath;
    delete validCandidate.routes[0]?.viewports[2]?.screenshotPath;
    assert.equal(
      isQaBrowserBridgeEligible(validateQaReportV1(validCandidate, item.root, RUN_ID, { nowMs: NOW_MS })),
      true,
    );

    const cases: QaReportV1[] = [];
    cases.push({ ...validCandidate, runId: 'wrong-run' });
    cases.push({ ...validCandidate, generatedAt: '2026-07-20T11:59:00.000Z' });
    const missingWidth = structuredClone(validCandidate);
    missingWidth.routes[0]?.viewports.splice(1, 1);
    cases.push(missingWidth);
    const inconsistent = structuredClone(validCandidate);
    const inconsistentMobile = inconsistent.routes[0]?.viewports[0];
    if (inconsistentMobile) inconsistentMobile.status = 'failed';
    cases.push(inconsistent);

    for (const report of cases) {
      const result = validateQaReportV1(report, item.root, RUN_ID, { nowMs: NOW_MS });
      assert.equal(isQaBrowserBridgeEligible(result), false, result.code);
      if (!result.ok) {
        assert.equal(result.browserBridgeEligible, undefined);
        assert.equal(result.status, undefined);
        assert.equal(result.blockerCode, undefined);
        assert.equal(result.report, undefined);
      }
    }

    const inventedPath = browserBlockedReport(item);
    const inventedMobile = inventedPath.routes[0]?.viewports[0];
    if (inventedMobile) inventedMobile.screenshotPath = '../../../../outside.png';
    const inventedResult = validateQaReportV1(inventedPath, item.root, RUN_ID, { nowMs: NOW_MS });
    assert.equal(inventedResult.code, 'invalid-screenshot');
    assert.equal(isQaBrowserBridgeEligible(inventedResult), false);
    assert.equal(inventedResult.status, undefined);
  } finally {
    item.cleanup();
  }
});

test('screenshot-only and Lighthouse-only files are not functional QA evidence', () => {
  const item = fixture();
  try {
    assert.equal(readQaReportV1(item.root, RUN_ID, { nowMs: NOW_MS }).code, 'report-missing');
    fs.writeFileSync(path.join(item.qaDirectory, 'lighthouse-report.json'), '{"categories":{}}');
    assert.equal(readQaReportV1(item.root, RUN_ID, { nowMs: NOW_MS }).code, 'report-missing');
  } finally {
    item.cleanup();
  }
});
