import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import {
  describePluginInstall,
  discoverInstallResidue,
  discoverPluginInstalls,
  isRemovableResidueDir,
  isRemovableStateDir,
  run,
  runUninstall,
} from '../index';

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

// ── residue no host CLI reclaims ────────────────────────────────────────────
//
// Measured against what the install path writes (build/sync-hosts.ts). None of
// these three paths was reached by an uninstall before: `codex plugin remove`
// reclaims the plugin CACHE and leaves the staged marketplace copy, the Copilot
// copy was never even discovered, and the Cursor local install had no CLI so it
// was only ever printed as advice.

function seedResidue(home: string): void {
  writeFile(path.join(home, '.codex', 'local-marketplaces', 'traffic-one-local', 'marketplace.json'), '{}');
  writeFile(path.join(home, '.codex', 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one', 'package.json'),
    '{"name":"traffic-one","version":"1.0.0"}');
  writeFile(path.join(home, '.copilot', 'installed-plugins', '_direct', 'dist', 'package.json'),
    '{"name":"traffic-one","version":"1.0.0"}');
  writeFile(path.join(home, '.cursor', 'plugins', 'local', 'traffic-one', 'package.json'),
    '{"name":"traffic-one","version":"1.0.0"}');
}

test('the residue sweep removes the bundle copies no host CLI reclaims', () => {
  withHome((home, env) => {
    seedMachine(home);
    seedResidue(home);

    const result = run(['--yes'], env);
    assert.equal(result.code, 0, result.stdout + (result.stderr || ''));

    assert.equal(fs.existsSync(path.join(home, '.codex', 'local-marketplaces', 'traffic-one-local')), false,
      'the staged Codex marketplace copy is gone — `codex plugin remove` never reclaims it');
    assert.equal(fs.existsSync(path.join(home, '.copilot', 'installed-plugins', '_direct', 'dist')), false,
      'the Copilot copy is gone — nothing discovered it before');
    assert.equal(fs.existsSync(path.join(home, '.cursor', 'plugins', 'local', 'traffic-one')), false,
      'the Cursor local install is gone — it has no uninstall CLI at all');
    // Never wider than the three entries: the parents survive, because other
    // plugins live in them.
    assert.ok(fs.existsSync(path.join(home, '.copilot', 'installed-plugins', '_direct')), 'the Copilot plugin root survives');
    assert.ok(fs.existsSync(path.join(home, '.cursor', 'plugins', 'local')), 'the Cursor local plugin root survives');
  });
});

test('a Copilot copy is identified by its package name, and a stranger is left alone', () => {
  withHome((home, env) => {
    writeFile(path.join(home, '.copilot', 'installed-plugins', '_direct', 'dist', 'package.json'),
      '{"name":"traffic-one"}');
    writeFile(path.join(home, '.copilot', 'installed-plugins', '_direct', 'someone-else', 'package.json'),
      '{"name":"not-traffic-one"}');
    writeFile(path.join(home, '.copilot', 'installed-plugins', '_direct', 'unreadable', 'package.json'), 'not json');

    const labels = discoverInstallResidue(env).map((r) => r.label);
    assert.deepEqual(labels, ['Copilot plugin copy (dist)'],
      'the directory NAME is the source dir, so ownership is read off package.json — and only ours matches');

    run(['--yes'], env);
    assert.equal(fs.existsSync(path.join(home, '.copilot', 'installed-plugins', '_direct', 'dist')), false);
    assert.ok(fs.existsSync(path.join(home, '.copilot', 'installed-plugins', '_direct', 'someone-else')),
      'another vendor’s plugin is never touched');
    assert.ok(fs.existsSync(path.join(home, '.copilot', 'installed-plugins', '_direct', 'unreadable')),
      'an unreadable manifest is not evidence of ownership');
  });
});

test("Claude's marketplace registration is reported, never removed", () => {
  withHome((home, env) => {
    const registration = path.join(home, '.claude', 'plugins', 'marketplaces', 'traffic-one');
    writeFile(path.join(registration, 'marketplace.json'), '{}');

    const result = run(['--yes'], env);
    const line = result.stdout.split('\n').find((l) => l.includes('Claude marketplace registration')) || '';
    assert.match(line, /\[ok\]/, 'reporting it never fails the uninstall');
    assert.match(line, /plugin UI/, 'the user is told where to do it by hand');
    assert.ok(fs.existsSync(registration),
      'no `claude plugin marketplace remove` spelling exists in this repo, so nothing here invents one');
  });
});

test('--dry-run names the residue and removes none of it', () => {
  withHome((home, env) => {
    seedResidue(home);
    const result = run(['--dry-run'], env);
    assert.match(result.stdout, /Codex local marketplace: would remove/);
    assert.match(result.stdout, /Cursor local install: would remove/);
    assert.ok(fs.existsSync(path.join(home, '.codex', 'local-marketplaces', 'traffic-one-local')));
    assert.ok(fs.existsSync(path.join(home, '.cursor', 'plugins', 'local', 'traffic-one')));
  });
});

test('--keep-plugin keeps the residue too — it IS the bundle', () => {
  withHome((home, env) => {
    seedResidue(home);
    const result = run(['--yes', '--keep-plugin'], env);
    assert.equal(result.code, 0, result.stdout);
    assert.ok(fs.existsSync(path.join(home, '.codex', 'local-marketplaces', 'traffic-one-local')),
      'keeping the plugin cannot mean deleting a copy of it');
    assert.ok(fs.existsSync(path.join(home, '.cursor', 'plugins', 'local', 'traffic-one')));
  });
});

test('the residue sweep runs after the bundle removal and before the state sweep', () => {
  withHome((home, env) => {
    seedMachine(home);
    seedResidue(home);
    const labels = runUninstall({ dryRun: false, keepPlugin: false }, env).steps.map((s) => s.label);
    const bundle = labels.findIndex((l) => l.startsWith('plugin bundle'));
    const residue = labels.indexOf('Codex local marketplace');
    const state = labels.findIndex((l) => l.startsWith('state dir'));
    // After the bundle, because `codex plugin remove` needs the marketplace this
    // step unregisters; before the state sweep, because it spawns a host CLI that
    // may touch ~/.traffic-one.
    assert.ok(bundle >= 0 && residue > bundle, 'residue follows the host CLI removals');
    assert.ok(state > residue, 'and the state dir still goes last');
  });
});

test('isRemovableResidueDir refuses anything outside a deep user-level plugin path', () => {
  const env: NodeJS.ProcessEnv = { HOME: '/home/dev' };
  assert.equal(isRemovableResidueDir('/home/dev/.cursor/plugins/local/traffic-one', env), true);
  assert.equal(isRemovableResidueDir('/home/dev', env), false);
  assert.equal(isRemovableResidueDir('/home/dev/.copilot', env), false, 'a host root is never deep enough');
  assert.equal(isRemovableResidueDir('/home/dev/.copilot/installed-plugins', env), false);
  assert.equal(isRemovableResidueDir('/etc/traffic-one/x/y', env), false, 'outside home is refused');
  // Refused by RESOLUTION and by nothing else: path.resolve normalizes this to
  // /home/etc before any segment is looked at, so it fails the containment
  // test, not a `..` check. The predicate no longer claims to scan for `..`,
  // because no input could ever have reached that scan.
  assert.equal(isRemovableResidueDir('/home/dev/.copilot/installed-plugins/../../../etc', env), false,
    'traversal cannot escape: the path resolves outside home before it is measured');
  assert.equal(path.resolve('/home/dev/.copilot/installed-plugins/../../../etc'), path.resolve('/home/etc'),
    'the reason above, stated as the fact it rests on');
});

// The containment is a claim about the PATH, not about what the path leads to:
// isRemovableResidueDir resolves and does not realpath, so a symlinked entry
// under a residue root is inside home no matter where it points. What that costs
// is bounded and worth writing down — fs.rmSync unlinks the link itself, so the
// target survives.
test('a symlinked residue entry costs the link, never what it points at', () => {
  withHome((home, env) => {
    const outside = path.join(home, 'outside-the-residue-root');
    writeFile(path.join(outside, 'package.json'), '{"name":"traffic-one","version":"1.0.0"}');
    const link = path.join(home, '.copilot', 'installed-plugins', '_direct', 'linked');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link);

    // Ownership is read THROUGH the link, so this is discovered like any copy.
    assert.deepEqual(discoverInstallResidue(env).map((r) => r.label), ['Copilot plugin copy (linked)']);

    const result = run(['--yes'], env);
    assert.equal(result.code, 0, result.stdout + (result.stderr || ''));
    assert.equal(fs.existsSync(link), false, 'the symlink is removed');
    assert.ok(fs.existsSync(path.join(outside, 'package.json')),
      'the link TARGET survives — rmSync unlinks the link, so the blast radius of the missing realpath is one symlink');
  });
});

// The guard above is wired into removeResidue, and nothing can currently prove
// that by behaviour: no path discoverInstallResidue can produce is shallower
// than the three-segment floor or outside home, so deleting the call fails no
// test (measured). Rather than export removeResidue purely to hand it a
// synthetic Residue — a public surface widened for a case the product cannot
// reach — the wiring is asserted where it exists, in the source. The guard is a
// tripwire for the NEXT residue entry, whose directory name will be read off
// disk; a tripwire that gets deleted for looking dead is not one.
test('removeResidue still checks containment before it deletes anything', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
  const body = /function removeResidue\([\s\S]*?\n}/.exec(source);
  assert.ok(body, 'fixture guard: removeResidue must still be a function in this file');
  const text = body[0];
  const guard = text.indexOf('isRemovableResidueDir');
  const remove = text.indexOf('fs.rmSync');
  assert.ok(guard >= 0, 'removeResidue must consult isRemovableResidueDir — without it the delete has no containment at all');
  assert.ok(remove > guard, 'the containment check must precede the delete');

  // Reference and order are not enough on their own: `isRemovableResidueDir(dir,
  // env);` as a bare statement satisfies both while discarding the answer, and a
  // computed-and-dropped value is a shape this codebase has shipped before. So
  // the call's result must land somewhere a reader could branch on. Asked by
  // PARENT NODE rather than by matching `if (!isRemovableResidueDir(` , which
  // would false-fail the legitimate `const contained = …; if (!contained)`
  // refactor — the point is that the answer is consumed, not how it is spelled.
  const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const discarded: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'isRemovableResidueDir'
      && ts.isExpressionStatement(node.parent)) {
      discarded.push(String(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.deepEqual(discarded, [],
    'the containment answer must be consumed, not called for its own sake — a bare call statement leaves the '
    + `delete below it ungoverned (line${discarded.length === 1 ? '' : 's'} ${discarded.join(', ')})`);
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
