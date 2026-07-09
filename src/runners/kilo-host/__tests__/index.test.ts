import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import {
  disableProject,
  doctorWrapper,
  enableProject,
  installWrapper,
  kiloGlobalPluginPath,
  kiloProjectMarkerPath,
  readOwner,
  readProjectActivation,
  uninstallWrapper,
  wrapperSource,
} from '../index';

function withHome(fn: (env: NodeJS.ProcessEnv) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-host-'));
  try {
    fn({
      HOME: path.join(dir, 'home'),
      XDG_CONFIG_HOME: path.join(dir, 'xdg'),
      TRAFFIC_ONE_PLUGIN_ROOT: path.join(dir, 'plugin'),
    } as NodeJS.ProcessEnv);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('install requires explicit consent and writes an owned global Kilo wrapper', () => {
  withHome((env) => {
    const file = kiloGlobalPluginPath(env);
    const denied = installWrapper(env, ['install']);
    assert.equal(denied.code, 2);
    assert.equal(fs.existsSync(file), false);

    const installed = installWrapper(env, ['install', '--yes']);
    assert.equal(installed.code, 0);
    assert.equal(fs.existsSync(file), true);
    const owner = readOwner(file);
    assert.equal(owner?.owner, 'traffic-one');
    assert.equal(owner?.pluginRoot, env.TRAFFIC_ONE_PLUGIN_ROOT);
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(body.includes('tool.execute.before'));
    assert.ok(body.includes('tool.execute.after'));
    assert.ok(body.includes('chat.message'));
    assert.ok(body.includes('experimental.chat.system.transform'));
    assert.ok(body.includes('shell.env'));
    assert.ok(body.includes('permission.ask'));
    assert.ok(body.includes('event'));
    assert.ok(body.includes('--host=kilo'));
    assert.ok(body.includes('TRAFFIC_ONE_HOST'));
    assert.ok(body.includes('id: "traffic-one"'));
    assert.ok(body.includes('server: TrafficOne'));
    assert.match(installed.stdout, /Restart Kilo/);

    const doctor = doctorWrapper(env);
    assert.equal(doctor.code, 0);
    assert.match(doctor.stdout, /^ok:/);
    assert.match(doctor.stdout, /auto-loaded from Kilo global plugin directory/);
  });
});

test('install refuses unowned Kilo plugin unless forced', () => {
  withHome((env) => {
    const file = kiloGlobalPluginPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export default {};', 'utf8');
    assert.equal(installWrapper(env, ['install', '--yes']).code, 1);
    assert.equal(installWrapper(env, ['install', '--yes', '--force']).code, 0);
    assert.equal(readOwner(file)?.owner, 'traffic-one');
  });
});

test('uninstall removes only Traffic One-owned wrappers unless forced', () => {
  withHome((env) => {
    const file = kiloGlobalPluginPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export default {};', 'utf8');
    assert.equal(uninstallWrapper(env, ['uninstall']).code, 1);
    assert.equal(fs.existsSync(file), true);
    assert.equal(uninstallWrapper(env, ['uninstall', '--force']).code, 0);
    assert.equal(fs.existsSync(file), false);

    assert.equal(installWrapper(env, ['install', '--yes']).code, 0);
    assert.equal(uninstallWrapper(env, ['uninstall']).code, 0);
    assert.equal(fs.existsSync(file), false);
  });
});

test('enable/disable manage owned Kilo project activation markers', () => {
  withHome((env) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-project-'));
    try {
      const marker = kiloProjectMarkerPath(project);
      assert.equal(enableProject(env, ['enable', '--cwd', project]).code, 2);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(installWrapper(env, ['install', '--yes']).code, 0);

      const automatic = doctorWrapper(env, ['doctor', '--cwd', project]);
      assert.equal(automatic.code, 0);
      assert.match(automatic.stdout, /projectActivation: automatic/);

      const enabled = enableProject(env, ['enable', '--cwd', project, '--yes']);
      assert.equal(enabled.code, 0);
      assert.equal(readProjectActivation(marker)?.owner, 'traffic-one');
      assert.equal(readProjectActivation(marker)?.pluginRoot, env.TRAFFIC_ONE_PLUGIN_ROOT);
      assert.equal(readProjectActivation(marker)?.enabled, true);

      const doctor = doctorWrapper(env, ['doctor', '--cwd', project]);
      assert.equal(doctor.code, 0);
      assert.match(doctor.stdout, /projectActivation: enabled-marker/);

      assert.equal(disableProject(env, ['disable', '--cwd', project]).code, 2);
      assert.equal(disableProject(env, ['disable', '--cwd', project, '--yes']).code, 0);
      assert.equal(readProjectActivation(marker)?.enabled, false);
      const disabled = doctorWrapper(env, ['doctor', '--cwd', project]);
      assert.equal(disabled.code, 1);
      assert.match(disabled.stdout, /projectActivation: disabled/);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

test('wrapper invokes runtime for a pristine Kilo workspace without a project marker', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-wrapper-'));
  try {
    const pluginRoot = path.join(base, 'plugin');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'kilo-hook-runtime.cjs'), [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const stdin = fs.readFileSync(0, 'utf8');",
      "process.stdout.write(JSON.stringify({ kind: 'context', context: process.argv.slice(2).join(' ') + '\\n' + stdin }));",
      '',
    ].join('\n'), 'utf8');
    const wrapperFile = path.join(base, 'traffic-one.js');
    fs.writeFileSync(wrapperFile, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
    const mod = await import(pathToFileURL(wrapperFile).href);
    assert.equal(mod.default.id, 'traffic-one');
    const hooks = await mod.default.server({ directory: project });

    const userPart = { type: 'text', text: 'build me an app', id: 'p1', sessionID: 's1', messageID: 'm1' };
    const activeOutput = { parts: [userPart] as Array<Record<string, unknown>> };
    await hooks['chat.message']({}, activeOutput);
    assert.equal(activeOutput.parts.length, 1);
    assert.equal(activeOutput.parts[0]?.id, 'p1');
    assert.match(String(activeOutput.parts[0]?.text || ''), /build me an app/);
    assert.match(String(activeOutput.parts[0]?.text || ''), /user-prompt-submit --host=kilo/);
    assert.match(String(activeOutput.parts[0]?.text || ''), new RegExp(JSON.stringify(project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const envOut: { env?: Record<string, string> } = {};
    await hooks['shell.env']({}, envOut);
    assert.equal(envOut.env?.TRAFFIC_ONE_PLUGIN_ROOT, pluginRoot);
    assert.equal(envOut.env?.TRAFFIC_ONE_HOST, 'kilo');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper resolves real node when Kilo process.execPath is not node', async () => {
  if (process.platform === 'win32') return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-wrapper-'));
  const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
  const previousPath = process.env.PATH;
  const previousTrafficOneNode = process.env.TRAFFIC_ONE_NODE;
  const previousTrafficOneNodePath = process.env.TRAFFIC_ONE_NODE_PATH;
  const previousNode = process.env.NODE;
  const previousNpmNodeExecPath = process.env.npm_node_execpath;
  try {
    const pluginRoot = path.join(base, 'plugin');
    const project = path.join(base, 'project');
    const binDir = path.join(base, 'bin');
    const fakeKilo = path.join(binDir, 'kilo');
    const fakeNode = path.join(binDir, 'node');
    const nodeLog = path.join(base, 'node.log');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    fs.writeFileSync(fakeKilo, '#!/bin/sh\necho "kilo 7.4.1"\n', { mode: 0o755 });
    fs.writeFileSync(fakeNode, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "v99.0.0"; exit 0; fi',
      `printf '%s\\n' "$*" >> '${nodeLog.replace(/'/g, "'\\''")}'`,
      `TRAFFIC_ONE_FAKE_NODE=1 exec '${process.execPath.replace(/'/g, "'\\''")}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'kilo-hook-runtime.cjs'), [
      '#!/usr/bin/env node',
      "process.stdout.write(JSON.stringify({ kind: 'context', context: 'fake=' + process.env.TRAFFIC_ONE_FAKE_NODE }));",
      '',
    ].join('\n'), 'utf8');

    delete process.env.TRAFFIC_ONE_NODE;
    delete process.env.TRAFFIC_ONE_NODE_PATH;
    delete process.env.NODE;
    delete process.env.npm_node_execpath;
    process.env.PATH = binDir;
    Object.defineProperty(process, 'execPath', { value: fakeKilo, writable: true, enumerable: true, configurable: true });

    const wrapperFile = path.join(base, 'traffic-one.js');
    fs.writeFileSync(wrapperFile, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
    const mod = await import(pathToFileURL(wrapperFile).href);
    const hooks = await mod.default.server({ directory: project });

    const activeOutput = { parts: [{ type: 'text', text: 'build me an app' }] as Array<Record<string, unknown>> };
    await hooks['chat.message']({}, activeOutput);
    assert.match(String(activeOutput.parts[0]?.text || ''), /fake=1/);
    assert.match(fs.readFileSync(nodeLog, 'utf8'), /kilo-hook-runtime\.cjs user-prompt-submit --host=kilo/);
  } finally {
    if (execPathDescriptor) Object.defineProperty(process, 'execPath', execPathDescriptor);
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousTrafficOneNode === undefined) delete process.env.TRAFFIC_ONE_NODE; else process.env.TRAFFIC_ONE_NODE = previousTrafficOneNode;
    if (previousTrafficOneNodePath === undefined) delete process.env.TRAFFIC_ONE_NODE_PATH; else process.env.TRAFFIC_ONE_NODE_PATH = previousTrafficOneNodePath;
    if (previousNode === undefined) delete process.env.NODE; else process.env.NODE = previousNode;
    if (previousNpmNodeExecPath === undefined) delete process.env.npm_node_execpath; else process.env.npm_node_execpath = previousNpmNodeExecPath;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper uses Kilo session events as a cwd fallback for sparse hook inputs', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-wrapper-'));
  try {
    const pluginRoot = path.join(base, 'plugin');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'kilo-hook-runtime.cjs'), [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const stdin = fs.readFileSync(0, 'utf8');",
      "process.stdout.write(JSON.stringify({ kind: 'context', context: stdin }));",
      '',
    ].join('\n'), 'utf8');
    const wrapperFile = path.join(base, 'traffic-one.js');
    fs.writeFileSync(wrapperFile, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
    const mod = await import(pathToFileURL(wrapperFile).href);
    const hooks = await mod.default.server({});

    await hooks.event({
      event: {
        type: 'session.created',
        properties: { sessionID: 's1', info: { id: 's1', directory: project } },
      },
    });
    const activeOutput = { parts: [{ type: 'text', text: 'build me an app' }] as Array<Record<string, unknown>> };
    await hooks['chat.message']({ sessionID: 's1' }, activeOutput);
    assert.match(String(activeOutput.parts[0]?.text || ''), new RegExp(JSON.stringify(project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper can deny through Kilo permission.ask as a fallback gate', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-wrapper-'));
  try {
    const pluginRoot = path.join(base, 'plugin');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'kilo-hook-runtime.cjs'), [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const payload = JSON.parse(fs.readFileSync(0, 'utf8'));",
      "process.stdout.write(JSON.stringify({ kind: 'deny', reason: 'blocked ' + payload.tool_input.command }));",
      '',
    ].join('\n'), 'utf8');
    const wrapperFile = path.join(base, 'traffic-one.js');
    fs.writeFileSync(wrapperFile, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
    const mod = await import(pathToFileURL(wrapperFile).href);
    const hooks = await mod.default.server({ directory: project });

    const output: { status?: string } = { status: 'ask' };
    await hooks['permission.ask']({ sessionID: 's1', permission: 'bash', patterns: ['npx create-next-app@latest .'] }, output);
    assert.equal(output.status, 'deny');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper rejects Kilo permission.asked events through the client API', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-wrapper-'));
  try {
    const pluginRoot = path.join(base, 'plugin');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'kilo-hook-runtime.cjs'), [
      '#!/usr/bin/env node',
      "process.stdout.write(JSON.stringify({ kind: 'deny', reason: 'blocked by event gate' }));",
      '',
    ].join('\n'), 'utf8');
    const wrapperFile = path.join(base, 'traffic-one.js');
    fs.writeFileSync(wrapperFile, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
    const mod = await import(pathToFileURL(wrapperFile).href);
    const replies: Array<Record<string, unknown>> = [];
    const hooks = await mod.default.server({
      directory: project,
      client: {
        permission: {
          reply(params: Record<string, unknown>) {
            replies.push(params);
            return Promise.resolve(true);
          },
        },
      },
    });

    await hooks.event({
      event: {
        type: 'permission.asked',
        properties: {
          id: 'per_1',
          sessionID: 's1',
          permission: 'bash',
          patterns: ['npm create vite@latest app -- --template react-ts'],
          metadata: {},
        },
      },
    });
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0], {
      requestID: 'per_1',
      directory: project,
      workspace: project,
      reply: 'reject',
      message: 'blocked by event gate',
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper rejects Kilo permission events through the legacy client API', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-wrapper-'));
  try {
    const pluginRoot = path.join(base, 'plugin');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'kilo-hook-runtime.cjs'), [
      '#!/usr/bin/env node',
      "process.stdout.write(JSON.stringify({ kind: 'deny', reason: 'legacy deny' }));",
      '',
    ].join('\n'), 'utf8');
    const wrapperFile = path.join(base, 'traffic-one.js');
    fs.writeFileSync(wrapperFile, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
    const mod = await import(pathToFileURL(wrapperFile).href);
    const replies: Array<Record<string, unknown>> = [];
    const hooks = await mod.default.server({
      directory: project,
      client: {
        postSessionIdPermissionsPermissionId(params: Record<string, unknown>) {
          replies.push(params);
          return Promise.resolve(true);
        },
      },
    });

    await hooks.event({
      event: {
        type: 'permission.asked',
        properties: {
          id: 'per_legacy',
          sessionID: 's1',
          permission: 'bash',
          patterns: ['npm install'],
        },
      },
    });
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0], {
      path: { id: 's1', permissionID: 'per_legacy' },
      query: { directory: project },
      body: { response: 'reject' },
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper noops for exact home sessions and explicit project opt-outs', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-wrapper-'));
  const previousHome = process.env.HOME;
  try {
    const pluginRoot = path.join(base, 'plugin');
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'kilo-hook-runtime.cjs'), [
      '#!/usr/bin/env node',
      "process.stdout.write(JSON.stringify({ kind: 'context', context: 'ran' }));",
      '',
    ].join('\n'), 'utf8');
    const wrapperFile = path.join(base, 'traffic-one.js');
    fs.writeFileSync(wrapperFile, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
    process.env.HOME = home;
    const mod = await import(pathToFileURL(wrapperFile).href);

    const homeHooks = await mod.default.server({ directory: home });
    const homeOutput = { parts: [] as Array<Record<string, unknown>> };
    await homeHooks['chat.message']({}, homeOutput);
    assert.deepEqual(homeOutput.parts, []);

    disableProject({ TRAFFIC_ONE_PLUGIN_ROOT: pluginRoot, PWD: project } as NodeJS.ProcessEnv, ['disable', '--cwd', project, '--yes']);
    const projectHooks = await mod.default.server({ directory: project });
    const disabledOutput = { parts: [] as Array<Record<string, unknown>> };
    await projectHooks['chat.message']({}, disabledOutput);
    assert.deepEqual(disabledOutput.parts, []);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper source uses host-stamped Kilo runtime hooks', () => {
  const source = wrapperSource('/plugin', '2026-01-01T00:00:00Z');
  assert.match(source, /findTrafficOneRoot/);
  assert.match(source, /resolveNodeExecutable/);
  assert.doesNotMatch(source, /spawnSync\(process\.execPath, \[TRAFFIC_ONE_RUNTIME/);
  assert.match(source, /validTrafficOneActivationRoot/);
  assert.match(source, /trafficOneRootFor/);
  assert.match(source, /throw new Error/);
  assert.match(source, /out\.args/);
  assert.match(source, /ctx = \{\}/);
  assert.match(source, /server: TrafficOne/);
  assert.match(source, /shell\.env/);
  assert.match(source, /permission\.ask/);
  assert.match(source, /TRAFFIC_ONE_SESSION_ROOTS/);
  assert.match(source, /TRAFFIC_ONE_HOST: 'kilo'/);
  assert.match(source, /resolveTrafficOneEnv\(projectRoot, 'kilo'/);
});
