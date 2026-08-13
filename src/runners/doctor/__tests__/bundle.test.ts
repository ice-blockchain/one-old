// src/runners/doctor/__tests__/bundle.test.ts
// `doctor --bundle` is the one doctor output a user is invited to PASTE
// SOMEWHERE PUBLIC, so its redaction is the only thing standing between a bug
// report and a leaked prompt. These tests plant every category the policy
// claims to cover — prompt text, onboarding answers, an API key, a session
// token, and a decision-log `inputs` payload — into the probe inputs and
// assert none of it reaches the emitted bundle, while the structural state a
// maintainer actually needs still does.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDoctorBundle, isSensitiveBundleKey, looksLikeSecretValue, type BuildDoctorBundleInput } from '../bundle';
import type { ProjectProbe } from '../probes';
import type { DecisionRecord } from '../../../shared/state/decision-log';

const PROMPT = 'PLANTED-PROMPT-build-me-a-crypto-exchange-for-my-employer';
const SUMMARY = 'PLANTED-SUMMARY-internal-product-plan';
const ANSWER = 'PLANTED-ANSWER-we-use-a-private-fork-of-supabase';
const API_KEY = 'sk-PLANTED-APIKEY-0123456789abcdef';
const SESSION_TOKEN = 'PLANTED-SESSION-TOKEN-eyJhbGciOiJIUzI1NiJ9';
const BEARER = 'PLANTED-BEARER-abcdef';
const COOKIE = 'PLANTED-COOKIE-sid=42';
const CIPHER = 'PLANTED-REFRESH-CIPHERTEXT';
const DECISION_INPUT_PROMPT = 'PLANTED-DECISION-INPUT-prompt-text';
const STATE_WRITE_VALUE = 'PLANTED-STATE-WRITE-fragment';

const PLANTED = [PROMPT, SUMMARY, ANSWER, API_KEY, SESSION_TOKEN, BEARER, COOKIE, CIPHER, DECISION_INPUT_PROMPT, STATE_WRITE_VALUE];

function project(over: Partial<ProjectProbe> = {}): ProjectProbe {
  const state = {
    mode: 'existing-codebase',
    stack: 'default',
    currentRunId: 'run-1',
    projectContext: { originalPrompt: PROMPT, summary: SUMMARY, answers: { goal: ANSWER } },
    auth: { apiKey: API_KEY, authenticated: true },
    sessionToken: SESSION_TOKEN,
    refreshTokenCiphertext: CIPHER,
    sessionCookieJar: COOKIE,
    // Innocent neighbours: `private` is a boolean FLAG (shape must stay
    // legible), and path/patch/monkeyBars only contain the short sensitive
    // words as substrings — a substring matcher would eat all three.
    private: true,
    path: '/repo/apps/web',
    patch: 'apply-clean',
    monkeyBars: 'kept',
    compatibility: 'kept',
  };
  return {
    cwd: '/repo',
    hasState: true,
    state,
    normalizedState: { ...state },
    localPreferences: { pluginUse: { enabled: true }, oneMcpBearer: BEARER },
    localPreferencesPath: '/home/dev/.traffic-one/projects/repo.json',
    hasLocalPreferences: true,
    nvmrc: null,
    hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
    runState: {
      currentRunId: 'run-1',
      runDirExists: true,
      runJsonExists: true,
      runJsonStatus: 'active',
      hasOrchestratedArtifacts: false,
      maintenanceJsonExists: false,
      maintenanceOutcome: null,
      maintenanceOverallOutcome: null,
      maintenanceOpencodeOutcome: null,
      maintenanceFallbackAllowed: false,
      maintenanceTerminalOrFallbackPending: false,
    },
    nestedTrafficOneRoots: [],
    openCodeCli: 'managed',
    legacyCapabilityMigration: { status: 'not-applicable', message: null },
    ...over,
  };
}

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: '2026-08-04T10:00:00.000Z',
    correlationId: 'run-1:7:1234',
    runId: 'run-1',
    hookSeq: 7,
    pid: 1234,
    event: 'UserPromptSubmit',
    host: 'claude',
    decision: 'deny',
    gateId: 'plan-guard',
    denyId: 'plan-write-denied',
    denyTarget: 'src/app.tsx',
    repeatCount: 3,
    inputs: { hostHookPoint: 'UserPromptSubmit', prompt: DECISION_INPUT_PROMPT, tool: { command: 'rm -rf /' } },
    stateWrites: [{ path: '.traffic-one/.one.json', value: STATE_WRITE_VALUE } as never],
    ...over,
  };
}

function bundleInput(over: Partial<BuildDoctorBundleInput> = {}): BuildDoctorBundleInput {
  return {
    summary: 'HEALTHY',
    plugin: {
      version: '1.2.3',
      contentHash: 'abc',
      root: '/home/dev/plugin',
      layout: 'installed',
      source: 'TRAFFIC_ONE_PLUGIN_ROOT',
      host: null,
      hostEvidence: { present: [], absent: ['--host=', 'CLAUDE_PLUGIN_ROOT'] },
    },
    node: { runningMajor: 22, runningVersion: '22.0.0', onPath: '/usr/bin/node', requiredMajor: 22, pluginRequiredMajor: 22 },
    nvm: { installed: false },
    gitnexus: { onPath: null, absoluteV22: null, crashRiskInOldNvm: false },
    project: project(),
    codexHooks: null,
    auth: { filePath: '/home/dev/.traffic-one/one.json', present: true, valid: true, updatedAt: '2026-08-01T00:00:00Z' },
    oneMcp: null,
    openCodeMcp: null,
    pluginRoot: {
      root: '/home/dev/plugin',
      layout: 'installed',
      source: 'TRAFFIC_ONE_PLUGIN_ROOT',
      contentProvenancePath: '/home/dev/plugin/build-provenance.json',
      runtimeProvenancePath: '/home/dev/plugin/scripts/build-provenance.json',
      contentProvenance: { gitSha: 'sha1', sourceHash: 'abc' },
      runtimeProvenance: { gitSha: 'sha1', sourceHash: 'abc' },
      layerMismatch: false,
    },
    sessionDiagnostics: null,
    findings: [{ severity: 'fix-needed', code: 'GHOST_CURRENT_RUN_ID', message: 'currentRunId run-1 has no run directory' }],
    runId: 'run-1',
    runDiagnostic: null,
    decisions: [decision()],
    ...over,
  };
}

test('--bundle emits no planted prompt text, answer, key, token, or decision input', () => {
  const serialized = JSON.stringify(buildDoctorBundle(bundleInput()));
  for (const planted of PLANTED) {
    assert.equal(serialized.includes(planted), false, `bundle leaked ${planted}`);
  }
});

test('--bundle keeps the structural state a maintainer needs, and the shape of what it redacts', () => {
  const bundle = buildDoctorBundle(bundleInput());
  const state = bundle.probes.project.state as Record<string, unknown>;
  assert.equal(state.mode, 'existing-codebase');
  assert.equal(state.stack, 'default');
  assert.equal(state.currentRunId, 'run-1');
  // Redacted leaf VALUES, with the keys still present so the shape is legible.
  const context = state.projectContext as Record<string, unknown>;
  assert.deepEqual(context, { originalPrompt: '[redacted]', summary: '[redacted]', answers: '[redacted]' });
  assert.equal((state.auth as Record<string, unknown>).apiKey, '[redacted]');
  assert.equal((state.auth as Record<string, unknown>).authenticated, true, 'a non-string sibling is untouched');
  assert.equal(state.sessionToken, '[redacted]');
  assert.equal(state.refreshTokenCiphertext, '[redacted]');
  assert.equal(state.sessionCookieJar, '[redacted]');
  // Non-string values and innocent lookalike keys survive verbatim.
  assert.equal(state.private, true);
  assert.equal(state.path, '/repo/apps/web');
  assert.equal(state.patch, 'apply-clean');
  assert.equal(state.monkeyBars, 'kept');
  assert.equal(state.compatibility, 'kept');
  assert.equal((bundle.probes.project.localPreferences.pluginUse as Record<string, unknown>).enabled, true);
  assert.equal(bundle.probes.project.localPreferences.oneMcpBearer, '[redacted]');
  // The normalized copy is redacted too — it is the same content, twice.
  assert.equal(((bundle.probes.project.normalizedState as Record<string, unknown>).projectContext as Record<string, unknown>).originalPrompt, '[redacted]');
});

test('--bundle drops decision-log inputs and stateWrites entirely, keeping the verdict', () => {
  const bundle = buildDoctorBundle(bundleInput());
  const record = bundle.decisions.records[0] as unknown as Record<string, unknown>;
  assert.equal('inputs' in record, false, 'inputs is dropped, not redacted');
  assert.equal('stateWrites' in record, false, 'stateWrites is dropped, not redacted');
  assert.equal('pid' in record, false);
  assert.deepEqual(record, {
    ts: '2026-08-04T10:00:00.000Z',
    correlationId: 'run-1:7:1234',
    runId: 'run-1',
    hookSeq: 7,
    event: 'UserPromptSubmit',
    host: 'claude',
    decision: 'deny',
    gateId: 'plan-guard',
    denyId: 'plan-write-denied',
    denyTarget: 'src/app.tsx',
    repeatCount: 3,
  });
});

test('--bundle carries the override completeness probe, which is what a wedged project is about', () => {
  // The bundle is what gets pasted into a bug report titled "nothing will
  // certify". It had no override section at all, so the one probe that explains
  // that state was the one thing missing from it. Nothing here is sensitive:
  // counts, states, and check ids that settlement already writes into run.json.
  const overrides = {
    active: [], unvouchable: 0, forgedLines: 0, malformedLines: 0, runMinted: 0, ledger: 'absent' as const,
    duplicateLines: 0, orphanSnapshots: 1, mintCounter: 'verified' as const, mintCounterCount: 2,
    vouchableMints: 1, mintCounterWritable: true, snapshotScanAsked: true, reconciliations: 0, excused: [],
    discrepancies: ['override-snapshot-orphaned'], repairCommand: 'node doctor.cjs --reconcile-overrides',
  };
  const bundle = buildDoctorBundle(bundleInput({ overrides }));
  assert.deepEqual(bundle.probes.overrides?.discrepancies, ['override-snapshot-orphaned']);
  assert.equal(bundle.probes.overrides?.orphanSnapshots, 1);
  // The verdict itself, which this artifact carried the findings for and never
  // stated: a reader of an attached bundle could not tell HEALTHY from wedged
  // without re-deriving it from the severities.
  assert.equal(buildDoctorBundle(bundleInput({ summary: 'ACTION_NEEDED' })).summary, 'ACTION_NEEDED');
  // A caller that never collected it is a `null` section rather than an absent
  // one, so a reader can tell "not asked" from "clean".
  assert.equal(buildDoctorBundle(bundleInput()).probes.overrides, null);
});

test('--bundle caps the decision tail and reports both counts', () => {
  const decisions = Array.from({ length: 305 }, (_, index) => decision({ hookSeq: index, denyId: `deny-${index}` }));
  const bundle = buildDoctorBundle(bundleInput({ decisions }));
  assert.equal(bundle.decisions.totalCount, 305);
  assert.equal(bundle.decisions.includedCount, 300);
  // The TAIL, not the head: the decisions nearest the wedge are the useful ones.
  assert.equal(bundle.decisions.records[0]?.denyId, 'deny-5');
  assert.equal(bundle.decisions.records[299]?.denyId, 'deny-304');
});

// ── credential SHAPES, whatever the key is called ────────────────────────────
// The key-name pass is only as good as the naming. Every row below is a live
// credential the bundle emitted VERBATIM while its own policy said "no secrets
// … by design" — which is the sentence a user weighs when deciding to paste the
// bundle into a public issue.

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJQTEFOVEVEIn0.PLANTED-signature-value';

test('a value-shape pass redacts credentials that no key name gives away', () => {
  const seeded: Record<string, string> = {
    databaseUrl: 'postgres://admin:PLANTED-DBPASS@db.internal:5432/prod',
    supabaseConnection: 'postgresql://svc:PLANTED-DBPASS@aws-0.pooler.supabase.com:6543/postgres',
    notes: 'remember: sk-proj-PLANTEDaaaaaaaaaaaaaaaa is the prod key',
    deployCommand: `curl -H "Authorization: Bearer ${JWT}" https://api.example.com/deploy`,
    ciVariable: 'ghp_PLANTEDaaaaaaaaaaaaaaaaaaaaaaaaaa',
    terraformOutput: 'AKIAPLANTED1234567XY',
    identity: '-----BEGIN OPENSSH PRIVATE KEY-----\nPLANTED\n-----END OPENSSH PRIVATE KEY-----',
  };
  const bundle = buildDoctorBundle(bundleInput({
    project: project({
      state: { mode: 'existing-codebase', ...seeded, nested: { deeper: { innocent: JWT } }, trail: ['harmless', `Bearer ${JWT}`] },
      normalizedState: null,
    }),
  }));
  const state = bundle.probes.project.state as Record<string, unknown>;
  for (const key of Object.keys(seeded)) {
    assert.equal(state[key], '[redacted]', `${key} (${seeded[key]}) must not survive`);
  }
  // Recursively, through objects AND arrays — a JWT does not become safe by
  // sitting two levels down under a reassuring key name.
  assert.deepEqual(state.nested, { deeper: { innocent: '[redacted]' } });
  assert.deepEqual(state.trail, ['harmless', '[redacted]']);
  assert.equal(JSON.stringify(bundle).includes('PLANTED'), false, 'no planted credential survives anywhere');
  // Structural state is untouched: the pass must not eat the report.
  assert.equal(state.mode, 'existing-codebase');
});

test('the value-shape pass does not eat ordinary diagnostic strings', () => {
  // Over-redaction costs a bug report its diagnostic value, so the shapes are
  // anchored: an ordinary URL, a localhost port, an SSH remote and a plain
  // base64 blob are all NOT credential pairs.
  for (const value of [
    'https://api.example.com/deploy',
    'http://127.0.0.1:3000/health',
    'git@github.com:ice-blockchain/one.git',
    '/Users/dev/.traffic-one/projects/abc/preferences.json',
    'eyJhbGciOiJIUzI1NiJ9',
    'sk-short',
    'node scripts/doctor.cjs --bundle',
  ]) {
    assert.equal(looksLikeSecretValue(value), false, `must stay readable: ${value}`);
  }
  for (const value of [
    'sk-proj-abcdefghijklmnopqrst',
    'ghp_abcdefghijklmnopqrstuvwxyz01',
    'ASIAABCDEFGHIJKLMNOP',
    JWT,
    'authorization: bearer abc123',
    'mysql://root:hunter2@127.0.0.1:3306/app',
    '-----BEGIN RSA PRIVATE KEY-----',
  ]) {
    assert.equal(looksLikeSecretValue(value), true, `must be redacted: ${value}`);
  }
});

test('the emitted redaction policy states what it does NOT protect', () => {
  const bundle = buildDoctorBundle(bundleInput());
  // A policy that only lists what is safe reads as "safe to paste anywhere".
  assert.match(bundle.redaction.policy, /ABSOLUTE FILESYSTEM PATHS ARE INCLUDED/);
  assert.match(bundle.redaction.policy, /OS account name/);
  assert.match(bundle.redaction.policy, /inputs\/stateWrites are dropped/);
  assert.match(bundle.redaction.redactsKeysMatching, /token/);
  assert.match(bundle.redaction.redactsKeysMatching, /whole word in \{[^}]*\bkey\b/);
  // The overclaim this replaces: "No user source code, prompt text, or secrets
  // are included by design" was the sentence a reader trusted while the bundle
  // shipped a live `postgres://user:pass@host`. No regex set catches every
  // secret, so the policy must not promise that one does.
  assert.equal(/secrets are included by design/.test(bundle.redaction.policy), false);
  assert.match(bundle.redaction.policy, /BEST-EFFORT, NOT A GUARANTEE/);
  assert.match(bundle.redaction.policy, /READ THIS BUNDLE BEFORE SHARING IT/);
  assert.match(bundle.redaction.policy, /no pattern set recognises every secret/);
  // …and the value shapes it DOES look for are enumerated, so "best-effort" is
  // a scope a reader can check rather than a disclaimer.
  assert.match(bundle.redaction.redactsValuesMatching, /JWT/);
  assert.match(bundle.redaction.redactsValuesMatching, /scheme:\/\/user:pass@host/);
  assert.match(bundle.redaction.redactsValuesMatching, /PEM private key/);
  // …and the paths it admits to including are really there, so the warning is
  // not theatre a reader can dismiss.
  assert.equal(bundle.plugin.root, '/home/dev/plugin');
  assert.equal(bundle.probes.pluginRoot.contentProvenancePath, '/home/dev/plugin/build-provenance.json');
});

test('isSensitiveBundleKey: unambiguous words match as substrings, short words only as whole tokens', () => {
  for (const key of [
    'token', 'accessToken', 'apiKey', 'api_key', 'API-KEY', 'secret', 'clientSecret', 'password', 'passwd',
    'authorization', 'authorisation', 'credential', 'bearerToken', 'jwt', 'cookieJar', 'signature', 'hmacDigest',
    'privateKey', 'refreshTokenCiphertext', 'sessionCookieJar',
  ]) {
    assert.equal(isSensitiveBundleKey(key), true, `${key} must be treated as sensitive`);
  }
  for (const key of ['key', 'keys', 'pat', 'refresh', 'sig', 'salt', 'nonce', 'API_KEY', 'gh_pat']) {
    assert.equal(isSensitiveBundleKey(key), true, `${key} must match as a whole token`);
  }
  for (const key of [
    'path', 'patch', 'compatible', 'monkey', 'keyboard', 'signal', 'design', 'insignificant',
    'mode', 'stack', 'currentRunId', 'privacyPolicyAccepted',
  ]) {
    assert.equal(isSensitiveBundleKey(key), false, `${key} must NOT be treated as sensitive`);
  }
  // `private` is a substring match by design (privateKey, privateRepoUrl); the
  // boolean-flag case is protected by redact() only touching string values,
  // which the state test above pins.
  assert.equal(isSensitiveBundleKey('privacyPolicyAccepted'), false);
  assert.equal(isSensitiveBundleKey('private'), true);
});

test('redaction reaches into arrays and nested objects, not just top-level keys', () => {
  const bundle = buildDoctorBundle(bundleInput({
    project: project({
      state: {
        mode: 'existing-codebase',
        hosts: [{ name: 'codex', apiKey: API_KEY }, { name: 'cursor', apiKey: `${API_KEY}-2` }],
        deep: { deeper: { authorization: `Bearer ${SESSION_TOKEN}` } },
      },
      normalizedState: null,
    }),
  }));
  const serialized = JSON.stringify(bundle);
  assert.equal(serialized.includes('PLANTED-APIKEY'), false);
  assert.equal(serialized.includes('PLANTED-SESSION-TOKEN'), false);
  assert.match(serialized, /"name":"codex"/, 'the surrounding structure survives');
});
