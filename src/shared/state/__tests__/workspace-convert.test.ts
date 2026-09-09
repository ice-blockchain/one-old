import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readState } from '../normalize';
import { convertToContainer } from '../workspace-convert';
import { resetPluginUseCache } from '../plugin-use';
import { convertToContainerYesCommand } from '../../workspace-command';

process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

function withRoot(fn: (root: string) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ws-convert-'));
  const root = fs.realpathSync(created);
  const prevXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(root, 'xdg');
  resetPluginUseCache();
  try {
    fn(root);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
    resetPluginUseCache();
    fs.rmSync(created, { recursive: true, force: true });
  }
}

function seedProject(root: string, extra?: { plan?: boolean; runs?: boolean; mode?: string }): void {
  const traffic = path.join(root, '.traffic-one');
  fs.mkdirSync(traffic, { recursive: true });
  fs.writeFileSync(path.join(traffic, '.one.json'), `${JSON.stringify({
    mode: extra?.mode ?? 'existing-codebase',
    onboardingComplete: true,
    currentRunId: 'run-1',
  }, null, 2)}\n`);
  if (extra?.plan) fs.writeFileSync(path.join(traffic, 'plan.md'), '# plan\n');
  if (extra?.runs) fs.mkdirSync(path.join(traffic, 'runs', '9001'), { recursive: true });
}

test('a project with no plan and no runs becomes a container', () => {
  withRoot((root) => {
    seedProject(root);
    const result = convertToContainer(root);
    assert.equal(result.outcome, 'converted', result.outcome === 'converted' ? result.message : result.message);
    assert.equal(readState(root).mode, 'workspace');
    assert.ok(result.outcome === 'converted' && result.archive.includes('.converted-'));
    assert.ok(fs.existsSync(path.join(result.outcome === 'converted' ? result.archive : '', '.one.json')));
    const archived = JSON.parse(fs.readFileSync(path.join(
      result.outcome === 'converted' ? result.archive : root,
      '.one.json',
    ), 'utf8')) as { mode?: string; currentRunId?: string };
    assert.equal(archived.mode, 'existing-codebase');
    assert.equal(archived.currentRunId, 'run-1');
    assert.notEqual((readState(root) as { currentRunId?: string }).currentRunId, 'run-1',
      'the old run pointer must not be preserved onto the container');
  });
});

test('an already-container root is a no-op', () => {
  withRoot((root) => {
    seedProject(root, { mode: 'workspace' });
    const before = fs.readFileSync(path.join(root, '.traffic-one', '.one.json'), 'utf8');
    const result = convertToContainer(root);
    assert.equal(result.outcome, 'already');
    assert.equal(fs.readFileSync(path.join(root, '.traffic-one', '.one.json'), 'utf8'), before);
  });
});

test('a project with a plan is refused unless --yes, and the refusal names the command', () => {
  withRoot((root) => {
    seedProject(root, { plan: true });
    const result = convertToContainer(root);
    assert.equal(result.outcome, 'rejected');
    assert.match(result.message, /--convert-to-container --yes/);
    assert.equal(result.message.includes(convertToContainerYesCommand())
      || result.message.includes('--convert-to-container --yes'), true);
    assert.equal(readState(root).mode, 'existing-codebase');
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'plan.md')), true);
  });
});

test('--yes archives plan and runs then publishes the container', () => {
  withRoot((root) => {
    seedProject(root, { plan: true, runs: true });
    const result = convertToContainer(root, { yes: true });
    assert.equal(result.outcome, 'converted', result.outcome === 'converted' ? result.message : result.message);
    assert.equal(readState(root).mode, 'workspace');
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'plan.md')), false);
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'runs')), false);
    const archive = result.outcome === 'converted' ? result.archive : '';
    assert.equal(fs.existsSync(path.join(archive, 'plan.md')), true);
    assert.equal(fs.existsSync(path.join(archive, 'runs', '9001')), true);
  });
});
