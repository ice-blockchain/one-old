#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  computeProjectFingerprint,
  missingToolInstallPrompt,
  runSecurityCheck,
} = require('./security-check-runner.cjs');
const { getPluginVersion } = require('./hook-runtime/state/state.cjs');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function withTempDir(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-one-security-test-'));
  try {
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeFile(cwd, relPath, content) {
  const fullPath = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function withEnv(env, fn) {
  const old = {};
  for (const key of Object.keys(env)) {
    old[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function makeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function makeFakeTools(cwd) {
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  makeExecutable(path.join(bin, 'gitleaks'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "gitleaks version 8.30.1"; exit 0; fi',
    'report=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--report-path" ]; then shift; report="$1"; fi',
    '  shift',
    'done',
    'if [ -n "$report" ]; then mkdir -p "$(dirname "$report")"; printf "[]\\n" > "$report"; fi',
    'exit 0',
    '',
  ].join('\n'));
  makeExecutable(path.join(bin, 'trufflehog'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "trufflehog v3.94.3"; exit 0; fi',
    'exit 0',
    '',
  ].join('\n'));
  makeExecutable(path.join(bin, 'npm'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "10.0.0"; exit 0; fi',
    'printf "%s\\n" "{\\"metadata\\":{\\"vulnerabilities\\":{\\"high\\":0,\\"critical\\":0}}}"',
    'exit 0',
    '',
  ].join('\n'));
  return bin;
}

function runWithFakeTools(cwd, options = {}) {
  const bin = makeFakeTools(cwd);
  return withEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` }, () =>
    runSecurityCheck({ cwd, strict: true, ...options }));
}

function makeCleanWebProject(cwd) {
  writeFile(cwd, 'package.json', JSON.stringify({
    dependencies: { react: '^18.0.0' },
  }, null, 2));
  writeFile(cwd, 'package-lock.json', '{}\n');
  writeFile(cwd, '_headers', [
    '/*',
    '  Content-Security-Policy: default-src \'self\'; frame-ancestors \'none\'',
    '  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=()',
    '',
  ].join('\n'));
  writeFile(cwd, 'supabase/migrations/001_init.sql', [
    'create table public.todos (',
    '  id uuid primary key,',
    '  user_id uuid not null',
    ');',
    'alter table public.todos enable row level security;',
    'create policy "Users can read their todos"',
    'on public.todos for select',
    'to authenticated',
    'using ((select auth.uid()) = user_id);',
    '',
  ].join('\n'));
}

test('missing gitleaks and trufflehog fail strict mode', () => {
  withTempDir((cwd) => {
    const result = withEnv({ PATH: path.join(cwd, 'missing-bin') }, () =>
      runSecurityCheck({ cwd, strict: true }));

    assert.equal(result.report.status, 'failed');
    assert.match(JSON.stringify(result.report.issues), /gitleaks/);
    assert.match(JSON.stringify(result.report.issues), /trufflehog/);
    assert.match(result.report.installPrompt, /Benefits of installing them/);
    assert.match(result.report.installPrompt, /install Homebrew first/);
  });
});

test('missing tool prompt explains benefits and brew path', () => {
  withTempDir((cwd) => {
    const bin = path.join(cwd, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    makeExecutable(path.join(bin, 'brew'), [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "Homebrew 4.0.0"; exit 0; fi',
      'exit 0',
      '',
    ].join('\n'));

    const prompt = withEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` }, () =>
      missingToolInstallPrompt(['gitleaks', 'trufflehog'], cwd));

    assert.match(prompt, /gitleaks scans the working tree and full git history/);
    assert.match(prompt, /trufflehog verifies\/flags known and unknown secrets/);
    assert.match(prompt, /brew install gitleaks trufflehog/);
  });
});

test('secret-like values in client source fail', () => {
  withTempDir((cwd) => {
    writeFile(cwd, 'src/config.ts', 'export const key = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY;\n');

    const result = runWithFakeTools(cwd);

    assert.equal(result.report.status, 'failed');
    assert.match(JSON.stringify(result.report.issues), /Client-prefixed environment variable/);
  });
});

test('documented dangerous patterns and test fixtures do not fail app heuristics', () => {
  withTempDir((cwd) => {
    writeFile(cwd, 'package.json', JSON.stringify({ dependencies: {} }, null, 2));
    writeFile(cwd, 'package-lock.json', '{}\n');
    writeFile(cwd, 'rules/common/security.md', [
      '# Security docs',
      'Never use dangerouslySetInnerHTML without sanitization.',
      'Admin access must not be gated only in client/UI code.',
      '',
    ].join('\n'));
    writeFile(cwd, 'skills/create-service/SKILL.md', [
      '# Upload docs',
      'When using storage.from().upload(), validate MIME type and size.',
      '',
    ].join('\n'));
    writeFile(cwd, 'scripts/test-security-check-runner.cjs', [
      'export const fixture = "import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY";',
      '',
    ].join('\n'));

    const result = runWithFakeTools(cwd);

    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.issues.length, 0);
  });
});

test('public table without RLS fails', () => {
  withTempDir((cwd) => {
    writeFile(cwd, 'supabase/migrations/001.sql', 'create table public.todos (id uuid primary key);\n');

    const result = runWithFakeTools(cwd);

    assert.equal(result.report.status, 'failed');
    assert.match(JSON.stringify(result.report.issues), /without enabling RLS/);
  });
});

test('public Supabase Storage bucket fails', () => {
  withTempDir((cwd) => {
    writeFile(cwd, 'supabase/migrations/001_storage.sql', [
      "insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);",
      '',
    ].join('\n'));

    const result = runWithFakeTools(cwd);

    assert.equal(result.report.status, 'failed');
    assert.match(JSON.stringify(result.report.issues), /bucket is public/);
  });
});

test('clean web project passes and writes reports', () => {
  withTempDir((cwd) => {
    makeCleanWebProject(cwd);

    const result = runWithFakeTools(cwd);

    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.issues.length, 0);
    assert.equal(fs.existsSync(result.paths.jsonPath), true);
    assert.equal(fs.existsSync(result.paths.markdownPath), true);
  });
});

test('passing stamp writes lastSecurityCheck fields', () => {
  withTempDir((cwd) => {
    makeCleanWebProject(cwd);
    writeFile(cwd, '.traffic-one/.one.json', JSON.stringify({
      stack: 'react-realtime-monorepo',
      version: 3,
      pluginVersion: '2.0.0',
    }, null, 2));

    const result = runWithFakeTools(cwd, { stamp: true });
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));

    assert.equal(result.report.status, 'passed');
    assert.equal(state.version, getPluginVersion());
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'pluginVersion'), false);
    assert.equal(state.lastSecurityCheckStatus, 'passed');
    assert.equal(state.lastSecurityCheckFingerprint, result.report.fingerprint.fingerprint);
    assert.match(state.lastSecurityCheckReport, /^\.traffic-one\/reports\/security\//);
  });
});

test('traffic-one stamp fields do not change project fingerprint', () => {
  withTempDir((cwd) => {
    writeFile(cwd, '.traffic-one/.one.json', JSON.stringify({ stack: 'react-realtime-monorepo' }, null, 2));
    const before = computeProjectFingerprint(cwd).fingerprint;
    writeFile(cwd, '.traffic-one/.one.json', JSON.stringify({
      stack: 'react-realtime-monorepo',
      lastShipperApprovalAt: new Date().toISOString(),
      lastSecurityCheckAt: new Date().toISOString(),
      lastSecurityCheckStatus: 'passed',
      lastSecurityCheckFingerprint: before,
      lastSecurityCheckReport: '.traffic-one/reports/security/security-check-test.json',
    }, null, 2));
    const after = computeProjectFingerprint(cwd).fingerprint;

    assert.equal(after, before);
  });
});

test('stamp-only traffic-one state is ignored by fingerprint', () => {
  withTempDir((cwd) => {
    const before = computeProjectFingerprint(cwd).fingerprint;
    writeFile(cwd, '.traffic-one/.one.json', JSON.stringify({
      lastSecurityCheckAt: new Date().toISOString(),
      lastSecurityCheckStatus: 'passed',
      lastSecurityCheckFingerprint: before,
      lastSecurityCheckReport: '.traffic-one/reports/security/security-check-test.json',
    }, null, 2));
    const after = computeProjectFingerprint(cwd).fingerprint;

    assert.equal(after, before);
  });
});

let failed = 0;

for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error.stack || error.message);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} test(s) passed.`);
}
