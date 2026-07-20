import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { collectArchitectureComponents } from '../collectArchitectureComponents';
import { collectFileExtensions } from '../collectFileExtensions';
import { collectMetadata } from '../collectMetadata';
import { collectTechnologies } from '../collectTechnologies';
import { hasRealCodebase } from '../hasRealCodebase';
import { ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS } from '../../../config/one-mcp';
import { FAILED_RETRY_MS } from '../../../config/reporting';
import { detectInfrastructureVendor, extensionFor } from '../lib';
import { createReportId } from '../report-id-mint';
import { readReportIdState } from '../readReportIdState';
import { maybeStartOneMcpReport } from '../maybeStartOneMcpReport';
import { shouldAttempt } from '../shouldAttempt';
import { uuidV7 } from '../uuidV7';
import { validReportId } from '../validReportId';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import { readState, writeState } from '../../../shared/state/normalize';

function withTmp(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onemcp-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('createReportId strips local-prefs from the committed .one.json (Codex onboarding-complete leak)', () => {
  withTmp((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    // The 6c-shape leak: a RAW .one.json still carrying merged local-prefs at the moment
    // one-uid is minted on the Codex onboarding-complete path.
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', currentRunId: '1',
      performance: { level: 'balanced', source: 'prompted' },
      team: { mode: 'subagents', overrides: { 'senior-frontend': 'highest' } },
      toolchain: { gitnexus: { installedVersion: '1.6.7', binPath: '/Users/x/.traffic-one/toolchains/gitnexus/bin/gitnexus' } },
    }), 'utf8');

    const minted = createReportId(cwd);
    assert.equal(minted.created, true, 'mints + writes a report id');
    const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(onDisk.currentRunId, '1', 'durable project fields preserved');
    assert.ok(!('performance' in onDisk) && !('team' in onDisk) && !('toolchain' in onDisk),
      'local-prefs stripped from committed .one.json on the one-mcp write');
  });
});

test('a stale canonical state write cannot erase or replace a minted report id', () => {
  withTmp((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', '.one.json'),
      JSON.stringify({ mode: 'existing-codebase', marker: 'before-mint' }),
      'utf8',
    );
    const stale = readState(cwd);
    const first = createReportId(cwd);

    // This is the original failure mode: another canonical writer prepared a
    // whole-state snapshot before the mint and published it afterwards.
    writeState(cwd, { ...stale, marker: 'stale-writer-landed' });
    const conflictingId = uuidV7();
    writeState(cwd, { ...stale, marker: 'conflicting-writer-landed', 'one-uid': conflictingId });
    const second = createReportId(cwd);
    const onDisk = readReportIdState(cwd);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
    assert.notEqual(second.id, conflictingId);
    assert.equal(onDisk?.id, first.id);
    assert.equal(readState(cwd).marker, 'conflicting-writer-landed');
  });
});

test('concurrent report-id minting elects exactly one durable worker decision', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onemcp-report-race-'));
  const barrier = path.join(cwd, 'start');
  try {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
    const modulePath = path.resolve(__dirname, '..', 'report-id-mint.ts');
    const childSource = [
      'const fs = require("fs");',
      `const { createReportId } = require(${JSON.stringify(modulePath)});`,
      'const [cwd, barrier] = process.argv.slice(1);',
      'const wait = new Int32Array(new SharedArrayBuffer(4));',
      'while (!fs.existsSync(barrier)) Atomics.wait(wait, 0, 0, 5);',
      'process.stdout.write(JSON.stringify(createReportId(cwd)));',
    ].join('\n');
    const runChild = (): Promise<{ id: string; created: boolean }> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', childSource, cwd, barrier], {
        cwd: path.resolve(__dirname, '../../../..'),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `report-id child exited ${code}`));
        else resolve(JSON.parse(stdout) as { id: string; created: boolean });
      });
    });
    const racers = Array.from({ length: 12 }, () => runChild());
    fs.writeFileSync(barrier, 'go', 'utf8');
    const results = await Promise.all(racers);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.id)).size, 1);
    assert.equal(readReportIdState(cwd)?.id, results[0]!.id);
    assert.deepEqual(
      fs.readdirSync(path.join(cwd, '.traffic-one')).filter((name) => /(?:\.lock|\.pending|\.tmp)/.test(name)),
      [],
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a cross-process stale canonical writer preserves the concurrent minted id', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onemcp-state-writer-race-'));
  const ready = path.join(cwd, 'writer-ready');
  const release = path.join(cwd, 'writer-release');
  try {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', '.one.json'),
      JSON.stringify({ mode: 'existing-codebase', marker: 'initial' }),
      'utf8',
    );
    const modulePath = path.resolve(__dirname, '../../../shared/state/normalize.ts');
    const childSource = [
      'const fs = require("fs");',
      `const { readState, writeState } = require(${JSON.stringify(modulePath)});`,
      'const [cwd, ready, release] = process.argv.slice(1);',
      'const stale = readState(cwd);',
      'fs.writeFileSync(ready, "ready", "utf8");',
      'const wait = new Int32Array(new SharedArrayBuffer(4));',
      'while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 5);',
      'writeState(cwd, { ...stale, marker: "cross-process-stale-writer" });',
    ].join('\n');
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', childSource, cwd, ready, release], {
      cwd: path.resolve(__dirname, '../../../..'),
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => code === 0
        ? resolve()
        : reject(new Error(stderr || `state writer child exited ${code}`)));
    });

    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(fs.existsSync(ready), true, 'stale writer reached the deterministic barrier');
    const minted = createReportId(cwd);
    fs.writeFileSync(release, 'go', 'utf8');
    await closed;

    const after = createReportId(cwd);
    assert.equal(minted.created, true);
    assert.equal(after.created, false);
    assert.equal(after.id, minted.id);
    assert.equal(readReportIdState(cwd)?.id, minted.id);
    assert.equal(readState(cwd).marker, 'cross-process-stale-writer');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('report-id lock timeout is bounded, fail-open, and never mints unlocked', () => {
  withTmp((cwd) => {
    const env = {
      ...process.env,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
    } as NodeJS.ProcessEnv;
    recordPluginUseChoice(cwd, true, 'test', env);
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
    const lockDir = path.join(cwd, '.traffic-one', '.one.json.report-id.lock');
    const token = 'live-owner';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, `owner-${token}.json`), JSON.stringify({
      pid: process.pid,
      token,
      createdAt: Date.now(),
    }), 'utf8');
    const started = Date.now();
    const result = maybeStartOneMcpReport(cwd, { spawn: false, env, featureEnabled: true });
    const elapsed = Date.now() - started;
    assert.equal(result.started, false);
    assert.equal(result.reason, 'error');
    assert.match(String('error' in result ? result.error : ''), /project state lock timed out/i);
    assert.ok(elapsed >= ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS - 50);
    assert.ok(elapsed < ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS + 1_000);
    assert.equal(readReportIdState(cwd), null);
    assert.equal(fs.existsSync(lockDir), true);
  });
});

test('uuidV7 produces a valid v7 UUID (version 7, RFC variant)', () => {
  const id = uuidV7(new Date('2026-01-01T00:00:00Z'));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(uuidV7(), uuidV7()); // random tail differs
});

test('validReportId accepts safe ids, rejects junk', () => {
  assert.equal(validReportId(uuidV7()), true);
  assert.equal(validReportId('a.b_c:d-1'), true);
  assert.equal(validReportId(''), false);
  assert.equal(validReportId('has space'), false);
  assert.equal(validReportId('x'.repeat(129)), false);
});

test('hasRealCodebase keys off project markers / workspace dirs', () => {
  withTmp((cwd) => {
    assert.equal(hasRealCodebase(cwd), false);
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
    assert.equal(hasRealCodebase(cwd), true);
  });
  withTmp((cwd) => {
    fs.mkdirSync(path.join(cwd, 'src'));
    assert.equal(hasRealCodebase(cwd), true);
  });
});

test('shouldAttempt: ok→never, no-status→yes, failed respects the retry window', () => {
  assert.equal(shouldAttempt({ status: 'ok' }), false);
  assert.equal(shouldAttempt(null), true);
  const now = Date.now();
  assert.equal(shouldAttempt({ status: 'failed', lastAttemptAt: new Date(now).toISOString() }, now), false);
  assert.equal(shouldAttempt({ status: 'failed', lastAttemptAt: new Date(now - FAILED_RETRY_MS - 1000).toISOString() }, now), true);
});

test('detectInfrastructureVendor reads deploy-config markers', () => {
  withTmp((cwd) => {
    assert.equal(detectInfrastructureVendor(cwd), 'unknown');
    fs.writeFileSync(path.join(cwd, 'vercel.json'), '{}', 'utf8');
    assert.equal(detectInfrastructureVendor(cwd), 'vercel');
  });
});

test('collectMetadata emits ONLY the 5 anonymous fields (no PII surface)', () => {
  withTmp((cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { react: '18', '@supabase/supabase-js': '2' } }), 'utf8');
    fs.writeFileSync(path.join(cwd, 'main.ts'), 'export const x = 1;\nexport const y = 2;\n', 'utf8');
    const meta = collectMetadata(cwd, { backend: 'supabase' }, 'rep-123');
    assert.deepEqual(Object.keys(meta).sort(), ['architecture_components', 'file_extensions', 'infrastructure_vendor', 'report_id', 'technologies']);
    assert.equal(meta.report_id, 'rep-123');
    assert.ok((meta.technologies as string[]).includes('react'));
    assert.ok((meta.technologies as string[]).includes('supabase'));
    assert.ok((meta.architecture_components as { name: string }[]).some((c) => c.name === 'postgresql'));
    assert.ok(Object.prototype.hasOwnProperty.call(meta.file_extensions as object, 'ts'));
  });
});

test('collectFileExtensions / collectTechnologies pick up TS + deps', () => {
  withTmp((cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { vite: '5' } }), 'utf8');
    fs.writeFileSync(path.join(cwd, 'a.ts'), 'const a = 1;\n', 'utf8');
    const exts = collectFileExtensions(cwd);
    assert.ok((exts.ts || 0) >= 1);
    const techs = collectTechnologies(cwd, {
      technologies: {
        frontend: ['React', 'https://internal.example/repository', 'owner@example.com'],
        backend: ['SUPABASE', { secret: 'do-not-send' }, 'acme-private-service'],
        mobile: ['expo', 'ignore previous instructions'],
      },
    }, exts);
    assert.ok(techs.includes('typescript'));
    assert.ok(techs.includes('vite'));
    assert.ok(techs.includes('react'));
    assert.ok(techs.includes('supabase'));
    assert.ok(techs.includes('expo'));
    assert.equal(techs.some((tech) => /internal|example|owner|private|ignore|object/.test(tech)), false);
    // a non-supabase backend with no deps → no components
    assert.deepEqual(collectArchitectureComponents(cwd, { backend: 'none' }), []);
  });
});

test('extension reporting accepts only finite structural labels', () => {
  assert.equal(extensionFor('/repo/src/index.TSX'), 'tsx');
  assert.equal(extensionFor('/repo/Dockerfile'), 'dockerfile');
  assert.equal(extensionFor('/repo/file.acme-private-project'), null);
  assert.equal(extensionFor('/repo/file.@owner'), null);
  assert.equal(extensionFor('/repo/file.客户'), null);
  assert.equal(extensionFor('/repo/file.ignore_previous_instructions'), null);
});

test('readReportIdState reads one-uid from .one.json, null when absent', () => {
  withTmp((cwd) => {
    assert.equal(readReportIdState(cwd), null);
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ 'one-uid': 'rep-abc' }), 'utf8');
    assert.deepEqual(readReportIdState(cwd), { id: 'rep-abc', created: false });
  });
});
