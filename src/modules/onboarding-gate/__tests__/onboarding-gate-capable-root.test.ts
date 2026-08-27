import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { onboardingGate } from '../handler';
import { shellQuote } from '../../../shared/shell-quote';
import { onboardingDeclineCommand, onboardingUseBootstrapCommand } from '../../../shared/onboarding-server/wait-command';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

function gateCtx(cwd: string, workspaceRoot: string, filePath: string): Ctx {
  const toolInput = { file_path: filePath, content: 'x' };
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    workspaceRoot,
    raw: { tool_name: 'Write', tool_input: toolInput },
    tool: { class: 'file-write' as ToolClass, rawName: 'Write', filePath },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

test('gate ask-first names the parent, not the marker-less child', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-layer-c-gate-')));
  const parent = path.join(root, 'mercury');
  const child = path.join(parent, 'strategies');
  const filePath = path.join(child, 'src', 'app.ts');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(path.join(parent, '.git'), { recursive: true });

  const saved = {
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    TRAFFIC_ONE_PROJECT_PREFS_PATH: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    TRAFFIC_ONE_ASK_USE_PLUGIN: process.env.TRAFFIC_ONE_ASK_USE_PLUGIN,
    TRAFFIC_ONE_AUTH: process.env.TRAFFIC_ONE_AUTH,
    TRAFFIC_ONE_ONBOARDING_NO_SPAWN: process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN,
  };
  process.env.HOME = path.join(root, 'home');
  process.env.XDG_STATE_HOME = path.join(root, 'xdg');
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  process.env.TRAFFIC_ONE_AUTH = '0';
  process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';

  try {
    const denied = onboardingGate(gateCtx(child, child, filePath));
    assert.equal(denied.kind, 'deny');
    assert.equal(denied.kind === 'deny' ? denied.denyId : '', 'onboarding-use-plugin-question');
    if (denied.kind !== 'deny') return;
    assert.ok(denied.reason.includes(shellQuote(parent)), 'deny reason --use/--decline argv names the parent');
    assert.ok(!denied.reason.includes(shellQuote(child)), 'deny reason argv is not the marker-less child');
    assert.ok(denied.reason.includes(onboardingUseBootstrapCommand(parent, 'claude')));
    assert.ok(denied.reason.includes(onboardingDeclineCommand(parent, 'claude')));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
