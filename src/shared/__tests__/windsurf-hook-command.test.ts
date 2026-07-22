import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WINDSURF_HOOK_EVENTS } from '../../config/windsurf-host';
import {
  devinUserHookCommand,
  isGeneratedWindsurfWorkspaceHooks,
  matchesDevinUserHookCommand,
  matchesWindsurfUserHookCommand,
  windsurfUserHookCommand,
  windsurfWorkspaceHookCommand,
  windsurfWorkspaceHooksJson,
} from '../windsurf-hook-command';

function assertPortableNodeCommand(command: string): void {
  assert.match(command, /^node -e "/);
  assert.doesNotMatch(command, /(?:^|\s)(?:TRAFFIC_ONE_PLUGIN_ROOT|TRAFFIC_ONE_HOST)=/);
  assert.doesNotMatch(command, /\$\{[A-Z][A-Z0-9_]*:-|\bsh\s+-[lc]+\b/);
}

function legacyCommand(pluginRoot: string, runtime: string, subcommand: string): string {
  const quote = (value: string): string => `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
  return `TRAFFIC_ONE_PLUGIN_ROOT=${quote(pluginRoot)} TRAFFIC_ONE_HOST=windsurf node ${quote(path.join(pluginRoot, 'scripts', runtime))} ${subcommand} --host=windsurf`;
}

test('windsurfUserHookCommand stamps plugin root and host env', () => {
  const cmd = windsurfUserHookCommand('/plugin/root', 'pre_run_command');
  assertPortableNodeCommand(cmd);
  assert.match(cmd, /e\.TRAFFIC_ONE_PLUGIN_ROOT=b/);
  assert.match(cmd, /e\.TRAFFIC_ONE_HOST='windsurf'/);
  assert.match(cmd, /windsurf-hook-runtime\.cjs/);
  assert.match(cmd, /pre_run_command --host=windsurf/);
});

test('Windsurf command ownership recognizes legacy Traffic One entries but not near-collisions', () => {
  const pluginRoot = path.resolve('/plugin/root');
  assert.equal(matchesWindsurfUserHookCommand(
    legacyCommand(pluginRoot, 'windsurf-hook-runtime.cjs', 'pre_run_command'),
    pluginRoot,
    'pre_run_command',
  ), true);
  assert.equal(matchesDevinUserHookCommand(
    legacyCommand(pluginRoot, 'devin-hook-runtime.cjs', 'check-plan-write'),
    pluginRoot,
    'check-plan-write',
  ), true);
  assert.equal(matchesWindsurfUserHookCommand(
    'node "/other/plugin/scripts/windsurf-hook-runtime.cjs" pre_run_command --host=windsurf',
    pluginRoot,
    'pre_run_command',
  ), false);
});

test('Windsurf and Devin user hook launchers preserve special paths, stdin, argv, and env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-command-'));
  const pluginRoot = path.join(dir, 'plugin with spaces & dollars $');
  const cwd = path.join(dir, 'foreign workspace');
  const runtimeSource = [
    "'use strict';",
    "let stdin='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',(chunk)=>{stdin+=chunk;});",
    "process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({runtime:require('path').basename(__filename),args:process.argv.slice(2),root:process.env.TRAFFIC_ONE_PLUGIN_ROOT||'',host:process.env.TRAFFIC_ONE_HOST||'',stdin}));});",
  ].join('\n');
  try {
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    for (const runtime of ['windsurf-hook-runtime.cjs', 'devin-hook-runtime.cjs']) {
      fs.writeFileSync(path.join(pluginRoot, 'scripts', runtime), runtimeSource, 'utf8');
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TRAFFIC_ONE_PLUGIN_ROOT;
    delete env.TRAFFIC_ONE_HOST;
    for (const [command, runtime, subcommand] of [
      [windsurfUserHookCommand(pluginRoot, 'pre_run_command'), 'windsurf-hook-runtime.cjs', 'pre_run_command'],
      [devinUserHookCommand(pluginRoot, 'check-plan-write'), 'devin-hook-runtime.cjs', 'check-plan-write'],
    ] as const) {
      assertPortableNodeCommand(command);
      assert.equal(command.includes(pluginRoot), false, 'raw special-character path must remain shell-inert');
      const result = spawnSync(command, {
        cwd,
        encoding: 'utf8',
        env,
        input: '{"portable":true}',
        shell: true,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        runtime,
        args: [subcommand, '--host=windsurf'],
        root: path.resolve(pluginRoot),
        host: 'windsurf',
        stdin: '{"portable":true}',
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('windsurfWorkspaceHooksJson covers every Cascade hook event', () => {
  const parsed = JSON.parse(windsurfWorkspaceHooksJson()) as {
    trafficOneGenerated: boolean;
    hooks: Record<string, Array<{ command: string }>>;
  };
  assert.equal(parsed.trafficOneGenerated, true);
  assert.ok(isGeneratedWindsurfWorkspaceHooks(JSON.stringify(parsed)));
  for (const event of WINDSURF_HOOK_EVENTS) {
    const command = parsed.hooks[event]?.[0]?.command ?? '';
    assertPortableNodeCommand(command);
    assert.match(command, /windsurf-hook-runtime\.cjs/);
    assert.match(command, /e\.TRAFFIC_ONE_HOST='windsurf'/);
    assert.equal(command, windsurfWorkspaceHookCommand(event));
  }
});
