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
  opencodeGlobalConfigPath,
  opencodeGlobalPluginPath,
  opencodeProjectMarkerPath,
  readOwner,
  readProjectActivation,
  uninstallWrapper,
  wrapperSource,
} from '../index';

function withHome(fn: (env: NodeJS.ProcessEnv) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-host-'));
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

test('install requires explicit consent and writes an owned global wrapper', () => {
  withHome((env) => {
    const file = opencodeGlobalPluginPath(env);
    const configFile = opencodeGlobalConfigPath(env);
    const denied = installWrapper(env, ['install']);
    assert.equal(denied.code, 2);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(configFile), false);

    const installed = installWrapper(env, ['install', '--yes'], true);
    assert.equal(installed.code, 0);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(configFile), true);
    const owner = readOwner(file);
    assert.equal(owner?.owner, 'traffic-one');
    assert.equal(owner?.pluginRoot, env.TRAFFIC_ONE_PLUGIN_ROOT);
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as {
      plugin?: string[];
      mcp?: Record<string, { enabled?: boolean; type?: string; url?: string }>;
      permission?: Record<string, string>;
    };
    assert.deepEqual(config.plugin, [pathToFileURL(file).href]);
    assert.equal(config.mcp?.['traffic-one-mcp']?.enabled, false);
    assert.equal(config.mcp?.['traffic-one-mcp']?.type, 'remote');
    assert.equal(config.permission?.['traffic-one-mcp_get_config'], 'deny');
    assert.equal(config.permission?.['traffic-one-mcp_report_codebase_metadata'], 'deny');
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(body.includes('tool.execute.before'));
    assert.ok(body.includes('tool.execute.after'));
    assert.ok(body.includes('chat.message'));
    assert.ok(body.includes('experimental.chat.system.transform'));
    assert.ok(body.includes('--host=opencode'));
    assert.ok(body.includes('id: "traffic-one"'));
    assert.ok(body.includes('server: TrafficOne'));
    // v2 wrapper surfaces: session.idle turn-end delivery via a FEATURE-DETECTED
    // host toast (never client.session.prompt — that injects a model turn), and
    // the composed [Traffic One] banner (systemMessage) in chat.message.
    assert.ok(body.includes('"event"'), 'the event hook must be subscribed');
    assert.ok(body.includes('session.idle'));
    assert.ok(body.includes("typeof tui.showToast === 'function'"), 'toast delivery must be feature-detected');
    assert.ok(!body.includes('client.session.prompt'), 'never inject a model turn from the wrapper');
    assert.ok(body.includes("'\\n\\n[Traffic One]\\n' + banner"), 'the systemMessage banner must survive composition (not shadowed by context)');
    assert.ok(body.includes('"wrapperApi":2'), 'the owner stamp carries the wrapper API generation');
    assert.ok(!body.includes('session.start'));
    assert.ok(!body.includes('opencode_delegate'));
    assert.match(installed.stdout, /Restart OpenCode/);
    assert.match(installed.stdout, /Registered OpenCode global plugin/);

    const doctor = doctorWrapper(env, ['doctor'], true);
    assert.equal(doctor.code, 0);
    assert.match(doctor.stdout, /^ok:/);
    assert.match(doctor.stdout, /config: ok/);
    assert.match(doctor.stdout, /registered in OpenCode global plugin array/);
  });
});

test('central registration switch keeps the OpenCode wrapper but omits public MCP config', () => {
  withHome((env) => {
    const installed = installWrapper(env, ['install', '--yes'], false);
    assert.equal(installed.code, 0);
    const config = JSON.parse(fs.readFileSync(opencodeGlobalConfigPath(env), 'utf8')) as {
      plugin?: string[];
      mcp?: unknown;
      permission?: unknown;
    };
    assert.equal(config.plugin?.length, 1);
    assert.equal(config.mcp, undefined);
    assert.equal(config.permission, undefined);
    assert.equal(doctorWrapper(env, ['doctor'], false).code, 0);
  });
});

test('uninstall removes only Traffic One-owned wrappers unless forced', () => {
  withHome((env) => {
    const file = opencodeGlobalPluginPath(env);
    const configFile = opencodeGlobalConfigPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export default {};', 'utf8');
    assert.equal(uninstallWrapper(env, ['uninstall']).code, 1);
    assert.equal(fs.existsSync(file), true);
    assert.equal(uninstallWrapper(env, ['uninstall', '--force']).code, 0);
    assert.equal(fs.existsSync(file), false);

    assert.equal(installWrapper(env, ['install', '--yes']).code, 0);
    assert.deepEqual((JSON.parse(fs.readFileSync(configFile, 'utf8')) as { plugin?: string[] }).plugin, [pathToFileURL(file).href]);
    assert.equal(uninstallWrapper(env, ['uninstall']).code, 0);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual((JSON.parse(fs.readFileSync(configFile, 'utf8')) as { plugin?: string[] }).plugin, []);
  });
});

test('install preserves existing OpenCode config keys and avoids duplicate plugin entries', () => {
  withHome((env) => {
    const file = opencodeGlobalPluginPath(env);
    const configFile = opencodeGlobalConfigPath(env);
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, [
      '{',
      '  // user setting',
      '  "model": "opencode/big-pickle",',
      '  "plugin": [',
      `    "${pathToFileURL(file).href}",`,
      '  ],',
      '}',
      '',
    ].join('\n'), 'utf8');

    const installed = installWrapper(env, ['install', '--yes']);
    assert.equal(installed.code, 0);
    const raw = fs.readFileSync(configFile, 'utf8');
    assert.match(raw, /"model": "opencode\/big-pickle"/);
    assert.equal(raw.split(pathToFileURL(file).href).length - 1, 1);
  });
});

test('doctor fails when the wrapper exists but is not registered in global config', () => {
  withHome((env) => {
    const file = opencodeGlobalPluginPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, wrapperSource(String(env.TRAFFIC_ONE_PLUGIN_ROOT), '2026-01-01T00:00:00Z'), 'utf8');
    const configFile = opencodeGlobalConfigPath(env);
    fs.writeFileSync(configFile, JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: [] }, null, 2), 'utf8');
    const doctor = doctorWrapper(env);
    assert.equal(doctor.code, 1);
    assert.match(doctor.stdout, /Traffic One wrapper is not registered/);
  });
});

test('enable/disable manage owned project activation markers', () => {
  withHome((env) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-project-'));
    try {
      const marker = opencodeProjectMarkerPath(project);
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
      assert.equal(fs.existsSync(marker), true);
      assert.equal(readProjectActivation(marker)?.enabled, false);
      const disabled = doctorWrapper(env, ['doctor', '--cwd', project]);
      assert.equal(disabled.code, 1);
      assert.match(disabled.stdout, /projectActivation: disabled/);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

test('wrapper invokes runtime for a pristine OpenCode workspace without a project marker', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-wrapper-'));
  try {
    const pluginRoot = path.join(base, 'plugin');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'opencode-hook-runtime.cjs'), [
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

    // Real OpenCode passes the user's submitted message part, which carries the
    // strict id/sessionID/messageID the part schema requires. The wrapper must
    // APPEND its context to that existing part — never push a bare partial part,
    // which OpenCode rejects as "invalid user part before save" and which kills
    // the whole prompt (observed live on 1.17.11).
    const userPart = { type: 'text', text: 'build me an app', id: 'p1', sessionID: 's1', messageID: 'm1' };
    const activeOutput = { parts: [userPart] as Array<Record<string, unknown>> };
    await hooks['chat.message']({}, activeOutput);
    assert.equal(activeOutput.parts.length, 1);
    assert.equal(activeOutput.parts[0]?.id, 'p1');
    assert.match(String(activeOutput.parts[0]?.text || ''), /build me an app/);
    assert.match(String(activeOutput.parts[0]?.text || ''), /user-prompt-submit --host=opencode/);
    assert.match(String(activeOutput.parts[0]?.text || ''), new RegExp(JSON.stringify(project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('wrapper noops for exact home sessions and explicit project opt-outs', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-wrapper-'));
  const previousHome = process.env.HOME;
  try {
    const pluginRoot = path.join(base, 'plugin');
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'opencode-hook-runtime.cjs'), [
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

test('wrapper source uses host-stamped runtime hooks and throws only on before-tool deny', () => {
  const source = wrapperSource('/plugin', '2026-01-01T00:00:00Z');
  assert.match(source, /findTrafficOneRoot/);
  assert.match(source, /validTrafficOneActivationRoot/);
  assert.match(source, /trafficOneRootFor/);
  assert.match(source, /throw new Error/);
  assert.match(source, /out\.args/);
  assert.match(source, /ctx = \{\}/);
  assert.match(source, /server: TrafficOne/);
  // v2: the only tui usage is the feature-detected session-idle toast; a
  // session-prompt injection from the wrapper remains forbidden (model-turn loop).
  assert.ok(source.includes("typeof tui.showToast === 'function'"));
  assert.ok(!source.includes('client.session.prompt'));
  assert.ok(source.includes('opencode.jsonc'));
  assert.match(source, /trafficOneHookEnv/);
  assert.match(source, /resolveTrafficOneEnv/);
  assert.match(source, /traffic-one-paths\.js/);
  assert.match(source, /TRAFFIC_ONE_MANAGED_MCP_TOOLS/);
});

test('wrapper denies managed MCP tools before project lookup or runtime spawn', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-managed-mcp-'));
  const previousHome = process.env.HOME;
  try {
    const home = path.join(base, 'home');
    const pluginRoot = path.join(base, 'missing-plugin-runtime');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), '{"type":"module"}\n', 'utf8');
    const wrapperFile = path.join(base, 'traffic-one.js');
    fs.writeFileSync(wrapperFile, wrapperSource(pluginRoot, '2026-01-01T00:00:00Z'), 'utf8');
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

test('doctor reports stale-wrapper for a generation-1 owner stamp', () => {
  withHome((env) => {
    assert.equal(installWrapper(env, ['install', '--yes'], true).code, 0);
    const file = opencodeGlobalPluginPath(env);
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
