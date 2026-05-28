import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectHandlers, defaultModulesDir, loadModules } from '../registry';
import { pluginRoot } from '../../shared/paths';

// End-to-end: the registry discovers the REAL modules under src/modules and
// loads their handlers — "add a folder → it's wired in", no central map.
test('registry discovers the real session + graphify modules and their handlers', () => {
  const modules = loadModules(defaultModulesDir(pluginRoot()));
  const ids = modules.map((m) => m.descriptor.id);
  assert.ok(ids.includes('session'), `expected session module, got ${ids.join(', ')}`);
  assert.ok(ids.includes('graphify'), `expected graphify module, got ${ids.join(', ')}`);

  const handlers = collectHandlers(modules);

  const authGate = handlers.find((h) => h.id === 'session.auth');
  assert.ok(authGate, 'auth gate handler discovered');
  assert.equal(authGate?.event, 'PreToolUse');
  assert.equal(authGate?.priority, 0);

  const graphHint = handlers.find((h) => h.id === 'graphify.hint');
  assert.ok(graphHint, 'graphify hint handler discovered');
  assert.equal(graphHint?.event, 'PreToolUse');
  assert.equal(graphHint?.priority, 50);
});
