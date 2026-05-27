import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { collectHandlers, discoverDescriptors, loadModules } from '../registry';

function mkModules(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-reg-'));
  const runtime = path.join(root, 'demo-runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(
    path.join(runtime, 'module.json'),
    JSON.stringify({ id: 'demo-runtime', kind: 'runtime', entry: 'handlers' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(runtime, 'handlers.js'),
    "module.exports = { handlers: [{ id: 'h1', event: 'PreToolUse', priority: 0, run: () => ({ kind: 'noop' }) }] };",
    'utf8',
  );
  const content = path.join(root, 'demo-content');
  fs.mkdirSync(content, { recursive: true });
  fs.writeFileSync(
    path.join(content, 'module.json'),
    JSON.stringify({ id: 'demo-content', kind: 'content' }),
    'utf8',
  );
  return root;
}

test('discoverDescriptors finds module.json folders sorted by id', () => {
  const root = mkModules();
  try {
    assert.deepEqual(
      discoverDescriptors(root).map((d) => d.descriptor.id),
      ['demo-content', 'demo-runtime'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadModules loads runtime handlers and ignores content modules', () => {
  const root = mkModules();
  try {
    const modules = loadModules(root);
    const handlers = collectHandlers(modules);
    assert.equal(handlers.length, 1);
    assert.equal(handlers[0]?.id, 'h1');
    assert.equal(modules.find((m) => m.descriptor.id === 'demo-content')?.handlers.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discoverDescriptors returns empty for a missing dir', () => {
  assert.deepEqual(discoverDescriptors('/no/such/dir/xyz-traffic-one'), []);
});
