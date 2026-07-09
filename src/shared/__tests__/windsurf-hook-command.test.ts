import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WINDSURF_HOOK_EVENTS } from '../../config/windsurf-host';
import {
  isGeneratedWindsurfWorkspaceHooks,
  windsurfUserHookCommand,
  windsurfWorkspaceHooksJson,
} from '../windsurf-hook-command';

test('windsurfUserHookCommand stamps plugin root and host env', () => {
  const cmd = windsurfUserHookCommand('/plugin/root', 'pre_run_command');
  assert.match(cmd, /TRAFFIC_ONE_PLUGIN_ROOT="\/plugin\/root"/);
  assert.match(cmd, /TRAFFIC_ONE_HOST=windsurf/);
  assert.match(cmd, /pre_run_command --host=windsurf/);
});

test('windsurfWorkspaceHooksJson covers every Cascade hook event', () => {
  const parsed = JSON.parse(windsurfWorkspaceHooksJson()) as {
    trafficOneGenerated: boolean;
    hooks: Record<string, Array<{ command: string }>>;
  };
  assert.equal(parsed.trafficOneGenerated, true);
  assert.ok(isGeneratedWindsurfWorkspaceHooks(JSON.stringify(parsed)));
  for (const event of WINDSURF_HOOK_EVENTS) {
    assert.match(parsed.hooks[event]?.[0]?.command ?? '', /windsurf-hook-runtime\.cjs/);
    assert.match(parsed.hooks[event]?.[0]?.command ?? '', /TRAFFIC_ONE_HOST=windsurf/);
  }
});
