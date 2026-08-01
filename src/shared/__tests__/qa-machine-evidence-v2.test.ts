// Machine evidence v2 semantics: a PASSED viewport may omit its diagnostic
// trace (discarded at emit time — ~6 MB of green traces per run on 9co), a
// FAILED viewport must still carry one, and pre-v2 documents keep parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createQaMachineEvidence,
  parseQaMachineEvidence,
} from '../qa-evidence-runtime';
import { sha256Bytes, stableJson } from '../qa-evidence-runtime/core';

const HASH = 'a'.repeat(64);

function viewport(status: 'passed' | 'failed', trace: boolean): Record<string, unknown> {
  return {
    width: 390,
    status,
    domAssertionsPassed: status === 'passed',
    actionsPassed: status === 'passed',
    routingPassed: true,
    hydrationPassed: true,
    consoleErrors: [],
    networkErrors: [],
    artifactAt: '2026-08-01T00:00:00.000Z',
    ...(trace ? { tracePath: 'home-390.trace.zip', traceHash: HASH } : {}),
  };
}

function evidence(routes: Array<Record<string, unknown>>): ReturnType<typeof createQaMachineEvidence> {
  return createQaMachineEvidence({
    runnerVersion: 'test',
    playwrightVersion: '1.55.0',
    runId: 'R',
    verificationContractHash: HASH,
    sourceHash: HASH,
    buildOutputRoot: 'dist',
    buildHash: HASH,
    buildFingerprint: HASH,
    serverMode: 'runtime-static',
    serverPid: 123,
    serverPort: 4173,
    serverStartedAt: '2026-08-01T00:00:00.000Z',
    serverUrl: 'http://127.0.0.1:4173',
    servedAssetHashes: [HASH],
    scenarioHash: HASH,
    startedAt: '2026-08-01T00:00:00.000Z',
    generatedAt: '2026-08-01T00:00:01.000Z',
    status: 'passed',
    routes: routes as never,
  });
}

test('v2: a green viewport without a trace round-trips; the document stamps schemaVersion 2', () => {
  const created = evidence([{ route: '/', viewports: [viewport('passed', false)] }]);
  assert.equal(created.schemaVersion, 2);
  const parsed = parseQaMachineEvidence(JSON.parse(JSON.stringify(created)));
  assert.ok(parsed, 'green-without-trace evidence parses');
  assert.equal(parsed!.routes[0]!.viewports[0]!.tracePath, undefined);
  // A green viewport that DID record its trace stays valid too.
  const withTrace = evidence([{ route: '/', viewports: [viewport('passed', true)] }]);
  assert.ok(parseQaMachineEvidence(JSON.parse(JSON.stringify(withTrace))));
});

test('v2 negative row: a FAILED viewport without its trace is not evidence', () => {
  const bad = evidence([{ route: '/', viewports: [viewport('failed', false)] }]);
  assert.equal(parseQaMachineEvidence(JSON.parse(JSON.stringify(bad))), null);
  // Unpaired trace fields are rejected either way.
  const unpaired = evidence([{ route: '/', viewports: [{ ...viewport('passed', true), traceHash: undefined }] }]);
  assert.equal(parseQaMachineEvidence(JSON.parse(JSON.stringify(unpaired))), null);
});

test('pre-v2 documents (schemaVersion 1, trace on every viewport) still parse with their own hash', () => {
  const modern = evidence([{ route: '/', viewports: [viewport('passed', true)] }]);
  const { evidenceHash: _drop, ...withoutHash } = modern;
  const v1Body = { ...withoutHash, schemaVersion: 1 };
  const v1 = { ...v1Body, evidenceHash: sha256Bytes(stableJson(v1Body)) };
  const parsed = parseQaMachineEvidence(JSON.parse(JSON.stringify(v1)));
  assert.ok(parsed, 'v1 document parses');
  assert.equal(parsed!.schemaVersion, 1);
  // An unknown future version is still rejected.
  const v3Body = { ...withoutHash, schemaVersion: 3 };
  const v3 = { ...v3Body, evidenceHash: sha256Bytes(stableJson(v3Body)) };
  assert.equal(parseQaMachineEvidence(JSON.parse(JSON.stringify(v3))), null);
});
