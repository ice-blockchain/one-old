// One project, two spellings. This file pins what each layer promises about the
// SPELLING of a path, because three different layers make three different
// promises and each one is load-bearing where it is:
//
//   shared/paths.ts        projectRoot()        CANONICALIZES (realpath on every exit)
//   shared/hook/paths.ts   resolveProjectRoot() PRESERVES the caller's spelling
//   local-prefs            projectRootHash()    realpath THEN sha256 — folds
//                                               symlinks, does NOT fold CASE
//
// The settled part first, so nobody re-litigates it: a divergent spelling does
// NOT break mutual exclusion. Every lock in the runDir family is a DIRECTORY,
// created by a non-recursive `mkdirSync` (EEXIST is the compare-and-set) or by
// `renameSync` onto a directory path (ENOTEMPTY, because the owner file is
// written INTO the pending dir before the rename). Two spellings of one project
// name the same INODE, so exclusion holds. What a divergent spelling costs is
// in-process CACHE MISSES on string-keyed maps.
//
// One of those misses would be worse than a wasted lookup, and the last section
// of this file is what keeps it unreachable: a `heldLocks` re-entrancy miss in
// state/project-state-lock.ts would make a process contend with a lock it
// already owns, spin to the acquisition deadline and throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { projectRoot } from '../paths';
import { resolveProjectRoot } from '../hook/paths';
import { defaultProjectPrefsPath, projectRootHash } from '../state/local-prefs';
import { overrideProjectDir } from '../override/paths';
import { removeStrayProjectArtifactsFromGlobalDir } from '../state/traffic-one-paths';
import {
  readPluginUseChoice,
  recordPluginUseChoice,
  resetPluginUseCache,
} from '../state/plugin-use';
import type { HookInput } from '../../core/types';

const TMP_PREFIX = 't1-spelling-';

/**
 * A temp root that is deliberately NOT realpath'd. On macOS `os.tmpdir()` is
 * `/var/folders/…`, a symlink to `/private/var/folders/…`, so this hands the
 * resolvers a non-canonical absolute path for free — which is exactly the input
 * every other root-resolution fixture in this repo canonicalizes away before it
 * builds anything.
 */
function rawTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
}

function writeState(dir: string, json: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(json), 'utf8');
}

function writePkg(dir: string, json: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json), 'utf8');
}

// ── shared/paths.ts projectRoot(): canonicalizing ────────────────────────────

test('projectRoot canonicalizes every exit — a symlinked spelling comes back as the real path', () => {
  const raw = rawTempRoot();
  try {
    const real = fs.realpathSync(raw);
    const proj = path.join(real, 'proj');
    writePkg(proj, { name: 'proj' });
    const link = path.join(real, 'link');
    fs.symlinkSync(proj, link);

    // FIXTURE READBACK
    assert.notEqual(raw, real, 'the temp root must be a NON-canonical spelling for this test to mean anything');
    assert.equal(fs.statSync(proj).ino, fs.statSync(link).ino, 'the two spellings are one inode');
    assert.equal(fs.existsSync(path.join(link, 'package.json')), true, 'the link reaches the project');

    assert.equal(
      projectRoot({ cwd: link } as HookInput), proj,
      'projectRoot must realpath: core/context.ts and hook/trace.ts compare roots across processes',
    );
    assert.equal(
      projectRoot({ cwd: path.join(raw, 'proj') } as HookInput), proj,
      'the /var → /private/var spelling canonicalizes too',
    );
  } finally {
    fs.rmSync(raw, { recursive: true, force: true });
  }
});

// ── shared/hook/paths.ts resolveProjectRoot(): spelling-preserving ───────────

// One test per EXIT, because the exits are separate code paths and a partial
// canonicalization is the likeliest way this contract breaks.
const SPELLING_PRESERVING_EXITS: readonly {
  readonly id: string;
  readonly exit: string;
  readonly build: (root: string) => { cwd: string; file?: string; ceiling?: string; expected: string };
}[] = [
  {
    id: 'onboarded-walk',
    exit: 'nearestOnboardedRoot',
    build: (root) => {
      const proj = path.join(root, 'proj');
      writeState(proj, { mode: 'new-project', onboardingComplete: true });
      const target = path.join(proj, 'src', 'a.ts');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'x', 'utf8');
      return { cwd: path.join(proj, 'src'), file: target, expected: proj };
    },
  },
  {
    id: 'workspace-anchor',
    exit: 'nearestWorkspaceRoot',
    build: (root) => {
      const mono = path.join(root, 'mono');
      writePkg(mono, { name: 'mono', private: true, workspaces: ['packages/*'] });
      const ui = path.join(mono, 'packages', 'ui');
      fs.mkdirSync(ui, { recursive: true });
      return { cwd: ui, expected: mono };
    },
  },
  {
    id: 'ceiling-onboarded',
    exit: 'the ceiling fallback, isOnboardedProjectRoot(ceiling) branch',
    build: (root) => {
      const ws = path.join(root, 'ws');
      writeState(ws, { mode: 'new-project', onboardingComplete: true });
      const outOfTree = path.join(root, '.cursor', 'projects', 'x', 'terminals');
      fs.mkdirSync(outOfTree, { recursive: true });
      return { cwd: outOfTree, ceiling: ws, expected: ws };
    },
  },
  {
    id: 'ceiling-workspace',
    exit: 'the ceiling fallback, nearestWorkspaceRoot(ceiling) branch',
    build: (root) => {
      const ws = path.join(root, 'ws');
      writePkg(ws, { name: 'ws', private: true, workspaces: ['packages/*'] });
      const outOfTree = path.join(root, '.cursor', 'projects', 'x', 'terminals');
      fs.mkdirSync(outOfTree, { recursive: true });
      return { cwd: outOfTree, ceiling: ws, expected: ws };
    },
  },
  {
    id: 'ceiling-bare',
    exit: 'the ceiling fallback, bare `return ceiling`',
    build: (root) => {
      const ws = path.join(root, 'ws');
      fs.mkdirSync(ws, { recursive: true });
      const outOfTree = path.join(root, '.cursor', 'projects', 'x', 'terminals');
      fs.mkdirSync(outOfTree, { recursive: true });
      return { cwd: outOfTree, ceiling: ws, expected: ws };
    },
  },
  {
    id: 'membership-fallback',
    exit: 'projectMembershipRoot',
    build: (root) => {
      const repo = path.join(root, 'mercury');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'go.mod'), 'module mercury\n', 'utf8');
      const pkg = path.join(repo, 'strategies');
      fs.mkdirSync(pkg, { recursive: true });
      return { cwd: pkg, expected: repo };
    },
  },
  {
    id: 'legacy-cwd-fallback',
    exit: 'findProjectRootForHookFile (then cwd verbatim)',
    build: (root) => {
      const bare = path.join(root, 'bare');
      fs.mkdirSync(bare, { recursive: true });
      return { cwd: bare, expected: bare };
    },
  },
];

for (const row of SPELLING_PRESERVING_EXITS) {
  test(`resolveProjectRoot preserves the caller's spelling [${row.id}]`, () => {
    const raw = rawTempRoot();
    try {
      // FIXTURE READBACK — the whole test is void if the root is already canonical.
      assert.notEqual(
        raw, fs.realpathSync(raw),
        `FIXTURE [${row.id}] the temp root must be NON-canonical (os.tmpdir() is a symlink on macOS)`,
      );
      const layout = row.build(raw);
      assert.equal(
        layout.expected.startsWith(raw + path.sep) || layout.expected === raw, true,
        `FIXTURE [${row.id}] the expected root must carry the non-canonical prefix`,
      );

      const resolved = resolveProjectRoot(layout.cwd, layout.file, layout.ceiling ? { ceiling: layout.ceiling } : {});
      assert.equal(
        resolved, layout.expected,
        `[${row.id}] exit: ${row.exit} — resolveProjectRoot must NOT realpath. `
        + 'shared/retention.ts isLeakedNestedRoot deletes a nested .traffic-one when '
        + 'resolveProjectRoot(dir) !== dir, so a canonicalized exit turns every project '
        + 'reached by a non-canonical cwd into a deletion candidate.',
      );
      assert.equal(
        resolved.startsWith(fs.realpathSync(raw) + path.sep), false,
        `[${row.id}] the returned path must not have been rewritten to the canonical prefix`,
      );
    } finally {
      fs.rmSync(raw, { recursive: true, force: true });
    }
  });
}

test('a symlinked project spelling survives resolveProjectRoot verbatim', () => {
  const raw = rawTempRoot();
  try {
    const real = fs.realpathSync(raw);
    const proj = path.join(real, 'proj');
    writeState(proj, { mode: 'new-project', onboardingComplete: true });
    const link = path.join(real, 'link');
    fs.symlinkSync(proj, link);

    assert.equal(fs.statSync(proj).ino, fs.statSync(link).ino, 'FIXTURE one inode, two spellings');
    assert.equal(resolveProjectRoot(link), link, 'the symlinked spelling is returned, not the target');
    assert.equal(projectRoot({ cwd: link } as HookInput), proj, 'and the other resolver disagrees, by contract');
  } finally {
    fs.rmSync(raw, { recursive: true, force: true });
  }
});

// The consumer that makes the contract above load-bearing rather than cosmetic.
// This is `isLeakedNestedRoot` (shared/retention.ts) inlined, applied to a
// GENUINE independent project and to a REAL leak, both reached non-canonically:
// canonicalizing any exit collapses the discrimination and the sweep deletes the
// genuine one.
test('the retention sweep can still tell a genuine nested project from a leak under a non-canonical cwd', () => {
  const raw = rawTempRoot();
  try {
    assert.notEqual(raw, fs.realpathSync(raw), 'FIXTURE the root is non-canonical');

    // Genuine: its own git repo, its own mode-bearing state, no workspace ancestor.
    const independent = path.join(raw, 'outer', 'vendor', 'independent');
    fs.mkdirSync(path.join(independent, '.git'), { recursive: true });
    writeState(independent, { mode: 'new-project', onboardingComplete: true });

    // A leak: a mode-bearing state in a package BELOW a declared workspace root.
    const mono = path.join(raw, 'mono');
    writePkg(mono, { name: 'mono', private: true, workspaces: ['packages/*'] });
    writeState(mono, { mode: 'new-project', onboardingComplete: true });
    const leaked = path.join(mono, 'packages', 'ui');
    writeState(leaked, { mode: 'new-project' });

    // FIXTURE READBACK
    assert.equal(fs.existsSync(path.join(independent, '.git')), true, 'the independent project owns version control');
    assert.equal(JSON.parse(fs.readFileSync(path.join(leaked, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project',
      'the leak carries a mode, so it LOOKS like a root');

    const isLeaked = (dir: string): boolean => resolveProjectRoot(path.resolve(dir)) !== path.resolve(dir);
    assert.equal(isLeaked(independent), false,
      'a genuine independent project must resolve to ITSELF — a canonicalizing exit would make this true and DELETE it');
    assert.equal(isLeaked(leaked), true, 'the packages/ui leak still resolves up to the workspace root');
  } finally {
    fs.rmSync(raw, { recursive: true, force: true });
  }
});

// ── projectRootHash: symlinks fold, CASE does not ────────────────────────────

test('projectRootHash folds symlink spellings into one bucket', () => {
  const raw = rawTempRoot();
  try {
    const real = fs.realpathSync(raw);
    const proj = path.join(real, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    const link = path.join(real, 'link');
    fs.symlinkSync(proj, link);

    assert.equal(fs.statSync(proj).ino, fs.statSync(link).ino, 'FIXTURE one inode, two spellings');
    assert.equal(projectRootHash(link), projectRootHash(proj), 'one project, one prefs/consent bucket');
    assert.equal(projectRootHash(path.join(raw, 'proj')), projectRootHash(proj), '/var vs /private/var folds too');
    // Every consumer of the name derives it from the one function, so they cannot
    // disagree about which bucket a symlinked checkout owns.
    assert.equal(path.basename(overrideProjectDir(link)), projectRootHash(proj),
      'the override ledger lands in the same bucket as the consent answer');
    assert.equal(path.basename(path.dirname(defaultProjectPrefsPath(link))), projectRootHash(proj),
      'and so does the prefs file');
  } finally {
    fs.rmSync(raw, { recursive: true, force: true });
  }
});

// KNOWN, ACCEPTED ASYMMETRY — pinned so it cannot be "fixed" silently.
//
// `fs.realpathSync` (the JS implementation) resolves symlinks but returns the
// caller's CASE; `fs.realpathSync.native` returns the on-disk case. On a
// case-insensitive volume that makes `/u/Proj` and `/u/proj` one directory with
// TWO buckets — two consent records, two prefs files, two override ledgers.
//
// Switching projectRootHash to `.native` is not a canonicalization improvement,
// it is a RELOCATION of every existing bucket: consent reverts to unanswered,
// wizard answers vanish, and every issued override token stops matching
// (override/token.ts compares `projectKey` to this hash). A real fix reads both
// spellings and migrates. Until then this test is the tripwire.
test('projectRootHash does NOT case-fold, and switching to realpathSync.native would relocate every bucket', () => {
  const raw = rawTempRoot();
  try {
    const real = fs.realpathSync(raw);
    const onDisk = path.join(real, 'MyProj');
    fs.mkdirSync(onDisk, { recursive: true });
    const lowered = path.join(real, 'myproj');

    const caseInsensitive = fs.existsSync(lowered);
    if (!caseInsensitive) {
      // A case-SENSITIVE volume: the two spellings are genuinely two directories,
      // so one bucket each is the correct answer and there is nothing to migrate.
      assert.throws(() => fs.realpathSync(lowered), 'FIXTURE the lowercased name is a different, absent path');
      return;
    }

    assert.equal(fs.realpathSync(lowered), lowered,
      'the JS realpath returns the spelling it was GIVEN — this is the whole asymmetry');
    assert.equal(fs.realpathSync.native(lowered), onDisk,
      'the native realpath returns the ON-DISK case');
    assert.notEqual(projectRootHash(lowered), projectRootHash(onDisk),
      'one directory, two buckets: two consent records and two override ledgers for one project');
    assert.notEqual(projectRootHash(lowered), require('crypto').createHash('sha256').update(onDisk).digest('hex'),
      'switching this function to realpathSync.native RELOCATES the lowercased spelling’s bucket — '
      + 'consent resets to unanswered and every issued override token stops matching. '
      + 'Any real fix must READ BOTH SPELLINGS AND MIGRATE.');
  } finally {
    fs.rmSync(raw, { recursive: true, force: true });
  }
});

// ── the $HOME self-heal names the bucket its own reader reads ────────────────

const HOME_ENV_KEYS = ['HOME', 'XDG_STATE_HOME', 'TRAFFIC_ONE_PROJECT_PREFS_PATH', 'TRAFFIC_ONE_STATE_PATH'] as const;

/**
 * A session whose $HOME is a SYMLINK — `/etc/auto_home` mounts, a relocated home,
 * a container bind. `<$HOME>/.traffic-one` is then the machine dir under a
 * non-canonical spelling, and the sweep below runs at the top of EVERY
 * SessionStart in EVERY project.
 */
function withSymlinkedHome(fn: (ctx: { home: string; realHome: string; machineDir: string }) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX)));
  const saved = Object.fromEntries(HOME_ENV_KEYS.map((k) => [k, process.env[k]]));
  const realHome = path.join(base, 'real-home');
  const home = path.join(base, 'linked-home');
  fs.mkdirSync(realHome, { recursive: true });
  fs.symlinkSync(realHome, home);
  process.env.HOME = home;
  delete process.env.XDG_STATE_HOME; // the shipped default is what makes <$HOME>/.traffic-one the machine dir
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete process.env.TRAFFIC_ONE_STATE_PATH;
  resetPluginUseCache();
  try {
    fn({ home, realHome, machineDir: path.join(home, '.traffic-one') });
  } finally {
    for (const key of HOME_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('the stray-artifact self-heal reclaims the $HOME bucket even when $HOME is a symlink', () => {
  withSymlinkedHome((ctx) => {
    const bucket = path.dirname(defaultProjectPrefsPath(ctx.home));
    fs.mkdirSync(path.join(bucket, 'onboarding', 'claude'), { recursive: true });
    fs.writeFileSync(path.join(bucket, 'preferences.json'), JSON.stringify({ hosts: {} }), 'utf8');

    // FIXTURE READBACK — the bucket name really is the realpath one, and really
    // is NOT the name a second `sha256(path.resolve(home))` derivation produces.
    assert.equal(fs.realpathSync(ctx.home), ctx.realHome, 'HOME is a symlink to a different path');
    assert.equal(path.basename(bucket), projectRootHash(ctx.realHome), 'the bucket is named by the REAL home');
    assert.notEqual(
      path.basename(bucket),
      require('crypto').createHash('sha256').update(path.resolve(ctx.home)).digest('hex'),
      'FIXTURE and NOT by the symlinked spelling — otherwise this test proves nothing',
    );
    assert.equal(readPluginUseChoice(ctx.home), null, 'FIXTURE no use-plugin answer is on record for $HOME');
    assert.equal(fs.existsSync(bucket), true, 'FIXTURE the bucket exists before the sweep');

    removeStrayProjectArtifactsFromGlobalDir();

    assert.equal(
      fs.existsSync(bucket), false,
      'the deleter must name the bucket through projectRootHash — the function that CREATED it. '
      + 'A re-derived sha256(path.resolve(home)) misses it entirely under a symlinked $HOME, '
      + 'while readPluginUseChoice one line up reads the realpath bucket.',
    );
  });
});

// The guard has to survive the fix: this is a DELETER that now hits a target it
// previously missed, so the "only when unanswered" half is what stops it eating
// a recorded answer on every SessionStart in every unrelated project.
test('a recorded $HOME answer still stops the self-heal, symlinked home included', () => {
  withSymlinkedHome((ctx) => {
    for (const enabled of [true, false]) {
      recordPluginUseChoice(ctx.home, enabled, 'wizard');
      const bucket = path.dirname(defaultProjectPrefsPath(ctx.home));
      assert.equal(fs.existsSync(bucket), true, 'FIXTURE the answer landed in the bucket');

      removeStrayProjectArtifactsFromGlobalDir();

      resetPluginUseCache();
      assert.equal(
        readPluginUseChoice(ctx.home)?.enabled, enabled,
        `a recorded ${enabled ? 'consent' : 'decline'} for a symlinked $HOME survives the sweep`,
      );
    }
  });
});

// ── why the heldLocks re-entrancy miss is UNREACHABLE ────────────────────────

// `withProjectStateLock` (state/project-state-lock.ts) is re-entrant through a
// process-local `heldLocks` set keyed by the LOCK PATH STRING. A nested
// acquisition handed a second spelling of the same project would miss that set,
// rename onto the lock directory it already owns, get ENOTEMPTY, and spin to the
// 1s deadline before throwing out of a hook.
//
// A second spelling can only enter by an independent RE-DERIVATION of the
// project root, and there is exactly one place each: shared/paths.ts
// projectRoot() and shared/hook/paths.ts resolveProjectRoot(). This test proves
// neither is reachable from inside any lock body, by module-level import closure
// over every module that acquires the lock. Import closure OVER-approximates
// call reachability, so an empty result is a proof; adding a lock acquisition to
// a module that can reach a resolver turns this red.

const SRC_ROOT = path.resolve(__dirname, '..', '..');

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) listTsFiles(abs, out);
    else if (entry.isFile() && abs.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Static imports, re-exports, and the lazy `require()`/`import()` escapes the
// state modules use to break dependency cycles — all three can pull a module in.
function localImportsOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const specs = new Set<string>();
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g)) specs.add(m[1]!);
  for (const m of text.matchAll(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]!);
  const files: string[] = [];
  for (const spec of specs) {
    const resolved = resolveSpec(file, spec);
    if (resolved) files.push(resolved);
  }
  return files;
}

test('no withProjectStateLock body can reach either project-root resolver', () => {
  const sources = listTsFiles(SRC_ROOT).filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`));
  const lockDefinition = path.join(SRC_ROOT, 'shared', 'state', 'project-state-lock.ts');
  const seeds = sources.filter((f) => f !== lockDefinition && /withProjectStateLock\s*\(/.test(fs.readFileSync(f, 'utf8')));

  // FIXTURE READBACK — a mistyped root or a renamed helper would leave this at
  // zero seeds and the test would pass vacuously.
  assert.equal(fs.existsSync(lockDefinition), true, 'FIXTURE the lock module is where this test thinks it is');
  assert.ok(seeds.length >= 10, `FIXTURE expected the lock to be acquired in many modules, found ${seeds.length}`);

  const closure = new Set<string>(seeds);
  const stack = [...seeds];
  while (stack.length) {
    for (const next of localImportsOf(stack.pop()!)) {
      if (closure.has(next)) continue;
      closure.add(next);
      stack.push(next);
    }
  }
  assert.ok(closure.size > seeds.length, 'FIXTURE the closure must actually have followed imports');

  const hookPaths = path.join(SRC_ROOT, 'shared', 'hook', 'paths.ts');
  assert.equal(
    closure.has(hookPaths), false,
    'shared/hook/paths.ts entered the import closure of a withProjectStateLock body. '
    + 'resolveProjectRoot returns the caller\'s spelling, so a nested acquisition could now be '
    + 'handed a second spelling of the project the outer frame already locked: heldLocks misses, '
    + 'the rename hits the lock directory this process owns (ENOTEMPTY) and the acquisition spins '
    + 'to its deadline and throws. Thread the outer cwd through instead of re-resolving.',
  );

  // shared/paths.ts IS in the closure — several lock bodies want pluginRoot().
  // Its projectRoot() export is the other re-derivation, so pin that nobody in
  // the closure CALLS it. (core/context.ts and shared/hook/trace.ts do, and
  // neither is in the closure.)
  const offenders: string[] = [];
  for (const file of closure) {
    if (file === path.join(SRC_ROOT, 'shared', 'paths.ts')) continue; // its own definition
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
      if (/\bpaths\.projectRoot\s*\(/.test(line) || /\bresolveProjectRoot\s*\(/.test(line)) {
        offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'a lock body can now re-derive a project root through these call sites');
});
