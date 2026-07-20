import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { runModelGate } from '../index';
import { freshCursorModels } from '../../../shared/materialize/cursor-models';

test('model-gate --capture-models stores exact ids in local preferences', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-model-capture-command-'));
  const previous = {
    prefs: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: process.env.TRAFFIC_ONE_STATE_PATH,
    plan: process.env.TRAFFIC_ONE_USER_PLAN,
  };
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(cwd, 'preferences.json');
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(cwd, 'one.json');
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    assert.equal(runModelGate([
      cwd,
      '--host=cursor',
      '--capture-models',
      'claude-opus-4-8-thinking-max-fast',
      'gpt-5.5-extra-high',
      'composer-2.5-fast',
    ]), 0);
    assert.deepEqual(freshCursorModels(cwd, 'pro'), [
      'claude-opus-4-8-thinking-max-fast',
      'gpt-5.5-extra-high',
      'composer-2.5-fast',
    ]);
  } finally {
    if (previous.prefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previous.prefs;
    if (previous.state === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH;
    else process.env.TRAFFIC_ONE_STATE_PATH = previous.state;
    if (previous.plan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
    else process.env.TRAFFIC_ONE_USER_PLAN = previous.plan;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
