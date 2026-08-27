import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { detectMode } from '../../detection';
import { computeOnboarding } from '../flow';
import { shellQuote } from '../../shell-quote';
import {
  onboardingDeclineCommand,
  onboardingUseBootstrapCommand,
  usePluginQuestion,
} from '../wait-command';
import { isOnboardingBootstrapCommand, isOnboardingWaitCommand } from '../../tool-classify';

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  return {
    HOME: path.join(root, 'home'),
    XDG_STATE_HOME: path.join(root, 'xdg'),
    TRAFFIC_ONE_ASK_USE_PLUGIN: '1',
    TRAFFIC_ONE_AUTH: '0',
  };
}

function withTree(prefix: string, fn: (root: string, env: NodeJS.ProcessEnv) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  try {
    fn(root, isolatedEnv(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertCommandsBakeParent(child: string, parent: string, env: NodeJS.ProcessEnv): void {
  const question = usePluginQuestion(child, 'claude', undefined, undefined, env);
  const decline = onboardingDeclineCommand(child, 'claude', env);
  const useBootstrap = onboardingUseBootstrapCommand(child, 'claude', undefined, undefined, env);

  assert.equal(decline, onboardingDeclineCommand(parent, 'claude', env));
  assert.equal(useBootstrap, onboardingUseBootstrapCommand(parent, 'claude', undefined, undefined, env));

  for (const text of [question, decline, useBootstrap]) {
    assert.ok(text.includes(shellQuote(parent)), 'waiter cwd argv is the enclosing parent');
    assert.ok(!text.includes(shellQuote(child)), 'waiter cwd argv is not the marker-less child');
  }

  assert.equal(isOnboardingWaitCommand('Bash', { command: decline }), true);
  assert.equal(isOnboardingBootstrapCommand('Bash', { command: useBootstrap }), true);
}

test('commands bake the parent: git enclosing root', () => {
  withTree('t1-layer-c-cmd-git-', (root, env) => {
    const parent = path.join(root, 'mercury');
    const child = path.join(parent, 'strategies');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
    assertCommandsBakeParent(child, parent, env);
  });
});

test('commands bake the parent: package.json-only enclosing root', () => {
  withTree('t1-layer-c-cmd-pkg-', (root, env) => {
    const parent = path.join(root, 'pkg');
    const child = path.join(parent, 'src');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(parent, 'package.json'), '{"name":"pkg"}\n', 'utf8');
    assert.equal(fs.existsSync(path.join(parent, '.git')), false, 'fixture guard: no VCS');
    assertCommandsBakeParent(child, parent, env);
  });
});

test('computeOnboarding public remap follows the enclosing parent identity', () => {
  withTree('t1-layer-c-flow-', (root, env) => {
    const parent = path.join(root, 'mercury');
    const child = path.join(parent, 'strategies');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
    fs.mkdirSync(path.join(parent, 'app'), { recursive: true });
    for (let i = 0; i < 7; i += 1) {
      fs.writeFileSync(path.join(parent, 'app', `Model${i}.php`), '<?php\n', 'utf8');
    }

    assert.equal(detectMode(child), 'new-project', 'fixture guard: the child alone is greenfield');
    assert.equal(detectMode(parent), 'existing-codebase', 'fixture guard: the parent is an existing codebase');

    const childView = computeOnboarding(child, env);
    const parentView = computeOnboarding(parent, env);
    assert.equal(childView.mode, 'existing-codebase', 'public entry remaps; the child is not a new-project');
    assert.equal(childView.mode, parentView.mode);
    assert.equal(childView.step, parentView.step);
    assert.equal(childView.done, parentView.done);
  });
});
