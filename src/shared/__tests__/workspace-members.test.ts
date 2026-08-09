// The Traffic One WORKSPACE PROJECT: `mode: 'workspace'` plus a validated
// registry of member directories, and the predicate that reads it.
//
// Three properties, and the tests below are grouped by which one they pin:
//
//   1. THE REGISTRY IS UNTRUSTED DATA. `.one.json` is a file an agent's Write
//      tool reaches, so every arm of the read — absent, corrupt, unreadable, a
//      legible non-workspace, a malformed entry — has to land somewhere
//      deliberate, and `absent` and `corrupt` must not land in the same place.
//   2. THE DEFAULT PATH IS UNCHANGED. Nothing in the tree carries this mode, so
//      every resolution answer must be byte-identical to what it was — and
//      identical BY CONSTRUCTION, which is why the first comparison the reader
//      makes is against `mode` and why nothing below it opens a file.
//   3. THE REDIRECT ONLY EVER MOVES DOWNWARD. shared/retention.ts deletes a
//      nested `.traffic-one` when `resolveProjectRoot(dir) !== dir`, so a change
//      that could move a self-resolution off itself would be a data-loss change.
//
// Every test here is named in the mutation table in the lane report: each one is
// the test that goes red when one specific guard is neutered on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  WORKSPACE_PROJECT_MODE,
  isRegisteredWorkspaceMember,
  readWorkspaceMemberRegistry,
  resolveProjectRoot,
  workspaceMembershipOf,
} from '../hook/paths';
import { enclosingRegisteredMember, workspaceMemberRegistryOf } from '../hook/workspace-members';
import { withProjectStateLock } from '../state/project-state-lock';
import { writeWorkspaceMemberRegistry } from '../state/workspace-members';
import { sweepTrafficOneRetention } from '../retention';

const TMP_PREFIX = 't1-wsmembers-';

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

function writeStateFile(dir: string, state: unknown): void {
  write(path.join(dir, '.traffic-one', '.one.json'), `${JSON.stringify(state, null, 2)}\n`);
}

/** A container onboarded as a workspace, registering `members` by relative path. */
function workspaceRoot(dir: string, members: readonly string[]): string {
  writeStateFile(dir, {
    mode: WORKSPACE_PROJECT_MODE,
    onboardingComplete: true,
    workspaceMembers: members.map((member) => ({ path: member })),
  });
  return dir;
}

/** A member directory: a manifest, a nested source file, and NO version control. */
function memberDir(container: string, id: string): string {
  const dir = path.join(container, id);
  write(path.join(dir, 'package.json'), `${JSON.stringify({ name: id }, null, 2)}\n`);
  write(path.join(dir, 'src', 'main.ts'), 'export const boot = (): number => 0;\n');
  return dir;
}

/** What the SessionStart sweep would delete, relative to `container`. */
function plannedLeaks(container: string): string[] {
  return sweepTrafficOneRetention(container, { dryRun: true }).actions
    .filter((action) => action.reason.includes('leaked nested'))
    .map((action) => path.relative(container, action.path))
    .sort();
}

// ── 1. the registry is untrusted data ────────────────────────────────────────

test('workspace members: every state-file shape lands on a named arm, and absent is not corrupt', () => {
  const cases: readonly [label: string, plant: (dir: string) => void, kind: string, members?: readonly string[]][] = [
    ['no state file at all', () => { /* nothing */ }, 'none'],
    ['a legible new-project state', (d) => writeStateFile(d, { mode: 'new-project' }), 'none'],
    ['a legible existing-codebase state', (d) => writeStateFile(d, { mode: 'existing-codebase' }), 'none'],
    ['a legible existing-with-supabase state', (d) => writeStateFile(d, { mode: 'existing-with-supabase' }), 'none'],
    ['a state file holding a JSON array', (d) => write(path.join(d, '.traffic-one', '.one.json'), '[1,2]\n'), 'none'],
    ['bytes that are not JSON', (d) => write(path.join(d, '.traffic-one', '.one.json'), '{ mode: broken\n'), 'illegible'],
    ['an empty state file', (d) => write(path.join(d, '.traffic-one', '.one.json'), ''), 'illegible'],
    ['workspace mode with no registry key', (d) => writeStateFile(d, { mode: WORKSPACE_PROJECT_MODE }), 'members', []],
    ['workspace mode with an explicitly empty registry', (d) => writeStateFile(d, { mode: WORKSPACE_PROJECT_MODE, workspaceMembers: [] }), 'members', []],
    ['workspace mode with two members', (d) => workspaceRoot(d, ['a', 'nested/b']), 'members', ['a', 'nested/b']],
    ['a registry that is not an array', (d) => writeStateFile(d, { mode: WORKSPACE_PROJECT_MODE, workspaceMembers: { a: true } }), 'opaque'],
    ['a registry holding a bare string', (d) => writeStateFile(d, { mode: WORKSPACE_PROJECT_MODE, workspaceMembers: ['a'] }), 'opaque'],
    ['a registry entry with no path', (d) => writeStateFile(d, { mode: WORKSPACE_PROJECT_MODE, workspaceMembers: [{ id: 'a' }] }), 'opaque'],
    ['a registry entry whose path is absolute', (d) => workspaceRoot(d, ['/etc']), 'opaque'],
    // The Windows half of the same rule, and the only half the empty-segment
    // check below it does NOT already catch: `C:/Users/x` splits into three
    // perfectly well-formed segments.
    ['a registry entry carrying a Windows drive letter', (d) => workspaceRoot(d, ['C:\\Users\\x']), 'opaque'],
    ['a registry entry that escapes the root', (d) => workspaceRoot(d, ['../sibling']), 'opaque'],
    ['a registry entry that is a glob', (d) => workspaceRoot(d, ['packages/*']), 'opaque'],
    ['a registry entry carrying a brace expansion', (d) => workspaceRoot(d, ['packages/{a,b}']), 'opaque'],
    ['ONE bad entry among good ones poisons the list', (d) => workspaceRoot(d, ['a', 'packages/*', 'b']), 'opaque'],
    ['a member path with a tolerated trailing slash', (d) => workspaceRoot(d, ['apps/web/']), 'members', ['apps/web']],
    ['a member path with a tolerated ./ prefix', (d) => workspaceRoot(d, ['./apps/web']), 'members', ['apps/web']],
    ['an entry carrying unknown extra fields is still valid', (d) => writeStateFile(d, { mode: WORKSPACE_PROJECT_MODE, workspaceMembers: [{ path: 'a', futureField: 7 }] }), 'members', ['a']],
  ];

  for (const [label, plant, kind, members] of cases) {
    withRoot((root) => {
      const dir = path.join(root, 'ws');
      fs.mkdirSync(dir, { recursive: true });
      plant(dir);
      const registry = readWorkspaceMemberRegistry(dir);
      assert.equal(registry.kind, kind, `${label}: expected ${kind}, got ${JSON.stringify(registry)}`);
      if (members) {
        assert.deepEqual(registry.kind === 'members' ? registry.members : null, members, `${label}: member list`);
      }
    });
  }
});

// The one distinction readJson's fallback structurally cannot make, asserted as
// an inequality rather than inferred from the table above — a table can pass
// while two rows quietly share an arm.
test('workspace members: an unreadable state file is illegible, and NOT the same answer as no state file', () => {
  withRoot((root) => {
    const absent = path.join(root, 'absent');
    fs.mkdirSync(absent, { recursive: true });
    assert.equal(readWorkspaceMemberRegistry(absent).kind, 'none');

    const blocked = path.join(root, 'blocked');
    // EISDIR: `.one.json` is a DIRECTORY. Reproducible as an unprivileged user
    // on every platform the hooks run on, unlike a chmod-based EACCES, which
    // root ignores.
    fs.mkdirSync(path.join(blocked, '.traffic-one', '.one.json'), { recursive: true });
    const unreadable = readWorkspaceMemberRegistry(blocked);
    assert.equal(unreadable.kind, 'illegible',
      'a state file that cannot be read must never answer "this is not a workspace"');
    assert.notEqual(unreadable.kind, readWorkspaceMemberRegistry(absent).kind,
      'absent and unreadable are different facts and must not share an arm');
  });
});

test('workspace members: a registry entry is a DIRECTORY, never a pattern — this is not workspaceClaimsDescendant', () => {
  withRoot((root) => {
    const ws = workspaceRoot(path.join(root, 'ws'), ['packages/*']);
    fs.mkdirSync(path.join(ws, 'packages', 'ui'), { recursive: true });
    const registry = readWorkspaceMemberRegistry(ws);
    assert.equal(registry.kind, 'opaque',
      'a `*` in a registry is a malformed entry; reading it as a wildcard would widen an authorization'
      + ' the author wrote as a literal');
    assert.equal(isRegisteredWorkspaceMember(path.join(ws, 'packages', 'ui')), false,
      'the glob that would have matched under a declaration reader grants nothing here');

    // …and the literal form of the same intent DOES register it, so the row
    // above is about the syntax and not about the path.
    workspaceRoot(ws, ['packages/ui']);
    assert.equal(isRegisteredWorkspaceMember(path.join(ws, 'packages', 'ui')), true);
  });
});

// ── the predicate ────────────────────────────────────────────────────────────

test('workspace members: isRegisteredWorkspaceMember is EXACT, while the resolver redirect is ancestor-or-self', () => {
  withRoot((root) => {
    const ws = workspaceRoot(path.join(root, 'ws'), ['storefront']);
    const member = memberDir(ws, 'storefront');
    const nested = path.join(member, 'src');

    assert.equal(isRegisteredWorkspaceMember(member), true, 'the member itself');
    assert.equal(isRegisteredWorkspaceMember(nested), false,
      'a directory INSIDE a member is not itself a member — the predicate answers about this directory');
    assert.equal(isRegisteredWorkspaceMember(ws), false, 'a workspace is never its own member');
    assert.equal(isRegisteredWorkspaceMember(path.join(ws, 'unregistered')), false);

    // The resolver asks the other question of the same registry and gets the
    // other answer, which is the whole reason both exist.
    assert.equal(resolveProjectRoot(nested), member,
      'a nested source dir resolves to the member that encloses it');
  });
});

test('workspace members: the deepest registered member wins over a shallower one', () => {
  withRoot((root) => {
    const ws = workspaceRoot(path.join(root, 'ws'), ['apps', 'apps/web']);
    const inner = path.join(ws, 'apps', 'web', 'src');
    fs.mkdirSync(inner, { recursive: true });
    assert.equal(resolveProjectRoot(inner), path.join(ws, 'apps', 'web'),
      'a file under apps/web belongs to apps/web, not to apps');
    assert.equal(isRegisteredWorkspaceMember(path.join(ws, 'apps')), true);
    assert.equal(isRegisteredWorkspaceMember(path.join(ws, 'apps', 'web')), true);
  });
});

test('workspace members: an illegible ancestor is INDETERMINATE, and the boolean folds it to false', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    const member = memberDir(ws, 'storefront');
    write(path.join(ws, '.traffic-one', '.one.json'), '{ "mode": "workspace"\n');

    const verdict = workspaceMembershipOf(member);
    assert.equal(verdict.kind, 'indeterminate',
      'a torn container state must not be reported as "this directory is not a member"');
    assert.equal(isRegisteredWorkspaceMember(member), false,
      'the boolean grants nothing on an answer nobody established');

    // The same shape, legible: the difference is a finding, not noise.
    workspaceRoot(ws, ['storefront']);
    assert.equal(workspaceMembershipOf(member).kind, 'member');
    assert.equal(workspaceMembershipOf(path.join(ws, 'other')).kind, 'not-member',
      'a legible registry that does not list you is a POSITIVE negative');
  });
});

test('workspace members: a malformed registry is indeterminate too, not a clean negative', () => {
  withRoot((root) => {
    const ws = workspaceRoot(path.join(root, 'ws'), ['storefront', 'packages/*']);
    const member = memberDir(ws, 'storefront');
    assert.equal(workspaceMembershipOf(member).kind, 'indeterminate',
      'one unreadable entry poisons the list, so even the entry that DID parse grants nothing');
    assert.equal(isRegisteredWorkspaceMember(member), false);
  });
});

test('workspace members: the NEAREST workspace owns the question', () => {
  withRoot((root) => {
    const outer = workspaceRoot(path.join(root, 'outer'), ['inner/member']);
    const inner = workspaceRoot(path.join(outer, 'inner'), []);
    const member = memberDir(inner, 'member');
    assert.equal(workspaceMembershipOf(member).kind, 'not-member',
      'the inner workspace registers nobody, and a farther workspace does not overrule it');
    assert.equal(readWorkspaceMemberRegistry(inner).kind, 'members', 'fixture: the inner workspace is legible');
  });
});

test('workspace members: the predicate takes no lock and writes nothing', () => {
  withRoot((root) => {
    const ws = workspaceRoot(path.join(root, 'ws'), ['storefront']);
    const member = memberDir(ws, 'storefront');
    const before = fs.readdirSync(path.join(ws, '.traffic-one')).sort();

    let answeredUnderLock: boolean | null = null;
    withProjectStateLock(ws, () => {
      answeredUnderLock = isRegisteredWorkspaceMember(member);
    });
    assert.equal(answeredUnderLock, true,
      'it must be askable from inside a lock body, so a gate can consult it without deadlocking');
    assert.deepEqual(fs.readdirSync(path.join(ws, '.traffic-one')).sort(), before,
      'the predicate leaves nothing behind, including no lock dir');
    assert.equal(fs.existsSync(path.join(member, '.traffic-one')), false,
      'and mints no state into the member it was asked about');
  });
});

// ── 2. the default path is unchanged ─────────────────────────────────────────

test('workspace members: a tree with no workspace mode resolves exactly as it did', () => {
  // Each row is a shape the resolver already had an answer for. The registry
  // reader's FIRST comparison is against `mode`, so none of these can reach it —
  // this row is the measurement that says so rather than the claim.
  withRoot((root) => {
    const shapes: readonly [label: string, build: (dir: string) => void, ask: (dir: string) => string, want: (dir: string) => string][] = [
      [
        'a standalone onboarded project',
        (d) => { writeStateFile(d, { mode: 'new-project' }); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); },
        (d) => resolveProjectRoot(d),
        (d) => d,
      ],
      [
        'a nested source dir inside a git repo',
        (d) => { fs.mkdirSync(path.join(d, '.git'), { recursive: true }); write(path.join(d, 'src', 'a.ts'), 'export const a = 1;\n'); },
        (d) => resolveProjectRoot(path.join(d, 'src')),
        (d) => d,
      ],
      [
        'an npm monorepo sub-package with stray state',
        (d) => {
          write(path.join(d, 'package.json'), `${JSON.stringify({ private: true, workspaces: ['packages/*'] })}\n`);
          writeStateFile(d, { mode: 'new-project' });
          writeStateFile(path.join(d, 'packages', 'ui'), { mode: 'new-project' });
        },
        (d) => resolveProjectRoot(path.join(d, 'packages', 'ui')),
        (d) => d,
      ],
      [
        'a container with a mode-bearing state and no declaration',
        (d) => { writeStateFile(d, { mode: 'existing-codebase' }); memberDir(d, 'child'); },
        (d) => resolveProjectRoot(path.join(d, 'child', 'src')),
        (d) => d,
      ],
      [
        'a container whose state is a legible NON-workspace with a registry key present',
        (d) => {
          writeStateFile(d, { mode: 'existing-codebase', workspaceMembers: [{ path: 'child' }] });
          memberDir(d, 'child');
        },
        (d) => resolveProjectRoot(path.join(d, 'child', 'src')),
        (d) => d,
      ],
      [
        'a container whose state is TORN',
        (d) => { write(path.join(d, '.traffic-one', '.one.json'), 'not json'); memberDir(d, 'child'); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); },
        (d) => resolveProjectRoot(path.join(d, 'child', 'src')),
        (d) => d,
      ],
    ];

    for (const [label, build, ask, want] of shapes) {
      const dir = path.join(root, label.replace(/[^a-z]+/gi, '-'));
      fs.mkdirSync(dir, { recursive: true });
      build(dir);
      assert.equal(ask(dir), want(dir), label);
    }
  });
});

// The by-construction half, stated as an assertion rather than as prose: the
// registry reader is handed the exact state shapes that exist in the wild today
// and answers `none` for every one of them, so nothing below the `mode`
// comparison is reachable on the default path.
test('workspace members: every mode value that exists today short-circuits the registry reader', () => {
  for (const mode of ['new-project', 'existing-codebase', 'existing-with-supabase', '', 'Workspace', 'workspaces']) {
    const registry = workspaceMemberRegistryOf({ mode, workspaceMembers: [{ path: 'child' }] });
    assert.equal(registry.kind, 'none', `mode ${JSON.stringify(mode)} must not reach the registry`);
    assert.equal(enclosingRegisteredMember('/ws', registry, '/ws/child'), null,
      `mode ${JSON.stringify(mode)} must grant no member`);
  }
  assert.equal(workspaceMemberRegistryOf({ mode: WORKSPACE_PROJECT_MODE, workspaceMembers: [{ path: 'child' }] }).kind,
    'members', 'control: the one value that DOES reach it');
});

// ── 3. the redirect only ever moves downward ─────────────────────────────────

test('workspace members: pre-onboarding, a registered member no longer needs version control to anchor', () => {
  // The behaviour the polyglot instrument recorded as a gap: with no `.git` in a
  // member and nothing onboarded in it, a container-level cwd adopted the
  // CONTAINER — at exactly the moment onboarding is offered.
  withRoot((root) => {
    const plain = path.join(root, 'plain');
    const plainMember = memberDir(plain, 'storefront');
    writeStateFile(plain, { mode: 'existing-codebase' });
    assert.equal(resolveProjectRoot(plain, path.join(plainMember, 'src', 'main.ts')), plain,
      'baseline: without a workspace mode the container is still adopted');
    assert.equal(resolveProjectRoot(path.join(plainMember, 'src')), plain,
      'baseline: and a marker-less source dir climbs to it too');

    const ws = path.join(root, 'ws');
    const member = memberDir(ws, 'storefront');
    workspaceRoot(ws, ['storefront']);
    assert.equal(fs.existsSync(path.join(member, '.git')), false, 'FIXTURE the member owns no version control');
    assert.equal(fs.existsSync(path.join(member, '.traffic-one')), false, 'FIXTURE the member is not onboarded');
    assert.equal(resolveProjectRoot(ws, path.join(member, 'src', 'main.ts')), member,
      'a container-level cwd with a file hint into a REGISTERED member resolves to the member');
    assert.equal(resolveProjectRoot(path.join(member, 'src')), member,
      'and so does a cwd in the member’s marker-less source dir');
    assert.equal(resolveProjectRoot(ws), ws, 'the workspace itself still resolves to itself');
  });
});

test('workspace members: the redirect can never turn a self-resolution into a deletion candidate', () => {
  withRoot((root) => {
    // The shape that would be dangerous if the redirect could fire at level 0:
    // a registered member holding state of its own, inside a container that ALSO
    // declares an npm workspace claiming it. Before the registry, resolution
    // climbed to the container and the member's `.traffic-one` differed from its
    // own directory.
    const ws = path.join(root, 'ws');
    write(path.join(ws, 'package.json'), `${JSON.stringify({ private: true, workspaces: ['storefront'] }, null, 2)}\n`);
    const member = memberDir(ws, 'storefront');
    writeStateFile(member, { mode: 'existing-codebase', onboardingComplete: true });
    workspaceRoot(ws, ['storefront']);

    assert.equal(resolveProjectRoot(member), member,
      'a registered member is its own root even under a container that declares npm workspaces over it');
    assert.equal(
      resolveProjectRoot(member, undefined, { workspaceAuthority: 'membership' }), member,
      'and the DELETION consumer asks the same question and gets the same answer',
    );
    assert.deepEqual(plannedLeaks(ws), [],
      'the SessionStart sweep must plan no deletion for a member the workspace registered');

    // A stray inside the member is still the member's leak, exactly as a stray
    // inside a declared npm package is: the redirect lands on the enclosing
    // member, which differs from the stray's own directory.
    const stray = path.join(member, 'sub');
    writeStateFile(stray, { mode: 'new-project' });
    assert.equal(resolveProjectRoot(stray), member,
      'a stray below a registered member resolves to the member, not to the workspace');
    assert.deepEqual(plannedLeaks(ws), [path.join('storefront', 'sub', '.traffic-one')],
      'so it is still reported as a leak, and reported against the member');
  });
});

// ── the write path ───────────────────────────────────────────────────────────

test('workspace members: the registry round-trips through the fsjson chokepoint', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    const member = memberDir(ws, 'storefront');

    const written = writeWorkspaceMemberRegistry(ws, [member, 'nested/etl']);
    assert.equal(written.outcome, 'written', JSON.stringify(written));
    assert.deepEqual(written.outcome === 'written' ? written.members : null, ['storefront', 'nested/etl'],
      'an absolute member dir and a relative one both land as relative entries');

    const registry = readWorkspaceMemberRegistry(ws);
    assert.deepEqual(registry.kind === 'members' ? registry.members : registry, ['storefront', 'nested/etl'],
      'what the writer published is what the reader reads back');
    assert.equal(isRegisteredWorkspaceMember(member), true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(ws, '.traffic-one', '.one.json'), 'utf8')).mode,
      WORKSPACE_PROJECT_MODE,
      'the mode and the members are published together, so the file never means only one of them',
    );
  });
});

test('workspace members: a refused write is reported as refused, never as written', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    memberDir(ws, 'storefront');
    // A torn `.one.json`: patchState refuses rather than replacing bytes it
    // could not read, so the boolean this function consumes is false.
    write(path.join(ws, '.traffic-one', '.one.json'), '{ "mode": "existing-codebase"\n');

    const outcome = writeWorkspaceMemberRegistry(ws, ['storefront']);
    assert.equal(outcome.outcome, 'refused',
      'minting a written-shaped result over a write the fence refused is the defect refusal-contract ratchets');
    assert.equal(fs.readFileSync(path.join(ws, '.traffic-one', '.one.json'), 'utf8'), '{ "mode": "existing-codebase"\n',
      'and the bytes it could not read are still there');
    assert.equal(isRegisteredWorkspaceMember(path.join(ws, 'storefront')), false,
      'nothing was registered, and the predicate says so');
  });
});

test('workspace members: a member outside the workspace is rejected before any write happens', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    // The `why` is asserted, not just the outcome: "this is not inside the
    // workspace" and "this is not a shape the reader accepts" are different
    // things to tell a caller, and a containment failure reported as a syntax
    // failure sends whoever reads it looking at the wrong thing.
    const cases: readonly [bad: string, why: RegExp][] = [
      [path.join(root, 'sibling'), /is not inside/],
      ['../sibling', /is not inside/],
      ['/etc', /is not inside/],
      ['.', /is not inside/],
      ['packages/*', /is not a member path/],
      ['', /is not a directory/],
    ];
    for (const [bad, why] of cases) {
      const outcome = writeWorkspaceMemberRegistry(ws, ['storefront', bad]);
      assert.equal(outcome.outcome, 'rejected', `${JSON.stringify(bad)} must be rejected, got ${JSON.stringify(outcome)}`);
      assert.match(outcome.outcome === 'rejected' ? outcome.why : '', why,
        `${JSON.stringify(bad)}: the rejection must name the reason it actually failed`);
    }
    assert.equal(fs.existsSync(path.join(ws, '.traffic-one', '.one.json')), false,
      'all-or-nothing: a rejected member leaves no half-written registry behind');
  });
});

// ── spelling ─────────────────────────────────────────────────────────────────

test('workspace members: a member reached through a symlinked workspace still equals itself', () => {
  withRoot((root) => {
    const real = path.join(root, 'real');
    const ws = path.join(real, 'ws');
    const member = memberDir(ws, 'storefront');
    workspaceRoot(ws, ['storefront']);
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link);

    const aliased = path.join(link, 'ws', 'storefront');
    assert.notEqual(aliased, fs.realpathSync(aliased), 'FIXTURE the alias must not be canonical');
    assert.equal(resolveProjectRoot(path.join(aliased, 'src')), aliased,
      'the redirect joins onto the caller’s own spelling — an exit that canonicalized here would answer the'
      + ' /real spelling, and shared/retention.ts compares BY STRING, so every member of a symlinked'
      + ' workspace would become a deletion candidate');
    assert.equal(fs.realpathSync(aliased), member, 'FIXTURE both spellings reach one directory');
  });
});
