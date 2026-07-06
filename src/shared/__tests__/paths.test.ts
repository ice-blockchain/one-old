import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { HookInput } from '../../core/types';
import { isInPluginCache, isManagedPluginCachePath, pluginRoot, projectRoot } from '../paths';

test('isManagedPluginCachePath detects both Claude and Codex managed cache installs', () => {
  const claude = ['', 'home', 'u', '.claude', 'plugins', 'cache', 'traffic-one'].join(path.sep);
  const codex = ['', 'home', 'u', '.codex', 'plugins', 'cache', 'traffic-one'].join(path.sep);
  assert.equal(isManagedPluginCachePath(claude), true);
  assert.equal(isManagedPluginCachePath(codex), true);
  // A normal project checkout is NOT a managed cache path (so materialization runs).
  assert.equal(isManagedPluginCachePath(['', 'home', 'u', 'projects', 'myapp'].join(path.sep)), false);
  // A .claude dir that is not the plugins/cache subtree is not flagged.
  assert.equal(isManagedPluginCachePath(['', 'home', 'u', '.claude', 'projects', 'x'].join(path.sep)), false);
});

test('isInPluginCache reflects the resolved plugin root', () => {
  const saved = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  try {
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = ['', 'home', 'u', '.claude', 'plugins', 'cache', 'traffic-one'].join(path.sep);
    assert.equal(pluginRoot(), process.env.TRAFFIC_ONE_PLUGIN_ROOT);
    assert.equal(isInPluginCache(), true);
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = ['', 'home', 'u', 'dev', 'traffic-one'].join(path.sep);
    assert.equal(isInPluginCache(), false);
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = saved;
  }
});

function withWrapperProject(fn: (root: string, child: string) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-paths-')));
  const child = path.join(root, 'one-nextjs');
  fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(child, 'src'), { recursive: true });
  fs.writeFileSync(path.join(child, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }), 'utf8');
  try { fn(root, child); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function input(cwd: string, patch: Partial<HookInput>): HookInput {
  return { event: 'UserPromptSubmit', host: 'codex', cwd, raw: {}, ...patch } as HookInput;
}

test('projectRoot: prompt-mentioned inner app beats wrapper .traffic-one state', () => {
  withWrapperProject((root, child) => {
    assert.equal(projectRoot(input(root, { prompt: 'in "one-nextjs" add an about page' })), child);
  });
});

test('projectRoot: tool workdir and file paths resolve the inner app', () => {
  withWrapperProject((root, child) => {
    assert.equal(projectRoot(input(root, {
      event: 'PreToolUse',
      tool: { class: 'shell', rawName: 'exec_command', command: 'npm test', workdir: 'one-nextjs' },
    })), child);
    assert.equal(projectRoot(input(root, {
      event: 'PreToolUse',
      tool: { class: 'file-write', rawName: 'Write', filePath: 'one-nextjs/src/page.tsx' },
    })), child);
    assert.equal(projectRoot(input(root, {
      event: 'PreToolUse',
      tool: { class: 'file-write', rawName: 'Write', workdir: 'one-nextjs', filePath: 'src/page.tsx' },
    })), child);
  });
});

test('projectRoot: workspaceRoot ceiling prevents climbing above opened workspace', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-ws-ceiling-')));
  const workspace = path.join(root, 'workspace');
  const inner = path.join(workspace, 'apps', 'web');
  const strayParent = path.join(root, 'stray-parent');
  fs.mkdirSync(path.join(strayParent, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(strayParent, '.traffic-one', '.one.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(workspace, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.traffic-one', '.one.json'), '{}', 'utf8');
  fs.mkdirSync(inner, { recursive: true });
  try {
    assert.equal(projectRoot(input(inner, { workspaceRoot: workspace })), workspace);
    assert.equal(projectRoot(input(inner, { workspaceRoot: workspace, cwd: inner })), workspace);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
