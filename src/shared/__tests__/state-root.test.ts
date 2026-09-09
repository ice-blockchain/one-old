// src/shared/state-root.ts exists so the machine state root is resolved in ONE
// place. Before it, the expression lived inline in six: globalTrafficOneDir
// (state/traffic-one-paths.ts), toolchainRoot (toolchain-paths.ts),
// machineStateDir (state/plugin-use.ts), oneSettingsPath (one-settings.ts), and
// the two emitted `node -e` launchers in config/opencode-mcp.ts and
// windsurf-hook-command.ts. They AGREED, but nothing made them agree, so a
// precedence step added to any one of them was silently honoured by that one
// alone. The four importable copies are covered here; the two launchers are
// standalone source and cannot import the base at all.
//
// "They agree today" is therefore not the property worth asserting — four copies
// of the same expression also agree. What is asserted here is that they can no
// longer DISAGREE: every resolver is driven from the base and observed through
// the public surface, including under a change to the base that no inlined copy
// could have anticipated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { globalTrafficOneDir } from '../state-root';
import { oneSettingsPath } from '../one-settings';
import { toolchainRoot } from '../toolchain-paths';
import { projectRootForStatePath } from '../state/plugin-use';
// Imported from its historical home as well, because six callers still resolve
// the name through here: a re-export that stopped tracking the base would
// reopen the defect for all of them while every direct test of the base passed.
import { globalTrafficOneDir as reExported } from '../state/traffic-one-paths';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PRELOAD = path.join(REPO_ROOT, 'src', 'build', 'test-preload.mjs');
const TMP_PREFIX = 't1-lane-stateroot-';

// Every resolver this file drives, so the same assertions can be run against
// the modules as loaded AND against modules re-loaded on top of a replaced base.
interface Resolvers {
  readonly globalTrafficOneDir: (env?: NodeJS.ProcessEnv) => string;
  readonly reExported: (env?: NodeJS.ProcessEnv) => string;
  readonly toolchainRoot: () => string;
  readonly oneSettingsPath: (env?: NodeJS.ProcessEnv) => string;
  readonly projectRootForStatePath: (target: string, env?: NodeJS.ProcessEnv) => string | null;
}

const LOADED: Resolvers = {
  globalTrafficOneDir, reExported, toolchainRoot, oneSettingsPath, projectRootForStatePath,
};

// Replacing the base means replacing the MODULE, not assigning over an export:
// the transpiler publishes exports as getter-only properties, so a binding patch
// throws and, worse, a namespace object under CJS interop can be a copy — which
// would silently patch nothing and pass every assertion. Swapping
// `require.cache[base].exports` and dropping the consumers from the cache makes
// the next `require` of each consumer bind to the replacement for real.
const BASE_ID = require.resolve('../state-root');
const CONSUMER_IDS = [
  require.resolve('../toolchain-paths'),
  require.resolve('../one-settings'),
  require.resolve('../state/plugin-use'),
  require.resolve('../state/traffic-one-paths'),
];

function reloadedResolvers(): Resolvers {
  const sr = require('../state-root') as typeof import('../state-root');
  const t1p = require('../state/traffic-one-paths') as typeof import('../state/traffic-one-paths');
  return {
    globalTrafficOneDir: sr.globalTrafficOneDir,
    reExported: t1p.globalTrafficOneDir,
    toolchainRoot: (require('../toolchain-paths') as typeof import('../toolchain-paths')).toolchainRoot,
    oneSettingsPath: (require('../one-settings') as typeof import('../one-settings')).oneSettingsPath,
    projectRootForStatePath: (require('../state/plugin-use') as typeof import('../state/plugin-use')).projectRootForStatePath,
  };
}

function withReplacedBase(
  replacement: { globalTrafficOneDir: typeof globalTrafficOneDir },
  body: (resolvers: Resolvers) => void,
): void {
  const baseModule = require.cache[BASE_ID];
  assert.ok(baseModule, 'the base is not in the require cache, so the swap below would do nothing');
  const savedExports = baseModule.exports;
  const savedConsumers = CONSUMER_IDS.map((id) => [id, require.cache[id]] as const);
  const restore = (): void => {
    baseModule.exports = savedExports;
    for (const [id, mod] of savedConsumers) {
      if (mod === undefined) delete require.cache[id];
      else require.cache[id] = mod;
    }
  };
  try {
    baseModule.exports = replacement;
    for (const id of CONSUMER_IDS) delete require.cache[id];
    body(reloadedResolvers());
  } finally {
    restore();
  }
}

// ── every resolver, across the environment matrix ────────────────────────────

// toolchainRoot() reads process.env directly (it takes no env argument), so a
// cell has to be installed on the process as well as passed to the resolvers
// that accept one — otherwise half the matrix would be measuring this process's
// ambient environment instead of the cell.
interface Cell {
  readonly label: string;
  readonly HOME?: string;
  readonly XDG_STATE_HOME?: string;
}

const MANAGED = ['HOME', 'XDG_STATE_HOME', 'TRAFFIC_ONE_TOOLCHAIN_ROOT', 'TRAFFIC_ONE_STATE_PATH'] as const;

function withCell(cell: Cell, body: (env: NodeJS.ProcessEnv) => void): void {
  const saved = MANAGED.map((key) => [key, process.env[key]] as const);
  const env: NodeJS.ProcessEnv = {};
  if (cell.HOME !== undefined) env.HOME = cell.HOME;
  if (cell.XDG_STATE_HOME !== undefined) env.XDG_STATE_HOME = cell.XDG_STATE_HOME;
  try {
    for (const key of MANAGED) delete process.env[key];
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    body(env);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// machineStateDir (state/plugin-use.ts) is private and has no exported spelling,
// so it is observed through the fence it feeds: a machine-owned entry of the
// machine dir is exempt from the project write fence and reports NO owning
// project. If machineStateDir resolved somewhere else, the same path would fall
// through to the generic `.traffic-one` segment search and name an owning
// project instead of null.
//
// That probe only discriminates when the machine dir sits under a `.traffic-one`
// segment, which is why the XDG cells below point XDG_STATE_HOME inside one — a
// layout state/__tests__/home-rooted-consent.test.ts already covers, not an
// invented shape.
function assertAllFourAgree(r: Resolvers, expected: string, env: NodeJS.ProcessEnv, label: string): void {
  assert.equal(r.globalTrafficOneDir(env), expected, `${label}: globalTrafficOneDir`);
  assert.equal(r.reExported(env), expected, `${label}: the state/traffic-one-paths re-export`);
  assert.equal(r.toolchainRoot(), path.join(expected, 'toolchains'), `${label}: toolchainRoot`);
  assert.equal(r.oneSettingsPath(env), path.join(expected, 'one.json'), `${label}: oneSettingsPath`);
  assert.equal(
    r.projectRootForStatePath(path.join(expected, 'one.json'), env), null,
    `${label}: machineStateDir disagreed — the fence treated ${path.join(expected, 'one.json')} as project state`,
  );
}

test('all four resolvers derive from one base across the HOME x XDG_STATE_HOME matrix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}matrix-`));
  try {
    // The XDG values live under a `.traffic-one` segment so the fence probe can
    // tell agreement from disagreement in every cell; see fenceViewOfMachineDir.
    const home = path.join(root, 'home');
    const xdg = path.join(root, 'project', '.traffic-one', 'xdg');
    const cells: Cell[] = [
      { label: 'HOME set, XDG unset (the shipped default)', HOME: home },
      { label: 'HOME set, XDG set (routine on Linux)', HOME: home, XDG_STATE_HOME: xdg },
      { label: 'HOME unset, XDG set', XDG_STATE_HOME: xdg },
      // No HOME and no XDG: both fall through to os.homedir(). Strings only —
      // nothing in this file writes, so the real home is read about and never
      // touched.
      { label: 'HOME unset, XDG unset (both fall through to os.homedir())' },
    ];

    for (const cell of cells) {
      withCell(cell, (env) => {
        const expected = cell.XDG_STATE_HOME
          ? path.join(cell.XDG_STATE_HOME, 'traffic-one')
          : path.join(cell.HOME || os.homedir(), '.traffic-one');
        assertAllFourAgree(LOADED, expected, env, cell.label);
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// THE case. Agreement across the matrix above is what four copies of one
// expression also produce; this is the one they cannot produce. A precedence
// step is added AT THE BASE and every resolver has to honour it — which is only
// possible if each of them actually reads through the base.
//
// T1_HYPOTHETICAL_STATE_ROOT is NOT a shipped knob and must never become one.
// It stands in for whatever the next real step turns out to be (the brief that
// prompted the extraction imagined a TRAFFIC_ONE_STATE_ROOT), and using a name
// the product does not own keeps the case honest: no resolver can pass by
// having special-cased it.
test('a precedence step added at the BASE is honoured by every resolver, not just one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}precedence-`));
  try {
    const home = path.join(root, 'home');
    const unstepped = path.join(home, '.traffic-one');
    const relocated = path.join(root, 'relocated', '.traffic-one');
    const stepped = {
      globalTrafficOneDir: (env: NodeJS.ProcessEnv = process.env): string => (
        env.T1_HYPOTHETICAL_STATE_ROOT || globalTrafficOneDir(env)
      ),
    };

    withCell({ label: 'stepped', HOME: home }, (env) => {
      assertAllFourAgree(LOADED, unstepped, env, 'before the step is added');

      withReplacedBase(stepped, (reloaded) => {
        // Non-vacuity in both directions. The replacement has to be inert while
        // the new variable is unset — otherwise the case could pass by having
        // broken the resolvers — and it has to be visible through the base's own
        // export, or the swap did nothing and every assertion below is empty.
        assertAllFourAgree(reloaded, unstepped, env, 'a stepped base with the step unset');

        process.env.T1_HYPOTHETICAL_STATE_ROOT = relocated;
        try {
          const withStep = { ...env, T1_HYPOTHETICAL_STATE_ROOT: relocated };
          assert.equal(reloaded.globalTrafficOneDir(withStep), relocated, 'the swap is not visible through the base');
          assertAllFourAgree(reloaded, relocated, withStep, 'a new precedence step at the base');
        } finally {
          delete process.env.T1_HYPOTHETICAL_STATE_ROOT;
        }
      });

      // The swap is undone, so nothing that follows in this process inherits it.
      assertAllFourAgree(LOADED, unstepped, env, 'after the step is removed');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// state/plugin-use.ts's machineStateDir wraps the base in path.resolve() and
// keeps doing so after the extraction. The wrapper could not move INTO the base
// (resolving there changes what every other caller returns for the same env),
// and it cannot be dropped either.
//
// What it covers is narrow and worth stating exactly, because the obvious guess
// is wrong: path.join already normalizes `..`, so the ONLY input that reaches
// the base and comes back non-absolute is a RELATIVE HOME. No host produces
// one, so this is defensive rather than load-bearing today. It is kept because
// removing it fails SILENTLY and expensively — projectRootForStatePath resolves
// its target, so a machine dir left relative fails containment segment-wise,
// the machine-owned carve-out stops applying, and one.json (where the consent
// answer itself is stored) is fenced as project state, which deadlocks
// recording any answer at all.
test('the machine-dir carve-out holds even when the base returns a relative path', () => {
  withCell({ label: 'relative HOME', HOME: 'relative-home' }, (env) => {
    assert.equal(globalTrafficOneDir(env), path.join('relative-home', '.traffic-one'));
    assert.equal(
      projectRootForStatePath(path.join('relative-home', '.traffic-one', 'one.json'), env), null,
      'the consent answer\'s own file was fenced as project state, which deadlocks recording it',
    );
  });
});

// ── the split that must survive the extraction ───────────────────────────────

// TRAFFIC_ONE_TOOLCHAIN_ROOT is checked FIRST by toolchainRoot() and is
// deliberately NOT part of the shared base: it relocates only the gigabyte-scale
// half (venvs, npm prefixes, browser binaries) while XDG_STATE_HOME relocates the
// whole kilobyte-scale machine tree. The careless version of this extraction
// folds the two together, and the symptom is silent — a machine with the
// toolchain knob set quietly grows a second copy of everything.
test('toolchainRoot checks TRAFFIC_ONE_TOOLCHAIN_ROOT FIRST and never consults the base when it is set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}toolchain-`));
  try {
    const explicit = path.join(root, 'explicit-toolchains');
    const xdg = path.join(root, 'xdg');

    const refuse = {
      globalTrafficOneDir: (): string => {
        throw new Error('toolchainRoot consulted the shared base despite TRAFFIC_ONE_TOOLCHAIN_ROOT');
      },
    };

    withCell({ label: 'both set', HOME: path.join(root, 'home'), XDG_STATE_HOME: xdg }, () => {
      // Stronger than comparing strings: the base is replaced by something that
      // THROWS, so an extraction that resolved the base first and overrode it
      // afterwards fails here even though it returns the right answer.
      process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = explicit;
      withReplacedBase(refuse, (reloaded) => {
        assert.equal(reloaded.toolchainRoot(), path.resolve(explicit));
      });

      // …and the fall-through is still wired, or the case above would be
      // satisfied by a toolchainRoot() that ignored the base entirely. Asserted
      // through the SAME reloaded module, so the two halves cannot be answered
      // by two different toolchainRoots.
      withReplacedBase({ globalTrafficOneDir }, (reloaded) => {
        assert.equal(reloaded.toolchainRoot(), path.resolve(explicit));
        delete process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
        assert.equal(reloaded.toolchainRoot(), path.join(xdg, 'traffic-one', 'toolchains'));
      });
      assert.equal(toolchainRoot(), path.join(xdg, 'traffic-one', 'toolchains'));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── the release blocker, measured rather than reasoned about ─────────────────

// The suite wrote thousands of sha256-named junk buckets into the maintainer's
// REAL ~/.traffic-one, and the fix was ONE line in src/build/test-preload.mjs
// pinning XDG_STATE_HOME to a per-process temp dir. That pin redirects every
// writer only because every reader consults XDG_STATE_HOME the same way, so an
// extraction that changed how ANY resolver reads the environment would reopen
// the blocker silently: the pollution lands outside the repo, where no assertion
// looks, and the suite stays green.
//
// src/build/__tests__/test-preload.test.ts proves the pin is SET. This proves
// the other half — that the pin actually moves the four resolvers — by asking
// them, in a child that loads the real preload with the real HOME present.
interface ChildReport {
  readonly HOME?: string;
  readonly XDG_STATE_HOME?: string;
  readonly TRAFFIC_ONE_TOOLCHAIN_ROOT?: string;
  readonly TRAFFIC_ONE_STATE_PATH?: string;
  readonly resolved: Record<string, string>;
}

const CHILD_SCRIPT = [
  // Absolute requires, so the child needs no cwd and no relative resolution;
  // tsx's CJS hook is global once loaded and handles the .ts extensions.
  `const sr=require(${JSON.stringify(path.join(REPO_ROOT, 'src/shared/state-root.ts'))});`,
  `const tp=require(${JSON.stringify(path.join(REPO_ROOT, 'src/shared/toolchain-paths.ts'))});`,
  `const os_=require(${JSON.stringify(path.join(REPO_ROOT, 'src/shared/one-settings.ts'))});`,
  `const pu=require(${JSON.stringify(path.join(REPO_ROOT, 'src/shared/state/plugin-use.ts'))});`,
  `const t1p=require(${JSON.stringify(path.join(REPO_ROOT, 'src/shared/state/traffic-one-paths.ts'))});`,
  'const e=process.env;',
  'const b=sr.globalTrafficOneDir(e);',
  // The fence's view of the machine dir, as a PATH rather than a boolean, so a
  // machineStateDir that moved is reported with the place it moved to.
  "const prefs=require('path').join(b,'projects','probe','preferences.json');",
  'process.stdout.write(JSON.stringify({',
  '  HOME:e.HOME, XDG_STATE_HOME:e.XDG_STATE_HOME,',
  '  TRAFFIC_ONE_TOOLCHAIN_ROOT:e.TRAFFIC_ONE_TOOLCHAIN_ROOT, TRAFFIC_ONE_STATE_PATH:e.TRAFFIC_ONE_STATE_PATH,',
  '  resolved:{',
  '    "state-root.globalTrafficOneDir":b,',
  '    "traffic-one-paths.globalTrafficOneDir":t1p.globalTrafficOneDir(e),',
  '    "toolchain-paths.toolchainRoot":tp.toolchainRoot(),',
  '    "one-settings.oneSettingsPath":os_.oneSettingsPath(e),',
  '    "plugin-use.fenceOwnerOfMachinePrefs":String(pu.projectRootForStatePath(prefs,e)),',
  '  },',
  '}));',
].join('');

function askResolvers(opts: { preload: boolean; tmp: string }): ChildReport {
  const args = [
    ...(opts.preload ? ['--import', pathToFileURL(PRELOAD).href] : []),
    '--import', 'tsx', '-e', CHILD_SCRIPT,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // The real HOME, on purpose: the whole question is whether the pin keeps the
    // resolvers away from it. A child with no HOME could not answer it.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: opts.tmp },
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as ChildReport;
}

test('with XDG_STATE_HOME pinned, no resolver lands anywhere near the real ~/.traffic-one', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}pin-`));
  try {
    const realHome = process.env.HOME as string;
    assert.ok(realHome, 'no HOME to protect, so this case would pass vacuously');
    const realMachineDir = path.join(realHome, '.traffic-one');
    const scratchParent = path.join(tmp, 'traffic-one-test-state');

    // Leg 1 — the pin OFF. Not a control for its own sake: without it, "nothing
    // is under the real machine dir" could be true because the resolvers are
    // broken, because the child never ran them, or because the fixture had no
    // HOME. This leg shows the real machine dir is exactly where they go when
    // the one line in the preload is absent, which is the incident itself.
    // Strings only: the child resolves paths and writes nothing.
    const unpinned = askResolvers({ preload: false, tmp });
    assert.equal(unpinned.HOME, realHome);
    assert.equal(unpinned.XDG_STATE_HOME, undefined, 'the unpinned leg must have no XDG_STATE_HOME');
    for (const [name, value] of Object.entries(unpinned.resolved)) {
      if (name.startsWith('plugin-use.')) continue; // reports an owning project, not a dir
      assert.ok(
        value === realMachineDir || value.startsWith(realMachineDir + path.sep),
        `without the pin ${name} was expected under ${realMachineDir}, got ${value} — this leg no longer reproduces the incident`,
      );
    }

    // Leg 2 — the pin ON, which is how every one of the suite's ~291 test-file
    // processes runs.
    const pinned = askResolvers({ preload: true, tmp });
    // The pin now remaps HOME as well as XDG_STATE_HOME: documentedBinDir is
    // `$HOME/.traffic-one/bin` and ignored XDG, so a HOME-only pin left the
    // suite writing the real bin directory. The child's TMPDIR is this case's
    // scratch, so its scratch parent is not the suite's and HOME moves again.
    assert.notEqual(pinned.HOME, realHome, 'the pin must remap an ambient HOME');
    assert.ok(
      pinned.HOME?.startsWith(path.join(tmp, 'traffic-one-test-state') + path.sep),
      `expected pinned HOME under the child's scratch, got ${pinned.HOME}`,
    );
    assert.ok(
      pinned.XDG_STATE_HOME?.startsWith(scratchParent + path.sep),
      `expected a scratch root under ${scratchParent}, got ${pinned.XDG_STATE_HOME}`,
    );
    // The two escapes that would let a resolver out from under the pin without
    // touching XDG_STATE_HOME at all.
    assert.equal(pinned.TRAFFIC_ONE_TOOLCHAIN_ROOT, undefined);
    assert.equal(pinned.TRAFFIC_ONE_STATE_PATH, undefined);

    // The blocker itself, asserted FIRST and per resolver, so a regression says
    // which writer escaped rather than printing a diff of five paths.
    for (const [name, value] of Object.entries(pinned.resolved)) {
      if (name.startsWith('plugin-use.')) continue; // reports an owning project, not a dir
      assert.equal(
        value === realMachineDir || value.startsWith(realMachineDir + path.sep), false,
        `${name} resolved into the developer's real machine dir: ${value}`,
      );
    }

    // And positively, so "not under the real home" cannot be satisfied by a
    // resolver that returns something useless.
    const expectedBase = path.join(pinned.XDG_STATE_HOME as string, 'traffic-one');
    assert.deepEqual(pinned.resolved, {
      'state-root.globalTrafficOneDir': expectedBase,
      'traffic-one-paths.globalTrafficOneDir': expectedBase,
      'toolchain-paths.toolchainRoot': path.join(expectedBase, 'toolchains'),
      'one-settings.oneSettingsPath': path.join(expectedBase, 'one.json'),
      // null = machine-owned = the write fence stands aside, which is only true
      // if machineStateDir moved with the pin too.
      'plugin-use.fenceOwnerOfMachinePrefs': 'null',
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
