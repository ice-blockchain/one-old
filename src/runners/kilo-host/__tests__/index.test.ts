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
  kiloGlobalConfigPath,
  kiloGlobalPluginPath,
  kiloProjectMarkerPath,
  readOwner,
  readProjectActivation,
  uninstallWrapper,
  wrapperSource,
} from '../index';
import { PRE_TOOL_REMEDIATION, preToolFailureReason } from '../../../hooks/fail-closed';

test('generated wrapper carries the shared fail-closed prose and denies before-tool-use on spawn or parse failure', () => {
  const body = wrapperSource('/tmp/plugin', '2026-01-01T00:00:00Z');
  // The wrapper is dependency-free at runtime, so the shared strings are
  // interpolated at generation time — this locks them to hooks/fail-closed.ts.
  assert.ok(body.includes(JSON.stringify(preToolFailureReason('Kilo'))));
  assert.ok(body.includes(PRE_TOOL_REMEDIATION));
  assert.equal(body.includes('reinstall/update'), false);
  assert.match(body, /Traffic One Kilo pre-tool gate could not find a Node\.js runtime/);
  assert.match(body, /debugLog\('spawn-fail'[\s\S]*?if \(subcommand === 'before-tool-use'\) \{\s+return \{ kind: 'deny', reason:/);
  assert.match(body, /debugLog\('parse-fail'[\s\S]*?if \(subcommand === 'before-tool-use'\) \{\s+return \{ kind: 'deny', reason:/);
});

function withHome(fn: (env: NodeJS.ProcessEnv) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-host-'));
  try {
    fn({
      HOME: path.join(dir, 'home'),
      XDG_CONFIG_HOME: path.join(dir, 'xdg'),
      TRAFFIC_ONE_PLUGIN_ROOT: path.join(dir, 'plugin'),
      // Kilo is an uncertified host (HOST_CAPABILITIES.kilo.tier): installWrapper()
      // refuses by default. These tests exercise install MECHANICS, so they opt
      // in exactly like a maintainer testing the wrapper would — the refusal
      // itself is covered separately below.
      TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST: '1',
    } as NodeJS.ProcessEnv);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('install refuses by default for this uncertified host, and proceeds with the opt-out', () => {
  withHome((env) => {
    const file = kiloGlobalPluginPath(env);
    const { TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST, ...withoutOptOut } = env;
    const refused = installWrapper(withoutOptOut as NodeJS.ProcessEnv, ['install', '--yes']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr || '', /Kilo is not a certified host/);
    assert.match(refused.stderr || '', /TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST=1/);
    assert.equal(fs.existsSync(file), false);

    const installed = installWrapper(env, ['install', '--yes']);
    assert.equal(installed.code, 0);
    assert.equal(fs.existsSync(file), true);
  });
});

test('install requires explicit consent and writes an owned global Kilo wrapper', () => {
  withHome((env) => {
    const file = kiloGlobalPluginPath(env);
    const denied = installWrapper(env, ['install']);
    assert.equal(denied.code, 2);
    assert.equal(fs.existsSync(file), false);

    const installed = installWrapper(env, ['install', '--yes'], true);
    assert.equal(installed.code, 0);
    assert.equal(fs.existsSync(file), true);
    const owner = readOwner(file);
    assert.equal(owner?.owner, 'traffic-one');
    assert.equal(owner?.pluginRoot, env.TRAFFIC_ONE_PLUGIN_ROOT);
    const config = JSON.parse(fs.readFileSync(kiloGlobalConfigPath(env), 'utf8')) as {
      mcp?: Record<string, { enabled?: boolean; type?: string; oauth?: boolean }>;
      permission?: Record<string, string>;
    };
    assert.equal(config.mcp?.['traffic-one-mcp']?.enabled, false);
    assert.equal(config.mcp?.['traffic-one-mcp']?.type, 'remote');
    assert.equal(config.mcp?.['traffic-one-mcp']?.oauth, false);
    assert.equal(config.permission?.['traffic-one-mcp_get_config'], 'deny');
    assert.equal(config.permission?.['traffic-one-mcp_report_codebase_metadata'], 'deny');
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(body.includes('tool.execute.before'));
    assert.ok(body.includes('tool.execute.after'));
    assert.ok(body.includes('chat.message'));
    assert.ok(body.includes('experimental.chat.system.transform'));
    assert.ok(body.includes('shell.env'));
    assert.ok(body.includes('permission.ask'));
    assert.ok(body.includes('event'));
    // v2 wrapper surfaces: session.idle turn-end delivery via a FEATURE-DETECTED
    // host toast (never client.session.prompt — that injects a model turn), and
    // the composed [Traffic One] banner (systemMessage) in chat.message.
    assert.ok(body.includes('session.idle'));
    assert.ok(body.includes("typeof tui.showToast === 'function'"), 'toast delivery must be feature-detected');
    assert.ok(!body.includes('client.session.prompt'), 'never inject a model turn from the wrapper');
    assert.ok(body.includes("'\\n\\n[Traffic One]\\n' + banner"), 'the systemMessage banner must survive composition (not shadowed by context)');
    assert.ok(body.includes('"wrapperApi":2'), 'the owner stamp carries the wrapper API generation');
    assert.ok(body.includes('--host=kilo'));
    assert.ok(body.includes('TRAFFIC_ONE_HOST'));
    assert.ok(body.includes('id: "traffic-one"'));
    assert.ok(body.includes('server: TrafficOne'));
    assert.match(installed.stdout, /Restart Kilo/);
    assert.match(installed.stdout, /Registered disabled traffic-one-mcp/);

    const doctor = doctorWrapper(env, ['doctor'], true);
    assert.equal(doctor.code, 0);
    assert.match(doctor.stdout, /^ok:/);
    assert.match(doctor.stdout, /auto-loaded from Kilo global plugin directory/);
  });
});

test('central registration switch installs the Kilo wrapper without creating public MCP config', () => {
  withHome((env) => {
    const configPath = kiloGlobalConfigPath(env);
    const installed = installWrapper(env, ['install', '--yes'], false);
    assert.equal(installed.code, 0);
    assert.equal(fs.existsSync(kiloGlobalPluginPath(env)), true);
    assert.equal(fs.existsSync(configPath), false);
    assert.match(installed.stdout, /registration is disabled/);
    const doctor = doctorWrapper(env, ['doctor'], false);
    assert.equal(doctor.code, 0);
    assert.match(doctor.stdout, /config: registration-disabled/);
  });
});

test('Kilo registration reuses an existing supported config file', () => {
  withHome((env) => {
    const dir = path.dirname(kiloGlobalConfigPath(env));
    const existing = path.join(dir, 'kilo.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(existing, '{"model":"user/model"}\n', 'utf8');
    assert.equal(installWrapper(env, ['install', '--yes'], true).code, 0);
    assert.equal(kiloGlobalConfigPath(env), existing);
    assert.equal(fs.existsSync(path.join(dir, 'kilo.jsonc')), false);
    const config = JSON.parse(fs.readFileSync(existing, 'utf8')) as Record<string, unknown>;
    assert.equal(config.model, 'user/model');
  });
});

test('Kilo registration ignores config.json and creates the supported default', () => {
  withHome((env) => {
    const supportedDefault = kiloGlobalConfigPath(env);
    const dir = path.dirname(supportedDefault);
    const unsupported = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(unsupported, '{"model":"must-remain-untouched"}\n', 'utf8');

    assert.equal(path.basename(supportedDefault), 'kilo.jsonc');
    assert.equal(installWrapper(env, ['install', '--yes'], true).code, 0);
    assert.equal(kiloGlobalConfigPath(env), supportedDefault);
    assert.equal(fs.existsSync(supportedDefault), true);
    assert.equal(fs.readFileSync(unsupported, 'utf8'), '{"model":"must-remain-untouched"}\n');
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
    const refused = uninstallWrapper(env, ['uninstall']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr || '', /uninstall --yes/);
    assert.equal(fs.existsSync(file), true);
    assert.equal(uninstallWrapper(env, ['uninstall', '--yes']).code, 1);
    assert.equal(fs.existsSync(file), true);
    assert.equal(uninstallWrapper(env, ['uninstall', '--force']).code, 2);
    assert.equal(uninstallWrapper(env, ['uninstall', '--yes', '--force']).code, 0);
    assert.equal(fs.existsSync(file), false);

    assert.equal(installWrapper(env, ['install', '--yes']).code, 0);
    assert.equal(uninstallWrapper(env, ['uninstall']).code, 2);
    assert.equal(fs.existsSync(file), true);
    assert.equal(uninstallWrapper(env, ['uninstall', '--yes']).code, 0);
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
    assert.match(String(activeOutput.parts[0]?.text || ''), new RegExp(JSON.stringify(fs.realpathSync(project)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

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
    assert.match(String(activeOutput.parts[0]?.text || ''), new RegExp(JSON.stringify(fs.realpathSync(project)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper leaves Kilo permission.ask to the host and records a Traffic One warning', async () => {
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

    const output: { status?: string; metadata?: Record<string, unknown> } = { status: 'ask' };
    await hooks['permission.ask']({ sessionID: 's1', permission: 'bash', patterns: ['npx create-next-app@latest .'] }, output);
    assert.equal(output.status, 'ask');
    assert.equal(output.metadata?.trafficOneWarning, 'blocked npx create-next-app@latest .');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper never programmatically rejects Kilo permission.asked events', async () => {
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
    assert.equal(replies.length, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper does not invoke the legacy Kilo permission rejection API', async () => {
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
    assert.equal(replies.length, 0);
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

function nvmSortFromWrapper(source: string): (left: string, right: string) => number {
  const match = source.match(/function nvmNodeCandidates\(\) \{[\s\S]*?\.sort\(\(left, right\) => \{([\s\S]*?)\n      \}\)/);
  assert.ok(match?.[1], 'nvm sort comparator is present in the emitted wrapper');
  return new Function('left', 'right', match[1]) as (left: string, right: string) => number;
}

test('wrapper nvm candidates sort by numeric version, not lexicographic', () => {
  const source = wrapperSource('/tmp/plugin', '2026-01-01T00:00:00Z');
  assert.match(source, /Number\(match\[1\]\)/);
  assert.doesNotMatch(source, /\.sort\(\)\.reverse\(\)/);
  const cmp = nvmSortFromWrapper(source);
  assert.deepEqual(
    ['v9.0.0', 'v22.9.0', 'v22.11.0', 'v20.0.0'].sort(cmp),
    ['v22.11.0', 'v22.9.0', 'v20.0.0', 'v9.0.0'],
  );
});

test('wrapper home-dir stop follows a symlinked HOME', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-home-link-'));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  try {
    const pluginRoot = path.join(base, 'plugin');
    const realHome = path.join(base, 'real-home');
    const linkHome = path.join(base, 'link-home');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(realHome, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(realHome, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
    fs.symlinkSync(realHome, linkHome);
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'kilo-hook-runtime.cjs'), [
      '#!/usr/bin/env node',
      "process.stdout.write(JSON.stringify({ kind: 'context', context: 'ran-from-home' }));",
      '',
    ].join('\n'), 'utf8');
    const wrapperFile = path.join(base, 'traffic-one.js');
    fs.writeFileSync(wrapperFile, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
    process.env.HOME = linkHome;
    process.env.USERPROFILE = linkHome;
    const mod = await import(pathToFileURL(wrapperFile).href);
    const hooks = await mod.default.server({ directory: fs.realpathSync(realHome) });
    const output = { parts: [{ type: 'text', text: 'hello' }] as Array<Record<string, unknown>> };
    await hooks['chat.message']({}, output);
    assert.equal(output.parts[0]?.text, 'hello', 'a session whose cwd is the realpath of HOME must not activate');
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper throws on before-tool-use when the runtime spawn fails or stdout is not JSON', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-fail-closed-'));
  const previousHome = process.env.HOME;
  try {
    const home = path.join(base, 'home');
    const pluginRoot = path.join(base, 'plugin');
    const project = path.join(base, 'project');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');

    const writeRuntime = (body: string) => {
      fs.writeFileSync(path.join(pluginRoot, 'scripts', 'kilo-hook-runtime.cjs'), [
        '#!/usr/bin/env node',
        body,
        '',
      ].join('\n'), 'utf8');
    };

    writeRuntime('process.exit(1);');
    const spawnFailWrapper = path.join(base, 'spawn-fail.js');
    fs.writeFileSync(spawnFailWrapper, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
    process.env.HOME = home;
    const spawnMod = await import(pathToFileURL(spawnFailWrapper).href);
    const spawnHooks = await spawnMod.default.server({ directory: project });
    await assert.rejects(
      () => spawnHooks['tool.execute.before']({ tool: 'bash', output: { args: { command: 'true' } } }, {}),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, preToolFailureReason('Kilo'));
        return true;
      },
    );
    await assert.doesNotReject(
      () => spawnHooks['tool.execute.after']({ tool: 'bash', output: { args: { command: 'true' } } }, {}),
    );

    writeRuntime("process.stdout.write('not-json');");
    const parseFailWrapper = path.join(base, 'parse-fail.js');
    fs.writeFileSync(parseFailWrapper, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
    const parseMod = await import(pathToFileURL(parseFailWrapper).href);
    const parseHooks = await parseMod.default.server({ directory: project });
    await assert.rejects(
      () => parseHooks['tool.execute.before']({ tool: 'bash', output: { args: { command: 'true' } } }, {}),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, preToolFailureReason('Kilo'));
        return true;
      },
    );
    await assert.doesNotReject(
      () => parseHooks['chat.message']({}, { parts: [{ type: 'text', text: 'hi' }] }),
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
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
  assert.match(source, /TRAFFIC_ONE_MANAGED_MCP_TOOLS/);
  assert.match(source, /function userDenyLine/);
  assert.match(source, /throw new Error\(userDenyLine\(result\)/);
  assert.match(source, /function denyMessage/);
});

test('Kilo wrapper denies managed MCP tools even with no project root or runtime', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-managed-mcp-'));
  const previousHome = process.env.HOME;
  try {
    const home = path.join(base, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    const wrapperFile = path.join(base, 'traffic-one.js');
    fs.writeFileSync(wrapperFile, wrapperSource(path.join(base, 'missing-plugin'), '2026-01-01T00:00:00Z'), 'utf8');
    process.env.HOME = home;
    const mod = await import(pathToFileURL(wrapperFile).href);
    const hooks = await mod.default.server({ directory: home });
    await assert.rejects(
      () => hooks['tool.execute.before']({ tool: 'traffic-one-mcp_get_config' }, {}),
      /Direct AI-agent calls/,
    );
    await assert.rejects(
      () => hooks['tool.execute.before']({ tool: 'traffic-one-mcp_report_codebase_metadata' }, {}),
      /Direct AI-agent calls/,
    );
    await assert.doesNotReject(() => hooks['tool.execute.before']({ tool: 'traffic-one-mcp-copy_get_config' }, {}));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('Kilo wrapper throw includes userReason and recipe when both are set; unset keeps the recipe; metadata stays denyMessage', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-user-reason-'));
  const previousHome = process.env.HOME;
  try {
    const home = path.join(base, 'home');
    const pluginRoot = path.join(base, 'plugin');
    const project = path.join(base, 'project');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'kilo-hook-runtime.cjs'), [
      '#!/usr/bin/env node',
      "const payload = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');",
      "const recipe = 'no rm -rf — wizard http://127.0.0.1:9/';",
      "if (payload.tool_name === 'unset') {",
      "  process.stdout.write(JSON.stringify({ kind: 'deny', reason: recipe }));",
      '} else {',
      "  process.stdout.write(JSON.stringify({ kind: 'deny', reason: recipe, context: 'ctx', userReason: 'Stay in this workspace.' }));",
      '}',
      '',
    ].join('\n'), 'utf8');
    const wrapperFile = path.join(base, 'traffic-one.js');
    fs.writeFileSync(wrapperFile, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
    process.env.HOME = home;
    const mod = await import(pathToFileURL(wrapperFile).href);
    const hooks = await mod.default.server({ directory: project });

    await assert.rejects(
      () => hooks['tool.execute.before']({ tool: 'bash', output: { args: { command: 'rm -rf x' } } }, {}),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^Stay in this workspace\.\n\n/);
        assert.match(err.message, /wizard http:\/\/127\.0\.0\.1:9\//);
        return true;
      },
    );
    await assert.rejects(
      () => hooks['tool.execute.before']({ tool: 'unset', output: { args: { command: 'rm -rf x' } } }, {}),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'no rm -rf — wizard http://127.0.0.1:9/');
        return true;
      },
    );

    const askOut: { metadata?: { trafficOneWarning?: string } } = {};
    await hooks['permission.ask']({ permission: 'bash', metadata: { command: 'rm' } }, askOut);
    assert.equal(askOut.metadata?.trafficOneWarning, 'no rm -rf — wizard http://127.0.0.1:9/\n\nctx');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('doctor reports stale-wrapper for a generation-1 owner stamp', () => {
  withHome((env) => {
    assert.equal(installWrapper(env, ['install', '--yes'], true).code, 0);
    const file = kiloGlobalPluginPath(env);
    // Rewrite the owner stamp WITHOUT wrapperApi — the pre-v2 install shape.
    const body = fs.readFileSync(file, 'utf8');
    const downgraded = body.replace(/"wrapperApi":\d+,/, '');
    assert.notEqual(downgraded, body, 'the fresh stamp must have carried wrapperApi');
    fs.writeFileSync(file, downgraded, 'utf8');
    const doctor = doctorWrapper(env, ['doctor'], true);
    assert.equal(doctor.code, 1, 'a stale wrapper is a doctor failure until reinstalled');
    assert.match(doctor.stdout, /wrapperApi: 1/);
    assert.match(doctor.stdout, /stale-wrapper/);
    assert.match(doctor.stdout, /install --yes/);
  });
});
