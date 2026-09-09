import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { main, parseWorkspaceArgs } from '../index';
import { resetPluginUseCache } from '../../../shared/state/plugin-use';
import { readState } from '../../../shared/state/normalize';

process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

test('parseWorkspaceArgs admits convert and yes, and nothing else as the action', () => {
  assert.deepEqual(parseWorkspaceArgs(['--convert-to-container'], '/proj'), {
    convertToContainer: true,
    yes: false,
    json: false,
    cwd: '/proj',
  });
  assert.deepEqual(parseWorkspaceArgs(['--convert-to-container', '--yes', '--json', '--cwd', '/other'], '/proj'), {
    convertToContainer: true,
    yes: true,
    json: true,
    cwd: '/other',
  });
  assert.equal(parseWorkspaceArgs([], '/proj'), null);
  assert.equal(parseWorkspaceArgs(['--yes'], '/proj'), null);
  assert.equal(parseWorkspaceArgs(['--convert-to-container', '--unknown'], '/proj'), null);
});

test('main converts a project with no plan and no runs', () => {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ws-runner-'));
  const root = fs.realpathSync(created);
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(root, 'xdg');
  resetPluginUseCache();
  try {
    fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), `${JSON.stringify({
      mode: 'new-project',
      onboardingComplete: true,
    }, null, 2)}\n`);
    const code = main(['--convert-to-container'], root);
    assert.equal(code, 0);
    assert.equal(readState(root).mode, 'workspace');
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
    resetPluginUseCache();
    fs.rmSync(created, { recursive: true, force: true });
  }
});

test('main refuses a planned project without --yes and names the command', () => {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ws-runner-plan-'));
  const root = fs.realpathSync(created);
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(root, 'xdg');
  resetPluginUseCache();
  try {
    fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), `${JSON.stringify({
      mode: 'existing-codebase',
      onboardingComplete: true,
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(root, '.traffic-one', 'plan.md'), '# plan\n');
    const code = main(['--convert-to-container'], root);
    assert.equal(code, 1);
    assert.equal(readState(root).mode, 'existing-codebase');
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
    resetPluginUseCache();
    fs.rmSync(created, { recursive: true, force: true });
  }
});
