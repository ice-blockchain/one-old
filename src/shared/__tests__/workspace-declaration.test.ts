// The DELETION-AUTHORITY half of a workspace declaration.
//
// shared/hook/paths.ts `dirDeclaresWorkspace` decides what may ANCHOR
// RESOLUTION and is lenient on purpose. shared/retention.ts isLeakedNestedRoot
// decides what may be DELETED and asks the same resolver a stricter question,
// `workspaceAuthority: 'membership'`. These tests pin the stricter half, the
// invariant that binds it to the lenient half, and — the load-bearing part — the
// DIRECTION each of them fails in when the declaration cannot be read.
//
// Every test below is named in the mutation table in the lane report: each one
// is the test that goes red when one specific guard is neutered on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readWorkspaceDeclaration, workspaceClaimsDescendant } from '../hook/workspace-declaration';
import { isUnclaimedWorkspaceSubPackage, resolveProjectRoot } from '../hook/paths';
import { sweepTrafficOneRetention } from '../retention';

const TMP_PREFIX = 't1-wsdecl-';

function withRoot(body: (root: string) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  try {
    body(fs.realpathSync(created));
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
  }
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

function declarePkg(dir: string, workspaces: unknown): void {
  write(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'container', private: true, workspaces }, null, 2)}\n`);
}

function declarePnpm(dir: string, body: string): void {
  write(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'container', private: true }, null, 2)}\n`);
  write(path.join(dir, 'pnpm-workspace.yaml'), body);
}

/** An independently onboarded project: its own manifest, its own VCS, its own mode. */
function onboardedProject(dir: string): string {
  write(path.join(dir, 'package.json'), `${JSON.stringify({ name: path.basename(dir) }, null, 2)}\n`);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  write(path.join(dir, '.traffic-one', '.one.json'),
    `${JSON.stringify({ mode: 'existing-codebase', onboardingComplete: true }, null, 2)}\n`);
  return dir;
}

/** Leftover mode-bearing state with no project evidence — the sweep may still heal this. */
function leftoverProject(dir: string): string {
  write(path.join(dir, 'package.json'), `${JSON.stringify({ name: path.basename(dir) }, null, 2)}\n`);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  write(path.join(dir, '.traffic-one', '.one.json'),
    `${JSON.stringify({ mode: 'existing-codebase' }, null, 2)}\n`);
  return dir;
}

/** What the SessionStart sweep would delete, relative to `container`. */
function plannedLeaks(container: string): string[] {
  return sweepTrafficOneRetention(container, { dryRun: true }).actions
    .filter((action) => action.reason.includes('leaked nested'))
    .map((action) => path.relative(container, action.path))
    .sort();
}

// ── the declaration shapes, each handled or explicitly declined ──────────────

test('workspace declaration: every shape this reader handles, and what each claims', () => {
  const cases: readonly [label: string, declare: (dir: string) => void, claims: Record<string, boolean>][] = [
    ['npm array of patterns', (d) => declarePkg(d, ['packages/*']), { 'packages/ui': true, 'apps/web': false }],
    ['npm array, literal directory, no wildcard', (d) => declarePkg(d, ['apps/web']), { 'apps/web': true, 'apps/api': false }],
    ['npm array, bare `*`', (d) => declarePkg(d, ['*']), { 'apps': true, 'apps/web': true }],
    ['npm array, bare `**`', (d) => declarePkg(d, ['**']), { 'apps': true, 'a/b/c': true }],
    ['npm array, `**` under a prefix', (d) => declarePkg(d, ['packages/**']), { 'packages/a/b': true, 'packages': false, 'apps/a': false }],
    ['npm array, `**` between segments', (d) => declarePkg(d, ['packages/**/ui']), { 'packages/ui': true, 'packages/group/ui': true, 'packages/group': false }],
    ['npm array, `?`', (d) => declarePkg(d, ['pkg?']), { pkg1: true, pkg: false, pkg12: false }],
    ['npm array with a negation', (d) => declarePkg(d, ['packages/*', '!packages/excluded']), { 'packages/ui': true, 'packages/excluded': false }],
    ['npm object form', (d) => declarePkg(d, { packages: ['packages/*'] }), { 'packages/ui': true, 'apps/web': false }],
    ['npm object form, empty list', (d) => declarePkg(d, { packages: [] }), { 'packages/ui': false }],
    ['pnpm block sequence', (d) => declarePnpm(d, 'packages:\n  - "packages/*"\n'), { 'packages/ui': true, 'apps/web': false }],
    ['pnpm block sequence, single quotes', (d) => declarePnpm(d, "packages:\n  - 'apps/*'\n"), { 'apps/web': true, 'packages/ui': false }],
    ['pnpm block sequence, unquoted plain scalar', (d) => declarePnpm(d, 'packages:\n  - packages/*\n'), { 'packages/ui': true }],
    ['pnpm flow sequence', (d) => declarePnpm(d, "packages: ['packages/*', 'apps/*']\n"), { 'packages/ui': true, 'apps/web': true, 'libs/x': false }],
    ['pnpm with comments and a sibling top-level key', (d) => declarePnpm(d, '# top\npackages:\n  # inner\n  - "packages/*"\ncatalog:\n  react: ^19\n'), { 'packages/ui': true }],
    ['pnpm with a quoted negation', (d) => declarePnpm(d, 'packages:\n  - "packages/*"\n  - "!packages/excluded"\n'), { 'packages/ui': true, 'packages/excluded': false }],
    ['pnpm with no packages key at all', (d) => declarePnpm(d, 'catalog:\n  react: ^19\n'), { 'packages/ui': false }],
    ['a scoped directory name, which is not extglob', (d) => declarePkg(d, ['packages/@scope/*']), { 'packages/@scope/ui': true, 'packages/ui': false }],
  ];

  for (const [label, declare, claims] of cases) {
    withRoot((root) => {
      declare(root);
      assert.equal(readWorkspaceDeclaration(root).kind, 'patterns', `[${label}] must be readable`);
      for (const [rel, expected] of Object.entries(claims)) {
        assert.equal(workspaceClaimsDescendant(root, path.join(root, rel)), expected,
          `[${label}] claims ${rel}?`);
      }
    });
  }
});

// The declined shapes. Each one is a declaration a HUMAN can read and this
// reader will not guess at — and every one of them must land on the side that
// grants no deletion, never on the side that grants one.
test('workspace declaration: a shape this reader declines is OPAQUE, never a claim', () => {
  const declined: readonly [label: string, declare: (dir: string) => void][] = [
    ['pnpm `packages:` holding a map instead of a list', (d) => declarePnpm(d, 'packages:\n  foo:\n    bar: 1\n')],
    ['pnpm item that is an unquoted YAML alias', (d) => declarePnpm(d, 'packages:\n  - *ref\n')],
    ['pnpm item that is an unquoted YAML tag (an unquoted `!` negation)', (d) => declarePnpm(d, 'packages:\n  - !packages/excluded\n')],
    ['a multi-document YAML file', (d) => declarePnpm(d, '---\npackages:\n  - "*"\n---\npackages:\n  - "packages/*"\n')],
    ['a duplicate top-level `packages:` key', (d) => declarePnpm(d, 'packages:\n  - "*"\npackages:\n  - "packages/*"\n')],
    ['tab-indented list items', (d) => declarePnpm(d, 'packages:\n\t- "*"\n')],
    ['`packages:` holding a bare scalar', (d) => declarePnpm(d, 'packages: apps\n')],
    ['a `-` with no value', (d) => declarePnpm(d, 'packages:\n  -\n')],
    ['an unterminated quote in a flow sequence', (d) => declarePnpm(d, 'packages: [\'apps/*\n')],
    ['a top-level line that is not a key', (d) => declarePnpm(d, 'packages:\n  - "*"\nnot a key at all\n')],
    ['a double-quoted scalar carrying an escape sequence', (d) => declarePnpm(d, 'packages:\n  - "apps\\\\*"\n')],
    ['an npm array holding a non-string entry', (d) => declarePkg(d, ['packages/*', { glob: 'apps/*' }])],
    ['an npm object form holding a non-string entry', (d) => declarePkg(d, { packages: [42] })],
    ['a brace-expansion pattern', (d) => declarePkg(d, ['{apps,packages}/*'])],
    ['a character-class pattern', (d) => declarePkg(d, ['packages/[a-z]*'])],
    ['an extglob pattern', (d) => declarePkg(d, ['packages/!(excluded)'])],
  ];

  for (const [label, declare] of declined) {
    withRoot((root) => {
      declare(root);
      assert.equal(readWorkspaceDeclaration(root).kind, 'opaque',
        `[${label}] must be declined as opaque — not silently read, and not mistaken for "no declaration"`);
      for (const rel of ['packages/ui', 'apps/web', 'anything']) {
        assert.equal(workspaceClaimsDescendant(root, path.join(root, rel)), false,
          `[${label}] an opaque declaration claims nothing`);
      }
    });
  }
});

// The vacuity trap for this row: `fs.existsSync` is false for a dangling
// symlink, so a dangling-link fixture would make the reader answer 'none' — "no
// declaration at all" — and the test would pass having proved the opposite of
// what it claims. A DIRECTORY named pnpm-workspace.yaml exists AND fails to
// read, and both halves are asserted.
test('workspace declaration: an UNREADABLE declaration file is opaque, and is still a declaration', () => {
  withRoot((root) => {
    write(path.join(root, 'package.json'), `${JSON.stringify({ name: 'container', private: true }, null, 2)}\n`);
    fs.mkdirSync(path.join(root, 'pnpm-workspace.yaml'), { recursive: true });

    assert.equal(fs.existsSync(path.join(root, 'pnpm-workspace.yaml')), true,
      'FIXTURE the declaration must EXIST, or this row measures the no-declaration path instead');
    assert.throws(() => fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
      'FIXTURE the declaration must be genuinely unreadable');

    const declaration = readWorkspaceDeclaration(root);
    assert.equal(declaration.kind, 'opaque',
      'unreadable is OPAQUE, not `none`: it still anchors resolution and it grants no deletion');
    assert.equal(workspaceClaimsDescendant(root, path.join(root, 'packages', 'ui')), false);
  });
});

// ── the two shapes the `catch` above could never see ─────────────────────────
// The row above plants a DIRECTORY, which throws immediately and therefore
// exercises the catch. A FIFO and a device node do not throw: they never
// return, so the catch that reports them "unreadable" is unreachable prose.
//
// DRIVEN AT THIS CALL SITE before the bound (one child per shape under a parent
// `spawnSync({timeout: 8000, killSignal: 'SIGKILL'})`, load 2.54 of 10 cpus): a
// FIFO killed at 8 012 ms, a symlink to `/dev/zero` killed at 8 057 ms, a
// regular file answering in 0 ms. After: both answer `opaque` in 0 ms.
//
// `pnpm-workspace.yaml` is a TRACKED path — git records a committed symlink as
// mode 120000 — so the hostile object arrives on an ordinary clone, with no
// local process, and hook/paths.ts:149 reaches this function on the resolver
// every hook entry runs. That is why these rows are worth a child process each.
//
// IN A CHILD, and killed with SIGKILL rather than spawnSync's default SIGTERM.
// A blocking open stops this runner's own timer with it and `npm test` passes
// no `--test-timeout`, so an in-process row would hang the WHOLE SUITE if the
// bound regressed. SIGTERM happens to interrupt `open(2)` on a FIFO on this
// platform; that is a platform assumption the row does not need, and a kill
// that fails leaves the same wedge these rows exist to prevent.
function declarationInChild(root: string, label: string): { kind: string; why?: string } {
  const driver = path.join(root, 'drive-declaration.cjs');
  fs.writeFileSync(driver, [
    'const mod = require(process.argv[2]);',
    'process.stdout.write(JSON.stringify(mod.readWorkspaceDeclaration(process.argv[3])));',
  ].join('\n'), 'utf8');

  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', driver, path.join(__dirname, '..', 'hook', 'workspace-declaration.ts'), root],
    { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' },
  );
  assert.equal(run.signal, null,
    `${label}: readWorkspaceDeclaration must RETURN rather than block on the open. Killed by signal means the `
    + `bound is gone, and this is the resolver every hook entry runs. stderr: ${run.stderr || ''}`);
  assert.equal(run.status, 0, `${label}: ${run.stderr || ''}`);
  return JSON.parse(run.stdout) as { kind: string; why?: string };
}

test('workspace declaration: a FIFO at pnpm-workspace.yaml is opaque in BOUNDED time — SIGKILLed at 8 012 ms before', () => {
  if (process.platform === 'win32') return;
  withRoot((root) => {
    write(path.join(root, 'package.json'), '{"name":"container","private":true}\n');
    const file = path.join(root, 'pnpm-workspace.yaml');
    try {
      execFileSync('mkfifo', [file], { stdio: 'ignore' });
    } catch {
      return; // no mkfifo: the shape is unreachable here, not unpinned
    }
    assert.equal(fs.lstatSync(file).isFIFO(), true, 'FIXTURE the planted entry must really be a FIFO');

    const declaration = declarationInChild(root, 'FIFO');
    assert.equal(declaration.kind, 'opaque',
      'presence, unopened — never `none`, which would mean the container declares nothing and hand the '
      + 'deletion side a licence it must not have');
    assert.match(declaration.why ?? '', /pnpm-workspace\.yaml is unreadable \(not-a-regular-file\)/,
      'and the reason NAMES the shape, so an operator can tell our refusal from the filesystem\'s');
    assert.equal(fs.lstatSync(file).isFIFO(), true, 'the FIFO survives the read that refused it');
  });
});

test('workspace declaration: a committed symlink to /dev/zero is opaque in BOUNDED time — SIGKILLed at 8 057 ms before', () => {
  if (process.platform === 'win32' || !fs.existsSync('/dev/zero')) return;
  withRoot((root) => {
    write(path.join(root, 'package.json'), '{"name":"container","private":true}\n');
    const file = path.join(root, 'pnpm-workspace.yaml');
    fs.symlinkSync('/dev/zero', file);
    assert.equal(fs.statSync(file).isCharacterDevice(), true,
      'FIXTURE the link must really resolve to a character device');

    const declaration = declarationInChild(root, '/dev/zero link');
    assert.equal(declaration.kind, 'opaque');
    assert.match(declaration.why ?? '', /not-a-regular-file/);
  });
});

test('workspace declaration: no declaration at all is `none`, which is a different fact from opaque', () => {
  withRoot((root) => {
    assert.equal(readWorkspaceDeclaration(root).kind, 'none', 'an empty directory declares nothing');
    write(path.join(root, 'package.json'), '{"name":"plain"}\n');
    assert.equal(readWorkspaceDeclaration(root).kind, 'none', 'a package.json with no workspaces key');
    declarePkg(root, []);
    assert.equal(readWorkspaceDeclaration(root).kind, 'none', 'an EMPTY workspaces array is not a declaration');
    declarePkg(root, { nohoist: [] });
    assert.equal(readWorkspaceDeclaration(root).kind, 'none', 'a workspaces object with no packages array');
    write(path.join(root, 'package.json'), '{ not json at all\n');
    assert.equal(readWorkspaceDeclaration(root).kind, 'none', 'a corrupt package.json declares nothing');
  });
});

test('workspace declaration: the opaque/none distinction is LATENT — no production consumer observes it', () => {
  // AN HONEST RECORD RATHER THAN A CLAIM, and the claim it replaces is in this
  // module's own type docblock, which called `opaque` "the load-bearing arm".
  //
  // The distinction is real at the type: `none` means nothing here declares a
  // workspace, `opaque` means something does but its member list could not be
  // established, and conflating them would either withdraw resolution from a
  // genuine workspace root or grant deletion authority on a list nobody could
  // read. But in the tree as it stands the ONLY production consumer is
  // `workspaceClaimsDescendant`, and it tests `kind !== 'patterns'` — which
  // folds the two arms together. Every behaviour anyone can observe today is
  // identical for both.
  //
  // So the fact is pinned in the direction that will actually catch something:
  // when a consumer DOES start distinguishing them, this row reds and whoever
  // wrote it has to come back and delete this note. That is a cheaper instrument
  // than a speculative consumer written to justify the arm, and it does not
  // pretend the distinction is currently observed.
  withRoot((root) => {
    const none = readWorkspaceDeclaration(root);
    assert.equal(none.kind, 'none', 'FIXTURE an empty directory');

    declarePkg(root, ['packages/[a-z]*']);
    const opaque = readWorkspaceDeclaration(root);
    assert.equal(opaque.kind, 'opaque', 'FIXTURE a declaration whose members cannot be established');

    const descendant = path.join(root, 'packages', 'ui');
    assert.equal(workspaceClaimsDescendant(root, descendant), false,
      'the only production consumer answers the same for both arms — if this line ever needs two different '
      + 'expectations, the distinction has stopped being latent and the type docblock must say so');
  });
});

// ── the guards, one named test each ──────────────────────────────────────────

test('workspace membership: a declaration that claims NO member grants no deletion authority', () => {
  withRoot((root) => {
    declarePkg(root, ['packages/*']);
    const member = onboardedProject(path.join(root, 'storefront-web'));
    assert.equal(fs.existsSync(path.join(root, 'packages')), false,
      'FIXTURE the glob must match nothing on disk');

    assert.equal(resolveProjectRoot(member), root,
      'resolution is deliberately UNCHANGED — the lenient anchor still climbs to the container');
    assert.equal(resolveProjectRoot(member, undefined, { workspaceAuthority: 'membership' }), member,
      'but under membership authority the member keeps its own root');
    assert.deepEqual(plannedLeaks(root), [], 'and the sweep plans nothing');
  });
});

// The packages/ui incident (hook/paths.ts:154-157). A monorepo has ONE root, so
// a stray mode-bearing state below the workspace root must not shadow it — and
// `packages/ui` IS matched by `packages/*`, which is exactly the discrimination
// that makes a membership rule a narrowing rather than a regression.
test('workspace membership: the packages/ui incident does not regress — a CLAIMED member is still swept', () => {
  withRoot((root) => {
    declarePkg(root, ['packages/*']);
    write(path.join(root, '.traffic-one', '.one.json'),
      `${JSON.stringify({ mode: 'new-project', onboardingComplete: true }, null, 2)}\n`);
    const ui = leftoverProject(path.join(root, 'packages', 'ui'));

    assert.equal(workspaceClaimsDescendant(root, ui), true, 'packages/* claims packages/ui');
    assert.equal(resolveProjectRoot(ui, undefined, { workspaceAuthority: 'membership' }), root,
      'a claimed member still climbs to the workspace root under the STRICTER authority');
    assert.deepEqual(plannedLeaks(root), [path.join('packages', 'ui', '.traffic-one')],
      'leftover debris inside a claimed member is still planned for deletion');
  });
});

test('workspace membership: an onboarded claimed member is a project, not debris', () => {
  withRoot((root) => {
    declarePkg(root, ['packages/*']);
    write(path.join(root, '.traffic-one', '.one.json'),
      `${JSON.stringify({ mode: 'new-project', onboardingComplete: true }, null, 2)}\n`);
    const ui = onboardedProject(path.join(root, 'packages', 'ui'));

    assert.equal(workspaceClaimsDescendant(root, ui), true, 'packages/* claims packages/ui');
    assert.equal(resolveProjectRoot(ui, undefined, { workspaceAuthority: 'membership' }), root,
      'resolution still climbs — the keep is evidence, not a new root');
    assert.deepEqual(plannedLeaks(root), [],
      'onboardingComplete is project evidence, so SessionStart does not delete it');
  });
});

test('workspace membership: a stray INSIDE a claimed member is claimed too', () => {
  withRoot((root) => {
    declarePkg(root, ['packages/*']);
    write(path.join(root, '.traffic-one', '.one.json'),
      `${JSON.stringify({ mode: 'new-project', onboardingComplete: true }, null, 2)}\n`);
    write(path.join(root, 'packages', 'ui', 'package.json'), '{"name":"ui"}\n');
    const sub = leftoverProject(path.join(root, 'packages', 'ui', 'sub'));

    assert.equal(workspaceClaimsDescendant(root, sub), true,
      'no pattern matches packages/ui/sub itself, but packages/* matches its ancestor packages/ui');
    assert.deepEqual(plannedLeaks(root), [path.join('packages', 'ui', 'sub', '.traffic-one')]);
  });
});

test('workspace membership: a NEGATED member is excluded from deletion authority', () => {
  withRoot((root) => {
    declarePkg(root, ['*', '!ledger-api']);
    write(path.join(root, '.traffic-one', '.one.json'),
      `${JSON.stringify({ mode: 'new-project', onboardingComplete: true }, null, 2)}\n`);
    const kept = leftoverProject(path.join(root, 'ledger-api'));
    leftoverProject(path.join(root, 'storefront-web'));

    assert.equal(workspaceClaimsDescendant(root, kept), false, 'the negation wins over the `*` that also matches');
    assert.deepEqual(plannedLeaks(root), [path.join('storefront-web', '.traffic-one')],
      'only the member the declaration still claims is swept');
  });
});

test('workspace membership: ONE unreadable pattern poisons the whole declaration', () => {
  withRoot((root) => {
    // `packages/*` alone would claim packages/ui. The unparseable sibling must
    // not be skipped: skipping an unreadable NEGATION is what would delete a
    // directory its author excluded, and the reader cannot tell which it is.
    declarePkg(root, ['packages/*', '{apps,libs}/*']);
    write(path.join(root, '.traffic-one', '.one.json'),
      `${JSON.stringify({ mode: 'new-project', onboardingComplete: true }, null, 2)}\n`);
    const ui = onboardedProject(path.join(root, 'packages', 'ui'));

    assert.equal(readWorkspaceDeclaration(root).kind, 'opaque');
    assert.equal(workspaceClaimsDescendant(root, ui), false);
    assert.deepEqual(plannedLeaks(root), []);
  });
});

// The other leak arm, by MEMBERSHIP rather than by workspace declaration
// (hook/paths.ts:159-173; observed as mercury/strategies inside a Go repo). It
// has nothing to do with a workspace declaration and must be untouched by this
// change — including when a declaration is present but claims nothing.
test('workspace membership: stray state inside a real repo is still a leak, declaration or not', () => {
  for (const declare of [null, (dir: string) => declarePkg(dir, ['packages/*'])] as const) {
    withRoot((root) => {
      write(path.join(root, 'go.mod'), 'module mercury\n\ngo 1.22\n');
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      write(path.join(root, '.traffic-one', '.one.json'),
        `${JSON.stringify({ mode: 'existing-codebase', onboardingComplete: true }, null, 2)}\n`);
      declare?.(root);
      const strategies = path.join(root, 'strategies');
      write(path.join(strategies, 'x.go'), 'package strategies\n');
      write(path.join(strategies, '.traffic-one', '.one.json'),
        `${JSON.stringify({ mode: 'new-project' }, null, 2)}\n`);

      assert.equal(resolveProjectRoot(strategies, undefined, { workspaceAuthority: 'membership' }), root,
        'a marker-less dir inside a repo belongs to the repo — no declaration is involved');
      assert.deepEqual(plannedLeaks(root), [path.join('strategies', '.traffic-one')],
        `the membership heal must survive (declaration present: ${Boolean(declare)})`);
    });
  }
});

// A NESTED workspace root inside a declared member is the one shape where the
// stricter authority could have come out STRICTER THAN the lenient one, which is
// the single direction this change is not allowed to move: `packages/ui` is
// claimed by the outer `packages/*`, so without the self-anchor arm in
// dirAnchorsWorkspaceFor it would stop being its own root under `membership`
// while remaining its own root under `declared` — an ADDED deletion. Nothing is
// onboarded here on purpose: that is what makes the walk reach the workspace
// anchor at all rather than settling on an onboarded ancestor first.
test('workspace membership: a member that is ITSELF a workspace root stays its own root', () => {
  withRoot((root) => {
    declarePkg(root, ['packages/*']);
    const ui = path.join(root, 'packages', 'ui');
    declarePnpm(ui, 'packages:\n  - "lib/*"\n');
    write(path.join(ui, '.traffic-one', '.one.json'), `${JSON.stringify({ 'one-uid': 'x' }, null, 2)}\n`);

    assert.equal(fs.existsSync(path.join(root, '.traffic-one')), false,
      'FIXTURE nothing may be onboarded, or the onboarded walk answers before the workspace anchor is reached');
    assert.equal(workspaceClaimsDescendant(root, ui), true,
      'FIXTURE the outer declaration DOES claim this member, which is what makes the row load-bearing');

    assert.equal(resolveProjectRoot(ui), ui, 'under the lenient authority it is its own workspace root');
    assert.equal(resolveProjectRoot(ui, undefined, { workspaceAuthority: 'membership' }), ui,
      'and the stricter authority must not be stricter HERE — that would add a deletion');
    assert.deepEqual(plannedLeaks(root), []);
  });
});

// ── what binds the strict half to the lenient half ───────────────────────────

// If a declaration can CLAIM a descendant, it must also be a declaration for the
// purposes of resolution. Were that ever false, the sweep could delete a
// directory the resolver never moves off its own root — a deletion with no
// resolution behind it at all. `isUnclaimedWorkspaceSubPackage` is the exported
// reader of `dirDeclaresWorkspace`, so it stands in for the private predicate.
test('workspace membership: a claim always implies a declaration (the two predicates cannot diverge)', () => {
  const shapes: readonly ((dir: string) => void)[] = [
    (d) => declarePkg(d, ['packages/*']),
    (d) => declarePkg(d, ['*']),
    (d) => declarePkg(d, ['**']),
    (d) => declarePkg(d, ['packages/ui']),
    (d) => declarePkg(d, ['packages/*', '!packages/ui']),
    (d) => declarePkg(d, { packages: ['packages/*'] }),
    (d) => declarePkg(d, { packages: [] }),
    (d) => declarePkg(d, []),
    (d) => declarePkg(d, ['{a,b}/*']),
    (d) => declarePnpm(d, 'packages:\n  - "packages/*"\n'),
    (d) => declarePnpm(d, 'packages:\n  foo: 1\n'),
    (d) => declarePnpm(d, ''),
    () => undefined,
  ];

  let claimed = 0;
  for (const shape of shapes) {
    withRoot((root) => {
      shape(root);
      const sub = path.join(root, 'packages', 'ui');
      fs.mkdirSync(sub, { recursive: true });
      const claims = workspaceClaimsDescendant(root, sub);
      if (claims) claimed += 1;
      if (!claims) return;
      assert.equal(isUnclaimedWorkspaceSubPackage(sub), true,
        'a declaration that CLAIMS a sub-package must also DECLARE for resolution');
    });
  }
  assert.ok(claimed >= 4, `the invariant must be exercised by real claims, not vacuously (claimed ${claimed})`);
});

// The resolution contract, stated as a test rather than as a comment: the
// default authority answers exactly what it answered before the split, for the
// shape where the two authorities disagree most.
test('workspace membership: the default authority is unchanged — resolution still climbs onto a non-claiming container', () => {
  withRoot((root) => {
    declarePkg(root, ['packages/*']);
    const member = onboardedProject(path.join(root, 'ledger-api'));
    const orphan = path.join(root, 'apps', 'web');
    fs.mkdirSync(orphan, { recursive: true });

    assert.equal(resolveProjectRoot(member), root,
      'an onboarded member still climbs past its own state to a container that declares anything');
    assert.equal(resolveProjectRoot(orphan), root,
      'and a marker-less sub-package still anchors at the container mid-onboarding');
    assert.equal(isUnclaimedWorkspaceSubPackage(orphan), true,
      'the write-side backstop still refuses to mint state into it');
  });
});
