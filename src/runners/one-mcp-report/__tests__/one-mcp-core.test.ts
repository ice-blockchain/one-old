import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { collectArchitectureComponents } from '../collectArchitectureComponents';
import { collectFileExtensions } from '../collectFileExtensions';
import { collectMetadata } from '../collectMetadata';
import { collectTechnologies } from '../collectTechnologies';
import { hasRealCodebase } from '../hasRealCodebase';
import { FAILED_RETRY_MS } from '../../../config/reporting';
import { detectInfrastructureVendor } from '../lib';
import { readReportIdState } from '../readReportIdState';
import { shouldAttempt } from '../shouldAttempt';
import { uuidV7 } from '../uuidV7';
import { validReportId } from '../validReportId';

function withTmp(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onemcp-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

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
    const techs = collectTechnologies(cwd, {}, exts);
    assert.ok(techs.includes('typescript'));
    assert.ok(techs.includes('vite'));
    // a non-supabase backend with no deps → no components
    assert.deepEqual(collectArchitectureComponents(cwd, { backend: 'none' }), []);
  });
});

test('readReportIdState reads one-uid from .one.json, null when absent', () => {
  withTmp((cwd) => {
    assert.equal(readReportIdState(cwd), null);
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ 'one-uid': 'rep-abc' }), 'utf8');
    assert.deepEqual(readReportIdState(cwd), { id: 'rep-abc', created: false });
  });
});
