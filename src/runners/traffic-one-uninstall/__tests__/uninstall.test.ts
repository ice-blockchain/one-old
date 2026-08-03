import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describePluginInstall, discoverPluginInstalls, isRemovableStateDir, run, runUninstall } from '../index';

// Every path this runner touches is user-level, so each case gets its own fake
// HOME. CODEX_HOME is pinned too: the Codex MCP removal resolves its config from
// os.homedir() unless that variable is set, and must never reach the real one.
function withHome<T>(fn: (home: string, env: NodeJS.ProcessEnv) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-one-uninstall-'));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
  };
  try {
    return fn(home, env);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeFile(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

// A wrapper the host installers would recognize as their own; an unowned file is
// deliberately left in place by the underlying uninstallers.
function ownedWrapper(pluginRoot: string): string {
  const owner = JSON.stringify({ owner: 'traffic-one', version: 1, pluginRoot });
  return `const TRAFFIC_ONE_WRAPPER_OWNER = ${owner};\nmodule.exports = {};\n`;
}

function seedMachine(home: string): void {
  writeFile(path.join(home, '.traffic-one', 'one.json'), '{"schemaVersion":1}');
  writeFile(path.join(home, '.traffic-one', 'projects', 'abc', 'preferences.json'), '{}');
  writeFile(path.join(home, '.traffic-one', 'toolchains', 'opencode', 'bin', 'opencode'), 'binary');
  writeFile(path.join(home, '.traffic-one', 'bin', 'doctor.cjs'), 'shim');
  writeFile(path.join(home, '.config', 'kilo', 'plugin', 'traffic-one.js'), ownedWrapper('/plugins/traffic-one'));
  writeFile(path.join(home, '.config', 'opencode', 'plugins', 'traffic-one.js'), ownedWrapper('/plugins/traffic-one'));
  writeFile(path.join(home, '.claude', 'plugins', 'cache', 'traffic-one', 'traffic-one', '1.0.0', 'plugin.json'), '{}');
  writeFile(path.join(home, '.codex', 'plugins', 'cache', 'traffic-one-local', 'traffic-one', '1.0.0', 'plugin.json'), '{}');
}

test('discoverPluginInstalls finds each host/marketplace pair that holds the plugin', () => {
  withHome((home, env) => {
    seedMachine(home);
    writeFile(path.join(home, '.cursor', 'plugins', 'local', 'traffic-one', 'plugin.json'), '{}');
    // A marketplace without a traffic-one plugin must not be reported.
    fs.mkdirSync(path.join(home, '.codex', 'plugins', 'cache', 'openai-curated'), { recursive: true });

    const installs = discoverPluginInstalls(env).map((i) => `${i.host}/${i.marketplace}`).sort();
    assert.deepEqual(installs, ['claude/traffic-one', 'codex/traffic-one-local', 'cursor/local']);

    const codex = discoverPluginInstalls(env).find((i) => i.host === 'codex');
    // Codex needs PLUGIN@MARKETPLACE — a bare name is rejected by its CLI.
    assert.equal(describePluginInstall(codex!), 'codex plugin remove traffic-one@traffic-one-local');
    const cursor = discoverPluginInstalls(env).find((i) => i.host === 'cursor');
    assert.match(describePluginInstall(cursor!), /no uninstall CLI/);
  });
});

test('a bare invocation refuses and prints the plan without removing anything', () => {
  withHome((home, env) => {
    seedMachine(home);
    const result = run([], env);
    assert.equal(result.code, 2);
    assert.match(result.stderr || '', /Re-run with --yes/);
    assert.match(result.stdout, /dry-run/);
    assert.ok(fs.existsSync(path.join(home, '.traffic-one', 'one.json')), 'state dir survives a refused run');
    assert.ok(fs.existsSync(path.join(home, '.config', 'kilo', 'plugin', 'traffic-one.js')), 'kilo wrapper survives');
  });
});

test('--dry-run reports the plan, including the host CLI commands, and changes nothing', () => {
  withHome((home, env) => {
    seedMachine(home);
    const result = run(['--dry-run'], env);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /would remove/);
    assert.match(result.stdout, /claude plugin uninstall traffic-one@traffic-one/);
    assert.match(result.stdout, /codex plugin remove traffic-one@traffic-one-local/);
    assert.ok(fs.existsSync(path.join(home, '.traffic-one')), 'state dir untouched by dry-run');
    assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'traffic-one.js')), 'opencode wrapper untouched');
  });
});

test('the plan reports what is actually installed, not the install recipe', () => {
  withHome((home, env) => {
    seedMachine(home);
    // Windsurf and the Codex config were never installed on this machine.
    const lines = run(['--dry-run'], env).stdout.split('\n');
    const line = (label: string) => lines.find((l) => l.includes(label)) || '';
    assert.match(line('Kilo wrapper'), /would remove it FIRST/);
    assert.match(line('OpenCode wrapper'), /would remove it/);
    assert.match(line('Windsurf integration (stable)'), /not present/);
    assert.match(line('Codex MCP block'), /not present/);

    writeFile(path.join(home, '.codeium', 'windsurf', 'hooks.json'), '{}');
    writeFile(path.join(home, '.codex', 'config.toml'), '# config\n');
    const after = run(['--dry-run'], env).stdout.split('\n');
    assert.match(after.find((l) => l.includes('Windsurf integration (stable)')) || '', /would remove/);
    assert.match(after.find((l) => l.includes('Codex MCP block')) || '', /byte-exact/);
  });
});

test('--yes removes the state dir and the user-level host wrappers', () => {
  withHome((home, env) => {
    seedMachine(home);
    const result = run(['--yes', '--keep-plugin'], env);

    assert.equal(result.code, 0, result.stdout + (result.stderr || ''));
    assert.equal(fs.existsSync(path.join(home, '.traffic-one')), false, 'state dir removed');
    assert.equal(fs.existsSync(path.join(home, '.config', 'kilo', 'plugin', 'traffic-one.js')), false, 'kilo wrapper removed');
    assert.equal(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'traffic-one.js')), false, 'opencode wrapper removed');
    // --keep-plugin leaves the bundle so the caller can stage removal separately.
    assert.ok(fs.existsSync(path.join(home, '.claude', 'plugins', 'cache', 'traffic-one', 'traffic-one', '1.0.0')), 'bundle kept');
    assert.match(result.stdout, /Restart the host now/);
  });
});

test('ordering: Kilo wrapper first, then the bundle, and the state dir LAST', () => {
  withHome((home, env) => {
    seedMachine(home);
    const { steps } = runUninstall({ dryRun: false, keepPlugin: false }, env);
    const labels = steps.map((step) => step.label);
    const kilo = labels.findIndex((label) => label.startsWith('Kilo'));
    const bundle = labels.findIndex((label) => label.startsWith('plugin bundle'));
    const state = labels.findIndex((label) => label.startsWith('state dir'));
    assert.ok(kilo >= 0 && bundle > kilo, 'bundle removal follows the Kilo wrapper');
    // The state dir goes last so no later step (host CLI spawn, wrapper
    // uninstall) can repopulate it — the user must end with no ~/.traffic-one.
    assert.ok(state > bundle, 'the state dir is removed last');
  });
});

test('isRemovableStateDir refuses the home dir, a filesystem root, and any other name', () => {
  const env: NodeJS.ProcessEnv = { HOME: '/home/dev' };
  assert.equal(isRemovableStateDir('/home/dev/.traffic-one', env), true);
  assert.equal(isRemovableStateDir('/home/dev/.local/state/traffic-one', env), true);
  assert.equal(isRemovableStateDir('/home/dev', env), false);
  assert.equal(isRemovableStateDir(path.parse(process.cwd()).root, env), false);
  assert.equal(isRemovableStateDir('/home/dev/Documents', env), false);
});

test('XDG_STATE_HOME: the active state dir AND the pre-XDG ~/.traffic-one leftover are both removed', () => {
  withHome((home, base) => {
    const env = { ...base, XDG_STATE_HOME: path.join(home, '.local', 'state') };
    writeFile(path.join(home, '.local', 'state', 'traffic-one', 'one.json'), '{}');
    writeFile(path.join(home, '.traffic-one', 'one.json'), '{}');

    const { steps } = runUninstall({ dryRun: false, keepPlugin: true }, env);
    const stateSteps = steps.filter((step) => step.label.startsWith('state dir'));
    assert.equal(stateSteps.length, 2, 'both state dirs are swept');
    for (const step of stateSteps) assert.match(step.detail, /removed/);
    assert.equal(fs.existsSync(path.join(home, '.local', 'state', 'traffic-one')), false, 'XDG state dir removed');
    // A full uninstall must leave NO local preferences folder behind — the
    // pre-XDG ~/.traffic-one is machine state from before the redirect.
    assert.equal(fs.existsSync(path.join(home, '.traffic-one')), false, 'pre-XDG ~/.traffic-one swept');
  });
});

// The state sweep removes ~/.traffic-one and nothing else, so a graphify that an
// older Traffic One installed through pipx provably outlives an uninstall. It is
// REPORTED, never removed: provenance is undecidable, and `pipx uninstall` on a
// graphifyy the user installed themselves is a worse failure than a stray one.
test('a pipx-installed graphify is reported, never removed', () => {
  withHome((home, base) => {
    const pipxBin = path.join(home, 'Library', 'Application Support', 'pipx', 'venvs', 'graphifyy', 'bin', 'graphify');
    writeFile(pipxBin, 'binary');
    const shimDir = path.join(home, '.local', 'bin');
    fs.mkdirSync(shimDir, { recursive: true });
    fs.symlinkSync(pipxBin, path.join(shimDir, 'graphify'));
    const env = { ...base, PATH: shimDir };

    const { steps } = runUninstall({ dryRun: false, keepPlugin: true }, env);
    const step = steps.find((s) => s.label.startsWith('graphify installed outside'));
    assert.ok(step, 'the advisory step is present');
    assert.equal(step?.ok, true, 'the advisory never fails the uninstall');
    assert.match(step?.detail || '', /pipx uninstall graphifyy/);
    assert.equal(fs.existsSync(pipxBin), true, 'the pipx install is left untouched');
    assert.equal(fs.existsSync(path.join(shimDir, 'graphify')), true, 'the PATH shim is left untouched');
  });
});

test('a graphify that is not a pipx install is named but not blamed', () => {
  withHome((home, base) => {
    const binDir = path.join(home, 'bin');
    writeFile(path.join(binDir, 'graphify'), 'binary');
    const { steps } = runUninstall({ dryRun: true, keepPlugin: true }, { ...base, PATH: binDir });
    const step = steps.find((s) => s.label.startsWith('graphify installed outside'));
    assert.match(step?.detail || '', /not a pipx install/);
    assert.equal(/pipx uninstall/.test(step?.detail || ''), false, 'no removal is suggested for a tool that is not ours');
  });
});

test('a machine with nothing installed reports cleanly', () => {
  withHome((home, env) => {
    const result = run(['--yes'], env);
    assert.equal(result.code, 0, result.stdout + (result.stderr || ''));
    assert.match(result.stdout, /no installed bundle found/);
    assert.match(result.stdout, /not present/);
    assert.ok(fs.existsSync(home), 'the home dir itself is never touched');
  });
});
