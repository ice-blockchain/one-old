import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { generateGraphPreview, writeGraphPreview } from '../graph-preview';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-graphprev-'));
}

test('generateGraphPreview (graphify) lists section headings', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one', 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'graphify-out', 'GRAPH_REPORT.md'), '# Title\n\n## auth\nx\n\n## billing\ny\n', 'utf8');
    const body = generateGraphPreview(dir, 'graphify');
    assert.ok(body);
    assert.ok(body?.includes('Provider: graphify · 2 top-level section(s):'));
    assert.ok(body?.includes('- auth'));
    assert.ok(body?.includes('- billing'));
    assert.ok(body?.includes('Read `.traffic-one/graphify-out/GRAPH_REPORT.md`'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generateGraphPreview (gitnexus) reads index.json modules', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one', '.gitnexus'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.gitnexus', 'index.json'), JSON.stringify({ modules: [{ name: 'core' }, { path: 'pkg/ui' }] }), 'utf8');
    const body = generateGraphPreview(dir, 'gitnexus');
    assert.ok(body?.includes('Provider: gitnexus · 2 top-level module(s):'));
    assert.ok(body?.includes('- core'));
    assert.ok(body?.includes('- pkg/ui'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generateGraphPreview (gitnexus) falls back when index.json is absent', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one', '.gitnexus'), { recursive: true });
    const body = generateGraphPreview(dir, 'gitnexus');
    assert.ok(body?.includes('graph available at `.traffic-one/.gitnexus/`'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generateGraphPreview returns null for missing artefacts / unknown provider', () => {
  const dir = tmp();
  try {
    assert.equal(generateGraphPreview(dir, 'graphify'), null);
    assert.equal(generateGraphPreview(dir, 'gitnexus'), null);
    assert.equal(generateGraphPreview(dir, 'whatever'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeGraphPreview writes .traffic-one/graph-preview.md (and is a no-op without a graph)', () => {
  const dir = tmp();
  try {
    assert.equal(writeGraphPreview(dir, 'graphify'), false);
    fs.mkdirSync(path.join(dir, '.traffic-one', 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'graphify-out', 'GRAPH_REPORT.md'), '## a\n', 'utf8');
    assert.equal(writeGraphPreview(dir, 'graphify'), true);
    const written = fs.readFileSync(path.join(dir, '.traffic-one', 'graph-preview.md'), 'utf8');
    assert.ok(written.includes('Provider: graphify'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
