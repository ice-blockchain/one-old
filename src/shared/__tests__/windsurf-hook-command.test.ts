import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WINDSURF_HOOK_EVENTS } from '../../config/windsurf-host';
import { documentedBinDir, RUNNER_SHIMS, stableBinDir } from '../runner-shims';
import { writeWindsurfHostAssets } from '../materialize/windsurf-assets';
import {
  devinUserHookCommand,
  isGeneratedWindsurfWorkspaceHooks,
  matchesDevinUserHookCommand,
  matchesWindsurfUserHookCommand,
  windsurfUserHookCommand,
  windsurfWorkspaceHookCommand,
  windsurfWorkspaceHooksJson,
  WINDSURF_WORKSPACE_HOOKS_REL,
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

// ---------------------------------------------------------------------------
// Workspace hooks: `.windsurf/hooks.json` lands IN the project, so its bytes are
// committed and must resolve on a machine that never ran the install.
// ---------------------------------------------------------------------------

const SHIM_NAME = 'windsurf-hook-runtime.cjs';

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map(Object.keys(patch).map((key) => [key, process.env[key]] as const));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A stand-in for the real runner shim that reports WHICH copy of itself ran.
function writeFakeShim(binDir: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, SHIM_NAME);
  fs.writeFileSync(file, [
    "'use strict';",
    'process.stdout.write(JSON.stringify({',
    '  shim: require("fs").realpathSync(__filename),',
    '  argv: process.argv.slice(2),',
    "  host: process.env.TRAFFIC_ONE_HOST || '',",
    '}));',
  ].join('\n'), 'utf8');
  return fs.realpathSync(file);
}

function runLauncher(command: string, env: NodeJS.ProcessEnv, cwd: string) {
  const result = spawnSync(command, { cwd, encoding: 'utf8', env, shell: true });
  assert.equal(result.status, 0, `launcher failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as { shim: string; argv: string[]; host: string };
}

// Env for a simulated machine: only the vars the launcher is allowed to consult,
// so an inherited XDG_STATE_HOME/TOOLCHAIN_ROOT from the test runner cannot
// decide the outcome.
function machineEnv(home: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.XDG_STATE_HOME;
  delete env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  delete env.TRAFFIC_ONE_HOST;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

// Every maximal base64-alphabet run, decoded. An absolute path smuggled through
// ANY encoding in the emitted bytes has to survive this, so the no-home-path
// assertion below cannot be satisfied by encoding the path instead of dropping it.
function decodedBlobs(text: string): string[] {
  return (text.match(/[A-Za-z0-9+/=]{12,}/g) ?? []).map(
    (blob) => Buffer.from(blob, 'base64').toString('utf8'),
  );
}

test('the workspace launcher names a shim ensureRunnerShims actually writes', () => {
  const named = /const n='([^']+)'/.exec(windsurfWorkspaceHookCommand('pre_run_command'))?.[1];
  assert.equal(named, SHIM_NAME);
  assert.ok(
    RUNNER_SHIMS.some((entry) => entry.shim === named),
    `${named} must be in RUNNER_SHIMS or no directory on disk will hold it`,
  );
});

test('committed workspace hooks carry no absolute path — not in plain bytes, not encoded', () => {
  const emitted = windsurfWorkspaceHooksJson();
  const forbidden = [stableBinDir(), documentedBinDir(), os.homedir(), process.env.HOME ?? os.homedir()];
  for (const haystack of [emitted, ...decodedBlobs(emitted)]) {
    for (const absolute of forbidden) {
      assert.equal(
        haystack.includes(absolute),
        false,
        `a committed workspace file must not contain ${absolute}`,
      );
    }
  }
  // Nothing rooted at all: no POSIX `/...` and no Windows drive path.
  assert.doesNotMatch(emitted, /"[^"]*(?:\/(?:Users|home|root)\/|[A-Za-z]:\\)/);
});

test('the workspace launcher string is shell-inert on POSIX and Windows', () => {
  for (const event of WINDSURF_HOOK_EVENTS) {
    const command = windsurfWorkspaceHookCommand(event);
    const launcher = /^node -e "(.*)" [^"]*$/.exec(command)?.[1];
    assert.ok(launcher, 'the launcher must be one double-quoted node -e argument');
    // Anything here could close the quote or become syntax in `sh -c` / `cmd /c`.
    for (const meta of ['"', '\\', '$', '`', '|', '&', '<', '>', '%', '!', '\n', '\r']) {
      assert.equal(launcher.includes(meta), false, `launcher must not contain ${JSON.stringify(meta)}`);
    }
  }
});

// THE BUG: bytes generated on one machine, executed on another.
test('workspace hooks generated with one HOME resolve the shim of the machine that RUNS them', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-portable-'));
  try {
    const machineA = path.join(base, 'machine-a');
    const machineB = path.join(base, 'machine-b');
    const shimA = writeFakeShim(path.join(machineA, '.traffic-one', 'bin'));
    const shimB = writeFakeShim(path.join(machineB, '.traffic-one', 'bin'));

    // Generated on machine A (the developer who ran the install).
    const emittedOnA = withEnv({ HOME: machineA, XDG_STATE_HOME: undefined, TRAFFIC_ONE_TOOLCHAIN_ROOT: undefined }, windsurfWorkspaceHooksJson);
    const emittedOnB = withEnv({ HOME: machineB, XDG_STATE_HOME: undefined, TRAFFIC_ONE_TOOLCHAIN_ROOT: undefined }, windsurfWorkspaceHooksJson);
    assert.equal(emittedOnA, emittedOnB, 'the committed bytes must not depend on who generated them');
    assert.equal(emittedOnA.includes(machineA), false);

    const hooks = (JSON.parse(emittedOnA) as {
      hooks: Record<string, Array<{ command: string }>>;
    }).hooks;
    const command = hooks.pre_run_command?.[0]?.command ?? '';

    // Executed on machine B, which has never seen machine A's home directory.
    const ran = runLauncher(command, machineEnv(machineB), machineB);
    assert.equal(ran.shim, shimB, 'the launcher must resolve the RUNNING machine\'s shim');
    assert.notEqual(ran.shim, shimA);
    assert.deepEqual(ran.argv, ['pre_run_command', '--host=windsurf']);
    assert.equal(ran.host, 'windsurf');

    // ...and symmetrically on machine A, from the same bytes.
    assert.equal(runLauncher(command, machineEnv(machineA), machineA).shim, shimA);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The teammate the brief worries about: relocated state via XDG_STATE_HOME or
// TRAFFIC_ONE_TOOLCHAIN_ROOT, mirroring stableBinDir()'s own precedence.
test('the workspace launcher honours relocated state, and falls back to the documented bin dir', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-relocated-'));
  try {
    const command = windsurfWorkspaceHookCommand('pre_run_command');

    const xdgHome = path.join(base, 'xdg', 'home');
    const xdgState = path.join(base, 'xdg', 'state');
    const xdgShim = writeFakeShim(path.join(xdgState, 'traffic-one', 'bin'));
    fs.mkdirSync(xdgHome, { recursive: true });
    assert.equal(
      runLauncher(command, machineEnv(xdgHome, { XDG_STATE_HOME: xdgState }), xdgHome).shim,
      xdgShim,
      'XDG_STATE_HOME must win, exactly as stableBinDir() resolves it',
    );

    const tcHome = path.join(base, 'tc', 'home');
    const tcRoot = path.join(base, 'tc', 'state');
    const tcShim = writeFakeShim(path.join(tcRoot, 'bin'));
    fs.mkdirSync(tcHome, { recursive: true });
    assert.equal(
      runLauncher(
        command,
        machineEnv(tcHome, { TRAFFIC_ONE_TOOLCHAIN_ROOT: path.join(tcRoot, 'toolchains') }),
        tcHome,
      ).shim,
      tcShim,
      'TRAFFIC_ONE_TOOLCHAIN_ROOT must win over XDG and HOME',
    );

    // Relocated state whose bin dir holds no shim (an unwritable or older state
    // dir): the documented ~/.traffic-one/bin copy still answers.
    const fallbackHome = path.join(base, 'fallback', 'home');
    const emptyState = path.join(base, 'fallback', 'state');
    const homeShim = writeFakeShim(path.join(fallbackHome, '.traffic-one', 'bin'));
    fs.mkdirSync(path.join(emptyState, 'traffic-one', 'bin'), { recursive: true });
    assert.equal(
      runLauncher(command, machineEnv(fallbackHome, { XDG_STATE_HOME: emptyState }), fallbackHome).shim,
      homeShim,
      'a shimless relocated dir must fall through to the documented path',
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// UPGRADE: a project that already carries the pre-portability file. Ownership is
// decided by the `trafficOneGenerated` marker, not by command spelling, so the
// broken file is recognized and swept without enumerating a third spelling.
test('an existing workspace hooks file with a baked absolute path is recognized and removed on upgrade', () => {
  const foreignBin = path.join(path.sep, 'Users', 'someone-else', '.traffic-one', 'bin');
  const bakedCommand = [
    'node -e "',
    `const p=require('path'),e=process.env,b=Buffer.from('${Buffer.from(foreignBin, 'utf8').toString('base64')}','base64').toString('utf8');`,
    "e.TRAFFIC_ONE_HOST='windsurf';",
    "process.argv.splice(1,0,'traffic-one-launcher');",
    `require(p.join(b,'${SHIM_NAME}'));`,
    '" pre_run_command --host=windsurf',
  ].join('');
  const bakedFile = `${JSON.stringify({
    trafficOneGenerated: true,
    hooks: { pre_run_command: [{ command: bakedCommand, show_output: true }] },
  }, null, 2)}\n`;

  // The old spelling really does carry the foreign home directory...
  assert.ok(decodedBlobs(bakedFile).some((decoded) => decoded.includes(foreignBin)));
  // ...and is still recognized as ours.
  assert.equal(isGeneratedWindsurfWorkspaceHooks(bakedFile), true);
  assert.equal(isGeneratedWindsurfWorkspaceHooks('{"hooks":{"pre_run_command":[]}}'), false);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-upgrade-'));
  try {
    const plugin = path.join(base, 'plugin');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'agents', 'senior-architect.md'), '# Senior Architect\n\nPLAN_READY\n', 'utf8');
    const workspaceHooks = path.join(project, WINDSURF_WORKSPACE_HOOKS_REL);
    fs.mkdirSync(path.dirname(workspaceHooks), { recursive: true });
    fs.writeFileSync(workspaceHooks, bakedFile, 'utf8');
    const manual = path.join(project, '.windsurf', 'manual-hooks.json');
    fs.writeFileSync(manual, '{"hooks":{}}\n', 'utf8');

    const result = withEnv(
      { TRAFFIC_ONE_PLUGIN_ROOT: plugin },
      () => writeWindsurfHostAssets(project, []),
    );

    assert.equal(result.skipped, undefined, 'the fixture must let the writer run');
    assert.equal(fs.existsSync(workspaceHooks), false, 'the stale baked-path file must be gone after an upgrade');
    assert.equal(fs.existsSync(manual), true, 'a file we do not own is never touched');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
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
