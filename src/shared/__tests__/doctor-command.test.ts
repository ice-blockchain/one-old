// src/shared/__tests__/doctor-command.test.ts
// doctorScriptPath() is self-relative, so no *_PLUGIN_ROOT env override can
// make the doctor recovery command name a file that is not the running
// runtime's own — and, critically, cannot make the runtime print a command its
// own gates then deny. See doctor-command.ts's header for the full reasoning.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  doctorCommand,
  doctorScriptPath,
  doctorShimCommand,
  doctorShimPath,
  gateExemptDoctorScriptPaths,
  gateExemptShimDirs,
  selfRelativePluginRoot,
} from '../doctor-command';
import {
  documentedBinDir,
  ensureRunnerShims,
  RUNNER_SHIMS,
  runnerShimDirs,
  stableBinDir,
} from '../runner-shims';
import { isTrafficOneDoctorCommand } from '../tool-classify';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENV_KEYS = ['TRAFFIC_ONE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CURSOR_PLUGIN_ROOT'] as const;

function withPluginRootEnv<T>(overrides: Partial<Record<typeof ENV_KEYS[number], string>>, run: () => T): T {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return run();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('doctorScriptPath trusts a verified (installed) env-overridden root as-is', () => {
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cmd-installed-'));
  try {
    fs.mkdirSync(path.join(installed, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'scripts', 'hook-runtime.cjs'), '', 'utf8');
    fs.mkdirSync(path.join(installed, 'rules'), { recursive: true });
    // An EMPTY rules/ is a half-extracted install, not an install: the layout
    // classifier requires real content, so the fixture must ship a rule.
    fs.writeFileSync(path.join(installed, 'rules', 'core.md'), '# Core rule\n', 'utf8');
    fs.mkdirSync(path.join(installed, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'scripts', 'doctor.cjs'), '', 'utf8');
    // Even a perfectly VERIFIED env-supplied root is ignored: this path doubles
    // as the gate's exemption anchor, and honouring env here is what previously
    // made the product print a doctor command the gate then denied.
    withPluginRootEnv({ TRAFFIC_ONE_PLUGIN_ROOT: installed }, () => {
      assert.equal(doctorScriptPath(), path.join(REPO_ROOT, 'scripts', 'doctor.cjs'));
    });
  } finally {
    fs.rmSync(installed, { recursive: true, force: true });
  }
});

test('every doctor command the runtime prints is accepted by the gate grammar, whatever the env says', () => {
  // The invariant this whole area exists for: the product must never tell a
  // stuck user to run a command its own gates refuse. Hosts really do set
  // CLAUDE_PLUGIN_ROOT/CODEX_PLUGIN_ROOT, so the hostile case is the normal one.
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cmd-foreign-'));
  try {
    fs.mkdirSync(path.join(foreign, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(foreign, 'scripts', 'hook-runtime.cjs'), '', 'utf8');
    fs.writeFileSync(path.join(foreign, 'scripts', 'doctor.cjs'), 'ARBITRARY', 'utf8');
    fs.mkdirSync(path.join(foreign, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(foreign, 'rules', 'core.md'), '# Core rule\n', 'utf8');
    for (const key of ENV_KEYS) {
      withPluginRootEnv({ [key]: foreign }, () => {
        for (const command of [doctorCommand(), doctorShimCommand()]) {
          assert.equal(
            isTrafficOneDoctorCommand('Bash', { command }),
            true,
            `${key}=<foreign root>: the runtime printed a command the gate rejects: ${command}`,
          );
        }
        assert.equal(
          isTrafficOneDoctorCommand('Bash', { command: `node ${path.join(foreign, 'scripts', 'doctor.cjs')}` }),
          false,
          `${key}: an env-supplied doctor.cjs must never become gate-exempt`,
        );
      });
    }
  } finally {
    fs.rmSync(foreign, { recursive: true, force: true });
  }
});

test('doctorScriptPath falls back off a stale/unverified env-overridden root instead of naming a nonexistent file', () => {
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cmd-stale-'));
  try {
    // Deliberately empty: neither installed markers nor source markers.
    withPluginRootEnv({ TRAFFIC_ONE_PLUGIN_ROOT: stale }, () => {
      const resolved = doctorScriptPath();
      assert.notEqual(resolved, path.join(stale, 'scripts', 'doctor.cjs'), 'must not trust the unverified override');
      // Falls back to the running module's OWN root — this checkout, since
      // that is where doctor-command.ts (and therefore doctor.cjs, per
      // build-runtime.ts's SHIMS) actually lives.
      assert.equal(resolved, path.join(REPO_ROOT, 'scripts', 'doctor.cjs'));
    });
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
  }
});

test('doctorScriptPath falls back when the env-overridden root does not exist at all', () => {
  withPluginRootEnv({ CLAUDE_PLUGIN_ROOT: '/nonexistent/stale/plugin/root/1785169657252' }, () => {
    assert.equal(doctorScriptPath(), path.join(REPO_ROOT, 'scripts', 'doctor.cjs'));
  });
});

// ── the grammar anchor (gateExemptDoctorScriptPaths) ─────────────────────────
// Split deliberately from doctorScriptPath(): PROSE may follow the resolved
// root, a GATE exemption may not. See doctor-command.ts's header.

test('gateExemptDoctorScriptPaths is exactly {self-relative doctor, documented shim} and ignores every plugin-root env var', () => {
  // The exemption set is the WRITE set minus the anchors env can relocate. It
  // used to be `runnerShimDirs()` entire, which meant XDG_STATE_HOME or
  // TRAFFIC_ONE_TOOLCHAIN_ROOT — both inputs to the hook process — moved the
  // anchor, and a file planted at the moved anchor was admitted. Shims are
  // still WRITTEN to every dir (asserted just below, and by the shim test); it
  // is only the security exemption that stops following them.
  const expected = [
    path.join(selfRelativePluginRoot(), 'scripts', 'doctor.cjs'),
    ...gateExemptShimDirs().map((dir) => path.join(dir, 'doctor.cjs')),
  ];
  assert.deepEqual(gateExemptDoctorScriptPaths(), expected);
  assert.deepEqual(gateExemptShimDirs(), [documentedBinDir()],
    'only the HOME-derived anchor, which is the one spelling shipped prose prints');
  assert.equal(selfRelativePluginRoot(), REPO_ROOT);
  // The DOCUMENTED spelling is always in the set — that is B1's invariant, and
  // it is what keeps "we never print a command we block" true.
  assert.ok(gateExemptDoctorScriptPaths().includes(doctorShimPath()));
  assert.equal(doctorShimPath(), path.join(documentedBinDir(), 'doctor.cjs'));
  assert.ok(runnerShimDirs().includes(stableBinDir()),
    'the env-derived dir stays in the WRITE set for relocated installs — narrowing the exemption must not stop us writing it');
  // A shipped shim, not a path this module invented.
  assert.ok(RUNNER_SHIMS.some((entry) => entry.shim === 'doctor.cjs' && entry.rel === 'scripts/doctor.cjs'));

  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-anchor-installed-'));
  try {
    fs.mkdirSync(path.join(installed, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'scripts', 'hook-runtime.cjs'), '', 'utf8');
    fs.writeFileSync(path.join(installed, 'scripts', 'doctor.cjs'), '', 'utf8');
    fs.mkdirSync(path.join(installed, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'rules', 'core.md'), '# Core rule\n', 'utf8');
    for (const key of ENV_KEYS) {
      withPluginRootEnv({ [key]: installed }, () => {
        // Neither the anchor NOR the prose path moves, even though this root is
        // a complete, 'installed'-classified tree holding a real
        // scripts/doctor.cjs. They are one expression precisely so that a user
        // can always run what the product printed.
        assert.deepEqual(gateExemptDoctorScriptPaths(), expected, key);
        assert.equal(doctorScriptPath(), expected[0], key);
      });
    }
  } finally {
    fs.rmSync(installed, { recursive: true, force: true });
  }
});

// Prose and grammar must agree in every SHIPPED configuration: no override
// (a real install resolves self-relative), a host-set override naming the
// install that is actually running, and an unverified override (which
// doctorScriptPath already falls back off).
test('doctorScriptPath is gate-exempt in every shipped configuration', () => {
  const anchors = new Set(gateExemptDoctorScriptPaths());
  withPluginRootEnv({}, () => {
    assert.ok(anchors.has(doctorScriptPath()), 'no override');
  });
  withPluginRootEnv({ CLAUDE_PLUGIN_ROOT: REPO_ROOT }, () => {
    assert.ok(anchors.has(doctorScriptPath()), 'override naming the running root');
  });
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-anchor-stale-'));
  try {
    withPluginRootEnv({ TRAFFIC_ONE_PLUGIN_ROOT: stale }, () => {
      assert.ok(anchors.has(doctorScriptPath()), 'unverified override falls back to the running root');
    });
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
  }
});

// ── B1: the documented shim literal, across every state-location env ────────
// The previous coverage varied only the *_PLUGIN_ROOT vars, and only for
// doctorScriptPath(); the single test that touched the shim DELETED
// XDG_STATE_HOME — the exact variable that produced the defect. So the state
// vars are the axis to vary here, and the assertion is the pair of properties
// that together make a printed recovery command real:
//   (a) the file the prose NAMES exists after ensureRunnerShims();
//   (b) the gate ACCEPTS that same spelling, absolute and tilde.
// Two failures composed in the defect — the gate refused the command and the
// file was somewhere else — so asserting only one of them would have missed it.

// The literal that is hardcoded in shipped prose in ~60 places. Written out
// rather than derived, deliberately: deriving it from the same function under
// test is how a test agrees with a bug.
const DOCUMENTED_SHIM_LITERAL = '~/.traffic-one/bin/doctor.cjs';

interface StateEnvCell {
  readonly label: string;
  readonly xdgStateHome?: string;
  readonly toolchainRoot?: string;
}

function withStateEnv<T>(home: string, cell: StateEnvCell, run: () => T): T {
  const keys = ['HOME', 'USERPROFILE', 'XDG_STATE_HOME', 'TRAFFIC_ONE_TOOLCHAIN_ROOT'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    if (cell.xdgStateHome) process.env.XDG_STATE_HOME = cell.xdgStateHome;
    else delete process.env.XDG_STATE_HOME;
    if (cell.toolchainRoot) process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = cell.toolchainRoot;
    else delete process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
    return run();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('the documented shim literal exists AND is gate-accepted under every HOME/XDG/TOOLCHAIN_ROOT combination', () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-shim-env-')));
  try {
    const cells: readonly StateEnvCell[] = [
      { label: 'baseline (neither set)' },
      { label: 'XDG_STATE_HOME set (routine on Linux)', xdgStateHome: path.join(scratch, 'xdg-state') },
      { label: 'TRAFFIC_ONE_TOOLCHAIN_ROOT set (our own documented override)', toolchainRoot: path.join(scratch, 'toolchains') },
      {
        label: 'both set (toolchain root wins for the toolchain)',
        xdgStateHome: path.join(scratch, 'xdg-state'),
        toolchainRoot: path.join(scratch, 'toolchains'),
      },
      { label: 'XDG_STATE_HOME pointing INSIDE home', xdgStateHome: path.join(scratch, 'home-a', '.local', 'state') },
    ];
    // A fresh HOME per cell: sharing one would let the shims written by an
    // earlier cell satisfy a later one, which is precisely how the original
    // reproduction first appeared to pass.
    let index = 0;
    for (const cell of cells) {
      index += 1;
      const home = path.join(scratch, `home-${index}`);
      fs.mkdirSync(home, { recursive: true });
      withStateEnv(home, cell, () => {
        const documented = path.join(home, DOCUMENTED_SHIM_LITERAL.slice('~/'.length));
        assert.equal(doctorShimPath(), documented, `${cell.label}: the PRINTED shim path must be the documented one`);

        // (a) exists — for EVERY shim, since prose hardcodes ten of them under
        // this same directory, not just the doctor.
        const { dirs } = ensureRunnerShims();
        assert.ok(dirs.includes(documentedBinDir()), `${cell.label}: the documented dir must be written`);
        assert.ok(dirs.includes(stableBinDir()), `${cell.label}: the env-derived dir must still be written`);
        for (const { shim } of RUNNER_SHIMS) {
          for (const dir of dirs) {
            assert.ok(fs.existsSync(path.join(dir, shim)), `${cell.label}: ${path.join(dir, shim)} was not written`);
          }
        }

        // (b) accepted — in both SHIPPED spellings, with and without flags.
        const spellings = [documented, DOCUMENTED_SHIM_LITERAL];
        for (const spelling of spellings) {
          for (const args of ['', ' --bundle', ' --run 1785169657252', ' --run 1785169657252 --bundle', ' --session 019fbca1-2222-4333-8444-555566667777']) {
            const command = `node ${spelling}${args}`;
            assert.equal(
              isTrafficOneDoctorCommand('Bash', { command }),
              true,
              `${cell.label}: the gate denies a command shipped prose prints: ${command}`,
            );
          }
        }

        // (c) and the ENV-DERIVED spelling is written but NOT exempt. It used
        // to be asserted accepted, in the same list as the two above and under
        // the same "shipped prose prints this" message — but prose does not
        // print it: line 253 of this test pins doctorShimPath() to the
        // documented literal in EVERY cell, so the runtime never emits this
        // spelling at all.
        //
        // It is excluded because the exemption set and the write set are not
        // the same set. stableBinDir() follows XDG_STATE_HOME and
        // TRAFFIC_ONE_TOOLCHAIN_ROOT, both of which are INPUTS to the hook
        // process, so admitting it let an agent move the anchor and plant a
        // file there. Writing the shim to a relocated state dir stays correct;
        // anchoring a security exemption on a path the caller can steer does
        // not. The recovery the operator was HANDED still works — that is what
        // (b) just measured, in this same cell.
        const relocated = path.join(stableBinDir(), 'doctor.cjs');
        if (relocated !== documented) {
          assert.equal(
            isTrafficOneDoctorCommand('Bash', { command: `node ${relocated}` }),
            false,
            `${cell.label}: an env-relocatable anchor must not carry the exemption: ${relocated}`,
          );
        }
        // And what the runtime prints agrees with both.
        assert.equal(isTrafficOneDoctorCommand('Bash', { command: doctorShimCommand() }), true, cell.label);
        assert.equal(isTrafficOneDoctorCommand('Bash', { command: doctorCommand() }), true, cell.label);
      });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// A relocated install keeps a LIVE shim where it put it, rather than being
// stranded on a stale copy: both directories are written from the same source
// in the same pass, so the two spellings are byte-identical, never divergent.
test('both shim directories hold identical bytes, so neither copy can go stale', () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-shim-stale-')));
  try {
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    withStateEnv(home, { label: 'xdg', xdgStateHome: path.join(scratch, 'xdg-state') }, () => {
      const dirs = ensureRunnerShims().dirs;
      assert.equal(dirs.length, 2, 'a relocated state home must produce two shim directories');
      for (const { shim } of RUNNER_SHIMS) {
        const [first, second] = dirs.map((dir) => fs.readFileSync(path.join(dir, shim), 'utf8'));
        assert.equal(first, second, `${shim} differs between ${dirs[0]} and ${dirs[1]}`);
      }
      // A corrupted/stale copy is repaired by the next call, not left behind.
      const stale = path.join(dirs[1] as string, 'doctor.cjs');
      fs.writeFileSync(stale, 'STALE\n');
      ensureRunnerShims();
      assert.equal(
        fs.readFileSync(stale, 'utf8'),
        fs.readFileSync(path.join(dirs[0] as string, 'doctor.cjs'), 'utf8'),
        'a diverged copy must be rewritten on the next ensureRunnerShims()',
      );
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('doctorShimCommand quotes the version-stable shim path', () => {
  assert.equal(doctorShimCommand(), `node '${doctorShimPath()}'`);
});

test('the printed doctor commands shell-quote their script path', () => {
  // The plugin-root spelling is self-relative and so cannot be pointed at a
  // spacey path from a test; the shim spelling derives from HOME/XDG, which can.
  // Between them both quoting call sites are covered.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor home with space '));
  const savedHome = process.env.HOME;
  const savedXdg = process.env.XDG_STATE_HOME;
  try {
    process.env.HOME = home;
    delete process.env.XDG_STATE_HOME;
    const shimCommand = doctorShimCommand();
    assert.match(shimCommand, /^node /);
    assert.ok(
      shimCommand.includes(`'${doctorShimPath()}'`),
      `a HOME containing a space must be quoted: ${shimCommand}`,
    );
    assert.ok(doctorShimPath().startsWith(home), 'the shim path must follow HOME');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = savedXdg;
    fs.rmSync(home, { recursive: true, force: true });
  }

  const command = doctorCommand();
  assert.match(command, /^node /);
  assert.ok(command.includes(`'${doctorScriptPath()}'`), `the script path must be quoted: ${command}`);
});

// Only the ABSOLUTE spelling was covered for quoting, but the tilde spelling
// is the one shipped prose actually prints — and it is the spelling with a
// quoting hazard the absolute one does not have: the shell expands `~` only
// when it is UNQUOTED and word-initial, so `'~/…'` names a literal directory
// called `~`. The grammar has to expand exactly what a shell would.
test('the tilde spelling is accepted unquoted, and rejected when quoting defeats expansion', () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-shim-tilde-')));
  try {
    const home = path.join(scratch, 'home with space');
    fs.mkdirSync(home, { recursive: true });
    withStateEnv(home, { label: 'tilde' }, () => {
      ensureRunnerShims();
      const accepted = (command: string): boolean => isTrafficOneDoctorCommand('Bash', { command });

      assert.equal(accepted(`node ${DOCUMENTED_SHIM_LITERAL}`), true, 'the unquoted tilde spelling prose prints');
      assert.equal(accepted(`node ${DOCUMENTED_SHIM_LITERAL} --bundle`), true, '…with a flag');
      // A HOME containing a space is why the runtime quotes the EXPANDED path
      // rather than shipping the tilde: `node ~/…` is one word to the shell
      // only until the expansion introduces a space.
      assert.ok(doctorShimCommand().includes(`'${doctorShimPath()}'`), doctorShimCommand());
      assert.equal(accepted(doctorShimCommand()), true, 'the quoted absolute spelling the runtime prints');

      // Quoted tilde: a real shell would look for a directory literally named
      // `~`, so this names no file and must not be exempt.
      assert.equal(accepted(`node '${DOCUMENTED_SHIM_LITERAL}'`), false, 'single-quoted tilde does not expand');
      assert.equal(accepted(`node "${DOCUMENTED_SHIM_LITERAL}"`), false, 'double-quoted tilde does not expand');
      // Not word-initial, and the other tilde form bash supports — neither is
      // the documented spelling, and neither may widen the exemption.
      assert.equal(accepted(`node x~/.traffic-one/bin/doctor.cjs`), false, 'a mid-word tilde is literal');
      assert.equal(accepted('node ~root/.traffic-one/bin/doctor.cjs'), false, '~user is never expanded');
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
