// The Traffic One WORKSPACE PROJECT: `mode: 'workspace'` plus a validated
// registry of member directories, and the predicate that reads it.
//
// Three properties, and the tests below are grouped by which one they pin:
//
//   1. THE REGISTRY IS UNTRUSTED DATA. `.one.json` is a file an agent's Write
//      tool reaches, so every arm of the read — absent, corrupt, unreadable, a
//      legible non-workspace, a malformed entry — has to land somewhere
//      deliberate, and `absent` and `corrupt` must not land in the same place.
//   2. THE MODE-KEYED PATH IS UNCHANGED, which is narrower than the claim this
//      line used to make and is the only version of it that is true. A project
//      whose `.one.json` is LEGIBLE and carries any of the three incumbent modes
//      resolves byte-identically to what it did, BY CONSTRUCTION: the first
//      comparison the registry reader makes is against `mode` and nothing below
//      it opens a file.
//
//      "The default path is unchanged, nothing in the tree carries this mode"
//      was the old wording and it is FALSE. `readWorkspaceMemberRegistry`
//      classifies ILLEGIBILITY before it looks at the mode, so an ancestor whose
//      state file cannot be parsed — a git merge conflict is the routine
//      trigger — answers `indeterminate` whether or not it is a workspace, and
//      `nearestOnboardedRoot`'s `indeterminate` disjunct then shelters every
//      state-bearing directory beneath it from the leaked-root sweep. Measured:
//      a stray under a legible ordinary parent is reported, the same stray under
//      a conflicted one is not. That population carries no `mode` at all, which
//      is exactly why "nothing carries this mode" did not bound it.
//   3. THE REDIRECT NEVER MOVES A ROOT UPWARD. shared/retention.ts deletes a
//      nested `.traffic-one` when `resolveProjectRoot(dir) !== dir`, so a change
//      that could move a self-resolution off itself would be a data-loss change.
//      Stated as a bound on the DIRECTION rather than as "only ever moves
//      downward", because the file's behaviour now includes an arm that moves
//      nothing and WITHHOLDS an upward move somebody else would have made — the
//      `indeterminate` shelter above, which keeps a directory resolving to
//      itself. Both are the same safe direction; only the second is a move.
//
// THE MUTATION TABLE IN THE LANE REPORT NAMES MOST OF THESE TESTS, not all of
// them: each named one is the test that goes red when one specific guard is
// neutered on its own. Three rows here were added after that table was written
// (the illegible-ancestor shelter and its legible control, and the opaque
// container's freeze) and are pinned by measurement rather than by a mutant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';

import {
  WORKSPACE_PROJECT_MODE,
  isRegisteredWorkspaceMember,
  readWorkspaceMemberRegistry,
  resolveProjectRoot,
  resolveProjectRootDetailed,
  workspaceMembershipOf,
} from '../hook/paths';
import {
  dedupeMemberDirectories,
  deriveMemberIdBase,
  deriveMemberIdDisambiguated,
  enclosingRegisteredMember,
  isVendorDirName,
  memberGitOwnership,
  memberPathVerdict,
  validateMemberPath,
  workspaceMemberRegistryOf,
  type WorkspaceMemberIdentity,
} from '../hook/workspace-members';
import { withProjectStateLock } from '../state/project-state-lock';
import {
  WORKSPACE_MEMBER_GITIGNORE_BODY,
  memberGitignorePlan,
  writeWorkspaceMemberRegistry,
} from '../state/workspace-members';
import { sweepTrafficOneRetention } from '../retention';
import { SKIP_DIRS } from '../../config/reporting';
import { TRAFFIC_ONE_BLOCK_BODY } from '../architecture-contract/scaffold-content';
// The tree's declared "is this a safe path segment" predicate. Imported HERE, in
// the test, rather than being restated as a pattern the production derivation
// would have to keep in step with: every id this module can mint is run through
// the real authority below, so a tightening there reddens this file instead of
// silently letting a member id become an unusable directory name.
import { isSafeRunId } from '../qa-report/schema';

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

// ── 4. member identity ───────────────────────────────────────────────────────
//
// The P4 identity block: a stable id per member, an opt-out that records a
// decision without inventing an authority, vendor directories that can never be
// members, git ownership, and the ignore region that follows from it.
//
// Every fixture below states its own preconditions BEFORE the verdict it
// supports, the way test-environment/core/polyglot-workspace.ts's
// `polyglotPreconditions` does — a builder that quietly stops being what it
// claims must fail as a FIXTURE error naming what changed, never pass
// vacuously. The helper is local rather than imported so this file's fixtures
// never depend on a harness module's shape.

type Precondition = readonly [label: string, actual: () => unknown, expected: unknown];

function assertFixture(name: string, checks: readonly Precondition[]): void {
  for (const [label, actual, expected] of checks) {
    let value: unknown;
    try {
      value = actual();
    } catch (error) {
      assert.fail(`FIXTURE ${name}: ${label} threw ${String(error)}`);
    }
    assert.deepEqual(value, expected,
      `FIXTURE ${name}: ${label} (got ${JSON.stringify(value)}, want ${JSON.stringify(expected)})`);
  }
}

/** The registry as `workspaceMemberRegistryOf` sees it, for a list of raw entries. */
function registryOf(entries: readonly unknown[]) {
  return workspaceMemberRegistryOf({ mode: WORKSPACE_PROJECT_MODE, workspaceMembers: entries });
}

function identitiesOf(entries: readonly unknown[]): readonly WorkspaceMemberIdentity[] {
  const registry = registryOf(entries);
  assert.equal(registry.kind, 'members', `expected a legible registry, got ${JSON.stringify(registry)}`);
  return registry.kind === 'members' ? registry.identities : [];
}

// ── (a) derivation and collision ─────────────────────────────────────────────

test('member id: the NAIVE derivation collides, demonstrably — and the resolver detects it instead of overwriting', () => {
  // The collision is CONSTRUCTED and shown, not argued: two members whose last
  // path segment is the same word, which is the ordinary shape of a monorepo
  // holding a web app and a web service.
  assertFixture('two members that share a last segment', [
    ['both derive the same naive base', () => deriveMemberIdBase('apps/web') === deriveMemberIdBase('services/web'), true],
    ['and that base is the readable word, not a hash', () => deriveMemberIdBase('apps/web'), 'web'],
    ['the two paths are genuinely different members', () => new Set(['apps/web', 'services/web']).size, 2],
  ]);

  const identities = identitiesOf([{ path: 'apps/web' }, { path: 'services/web' }, { path: 'apps/docs' }]);
  const byPath = new Map(identities.map((identity) => [identity.path, identity]));
  const web = byPath.get('apps/web')!;
  const service = byPath.get('services/web')!;
  const docs = byPath.get('apps/docs')!;

  assert.notEqual(web.id, service.id,
    'two members whose naive derivation coincides must not end up sharing one id — a shared id is a shared run'
    + ' directory and a shared join key, so one member’s evidence would be attributed to the other');
  assert.equal(web.origin, 'disambiguated');
  assert.equal(service.origin, 'disambiguated');
  assert.equal(docs.origin, 'derived',
    'a member whose base is unique keeps the readable id — disambiguation is not applied to the whole list');
  assert.equal(docs.id, 'docs');
  assert.equal(web.id, deriveMemberIdDisambiguated('apps/web'),
    'the disambiguated form is a pure function of the member path, so it is reproducible outside the resolver');
});

test('member id: disambiguation does not depend on the ORDER the registry happens to list members in', () => {
  const forward = identitiesOf([{ path: 'apps/web' }, { path: 'services/web' }]);
  const reversed = identitiesOf([{ path: 'services/web' }, { path: 'apps/web' }]);
  const idFor = (list: readonly WorkspaceMemberIdentity[], p: string) => list.find((i) => i.path === p)?.id;

  assert.equal(idFor(forward, 'apps/web'), idFor(reversed, 'apps/web'),
    'a first-one-keeps-the-base rule would make identity depend on how the array was serialised, so reordering'
    + ' the registry would silently re-id a member');
  assert.equal(idFor(forward, 'services/web'), idFor(reversed, 'services/web'));
});

test('member id: a SECOND-ORDER collision — a directory named like a disambiguated id — is reported, never merged', () => {
  // Constructed rather than hypothesised: the third member's directory name IS
  // the id the first two collide into, computed here from the derivation itself.
  const stolen = deriveMemberIdDisambiguated('apps/web');
  assertFixture('a directory whose own name is another member’s disambiguated id', [
    ['the stolen name is what apps/web disambiguates to', () => stolen, deriveMemberIdDisambiguated('apps/web')],
    ['it is a legal single-segment member path', () => memberPathVerdict(stolen).ok, true],
    ['and its own naive base is itself, so it does not disambiguate', () => deriveMemberIdBase(stolen), stolen],
  ]);

  const registry = registryOf([{ path: 'apps/web' }, { path: 'services/web' }, { path: stolen }]);
  assert.equal(registry.kind, 'opaque',
    'a residual id collision must poison the registry rather than let two members share an identity');
  const why = registry.kind === 'opaque' ? registry.why : '';
  assert.match(why, /both resolve to the id/, 'the refusal names the condition');
  assert.match(why, new RegExp(stolen.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')), 'and names the id they collided on');
  assert.match(why, /apps\/web/, 'and names a colliding member');
});

test('member id: two entries DECLARING the same id are a named collision, not a last-write-wins overwrite', () => {
  const registry = registryOf([{ path: 'apps/web', id: 'shared' }, { path: 'services/api', id: 'shared' }]);
  assert.equal(registry.kind, 'opaque');
  assert.match(registry.kind === 'opaque' ? registry.why : '', /apps\/web and services\/api both resolve to the id "shared"/,
    'the refusal names both members and the id, because a caller cannot fix a collision it cannot see');
});

test('member id: a DECLARED id overrides derivation, and survives the rename derivation could not', () => {
  const before = identitiesOf([{ path: 'apps/web', id: 'storefront' }]);
  assert.deepEqual(before.map((i) => [i.path, i.id, i.origin]), [['apps/web', 'storefront', 'declared']]);

  // The rename that a purely derived id could not survive — the failure
  // projectRootHash records, at the far higher rate a monorepo directory rename
  // occurs. The recorded id is unmoved, so anything keyed by it still joins.
  const after = identitiesOf([{ path: 'apps/storefront-web', id: 'storefront' }]);
  assert.equal(after[0]!.id, 'storefront', 'the recorded identity does not move when the directory does');
  assert.notEqual(deriveMemberIdBase('apps/web'), deriveMemberIdBase('apps/storefront-web'),
    'control: derivation alone WOULD have moved it, which is why the id is recorded rather than derived');
});

test('member id: every id this module can mint is a safe path segment, judged by the tree’s own predicate', () => {
  const nasty = [
    'apps/my web app',
    'apps/naïve',
    'apps/.hidden',
    'apps/..leading-dots',
    `apps/${'x'.repeat(400)}`,
    `apps/${'ü'.repeat(400)}`,
    'apps/a\u0007bell',
  ];
  for (const raw of nasty) {
    const verdict = memberPathVerdict(raw);
    assert.equal(verdict.ok, true, `${JSON.stringify(raw)}: FIXTURE must be a legal member path to be worth testing`);
    const identities = identitiesOf([{ path: verdict.ok ? verdict.path : '' }]);
    const { id } = identities[0]!;
    assert.equal(isSafeRunId(id), true,
      `${JSON.stringify(raw)} derived the id ${JSON.stringify(id)}, which is not a safe path segment —`
      + ' a member id becomes a directory name under .traffic-one/ and a key inside a run record');
  }
  // The long ones must still be DISTINCT after being cut to fit, which is the
  // property truncation most easily destroys.
  const long = identitiesOf([
    { path: `apps/${'x'.repeat(400)}a` },
    { path: `apps/${'x'.repeat(400)}b` },
  ]);
  assert.notEqual(long[0]!.id, long[1]!.id,
    'two over-long member names must not be truncated onto one another');
});

test('member id: an entry declaring an unusable id is refused rather than turned into a directory name', () => {
  for (const bad of ['../evil', 'a/b', 'a\\b', '..', '.', '', 'x\u0000y', 'x'.repeat(200)]) {
    const registry = registryOf([{ path: 'apps/web', id: bad }]);
    assert.equal(registry.kind, 'opaque', `id ${JSON.stringify(bad)} must poison the registry`);
    // The ENTRY-level refusal, matched precisely rather than on the shared
    // phrase: the resolver has a check of its own that catches the same input
    // with a different message, so a loose match would let the entry check be
    // deleted without a test noticing. They are not redundant — the entry check
    // is the only one that can name the entry the bytes came from.
    assert.match(registry.kind === 'opaque' ? registry.why : '',
      /holds the entry .* which carries an id that is not a safe path segment/,
      `id ${JSON.stringify(bad)}: the refusal must name the entry AND what is wrong with it`);
  }
  // …and the writer, which takes a declared id from a caller rather than from
  // the file, refuses on the same authority instead of writing it.
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    const outcome = writeWorkspaceMemberRegistry(ws, [{ dir: 'storefront', id: '../evil' }]);
    assert.equal(outcome.outcome, 'rejected', JSON.stringify(outcome));
    assert.equal(fs.existsSync(path.join(ws, '.traffic-one', '.one.json')), false,
      'and nothing is written — the same all-or-nothing rule a bad path already gets');
  });
});

// ── (b) member opt-out ───────────────────────────────────────────────────────

test('member opt-out: an opted-out member is not managed, and that is EXACTLY what an unregistered directory gets', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    const kept = memberDir(ws, 'storefront');
    const out = memberDir(ws, 'legacy-scripts');
    writeStateFile(ws, {
      mode: WORKSPACE_PROJECT_MODE,
      onboardingComplete: true,
      workspaceMembers: [{ path: 'storefront' }, { path: 'legacy-scripts', optOut: true }],
    });
    assertFixture('a workspace registering one member and opting another out', [
      ['both directories exist', () => [fs.existsSync(kept), fs.existsSync(out)], [true, true]],
      ['the registry is legible', () => readWorkspaceMemberRegistry(ws).kind, 'members'],
    ]);

    assert.equal(isRegisteredWorkspaceMember(kept), true);
    assert.equal(isRegisteredWorkspaceMember(out), false,
      'opting a member out must remove its member standing — otherwise the flag records nothing');
    assert.equal(workspaceMembershipOf(out).kind, 'vouched-not-member',
      'no member standing — and not the POSITIVE negative an unlisted directory gets either, because'
      + ' this workspace did consider this directory and the answer it recorded was no');

    // The behaviour is IDENTICAL to never having been listed. That is the whole
    // claim: opt-out adds a recorded decision, never a new authority.
    const unlisted = path.join(root, 'ws2');
    memberDir(unlisted, 'legacy-scripts');
    workspaceRoot(unlisted, ['storefront']);
    assert.equal(
      isRegisteredWorkspaceMember(path.join(unlisted, 'legacy-scripts')),
      isRegisteredWorkspaceMember(out),
    );

    // …and the resolver does NOT make the opted-out member's files the
    // container's problem in some new way: it answers exactly what it answers
    // for the unlisted twin.
    assert.equal(
      resolveProjectRoot(path.join(out, 'src')),
      resolveProjectRoot(path.join(unlisted, 'legacy-scripts', 'src')).replace(unlisted, ws),
      'an opted-out member resolves the way an unregistered directory of the same shape does',
    );

    // ── the one axis where the equivalence is a DATA LOSS ────────────────────
    //
    // Everything above is the AUTHORITY axis, where "identical to never having
    // been listed" is the documented promise and is kept. On the DELETION axis
    // the same equivalence takes the directory's memory of ever having been
    // managed: an onboarded member owning no project marker, flipped to
    // opted-out, stopped resolving to itself, `isLeakedNestedRoot` reported its
    // live `.traffic-one` and the next SessionStart sweep removed it — the flag
    // whose entire contract is "leave this directory alone" deleting its state.
    const parked = memberDir(ws, 'parked');
    writeStateFile(parked, { mode: 'new-project', stack: 'default', onboardingComplete: true });
    writeStateFile(ws, {
      mode: WORKSPACE_PROJECT_MODE,
      onboardingComplete: true,
      workspaceMembers: [{ path: 'storefront' }, { path: 'parked', optOut: true }],
    });
    assert.equal(isRegisteredWorkspaceMember(parked), false,
      'opting out still removes every scrap of member standing — that half is unchanged');
    assert.equal(resolveProjectRoot(parked, undefined, { workspaceAuthority: 'membership' }), parked,
      'but the directory the workspace decided to LEAVE ALONE must keep its own state');
    assert.deepEqual(plannedLeaks(ws), [], 'and the sweep plans nothing anywhere in the shape');
  });
});

test('member opt-out: the DECISION is still recorded, which is the only thing absence cannot express', () => {
  const identities = identitiesOf([{ path: 'storefront' }, { path: 'legacy-scripts', optOut: true }]);
  assert.deepEqual(identities.map((i) => [i.path, i.optOut]), [['storefront', false], ['legacy-scripts', true]],
    'an opted-out member is still an ENTRY: "considered, and the answer was no" is a different fact from'
    + ' "nobody has considered this", and workspace onboarding cannot stop re-offering a directory without it');
  const registry = registryOf([{ path: 'storefront' }, { path: 'legacy-scripts', optOut: true }]);
  assert.deepEqual(registry.kind === 'members' ? registry.members : null, ['storefront'],
    'while the MANAGED list — the one every resolver reads — carries only what is managed');
});

test('member opt-out: flipping the flag never re-ids a DIFFERENT member', () => {
  const managed = identitiesOf([{ path: 'apps/web' }, { path: 'services/web' }]);
  const opted = identitiesOf([{ path: 'apps/web' }, { path: 'services/web', optOut: true }]);
  assert.equal(
    managed.find((i) => i.path === 'apps/web')!.id,
    opted.find((i) => i.path === 'apps/web')!.id,
    'collision counting must include opted-out entries: excluding them would make apps/web stop colliding the'
    + ' moment services/web opted out, silently relocating everything keyed by apps/web’s id',
  );
});

test('member id: the same directory listed twice reads exactly the way the writer WROTE the same input', () => {
  // The reader and the writer must agree about a repeated nomination, or a
  // registry the writer happily produced would read back as malformed.
  assert.deepEqual(
    identitiesOf([{ path: 'a' }, { path: 'a' }]).map((i) => [i.path, i.id]),
    [['a', 'a']],
    'an identical repeat is a duplicate and is dropped — and NOT treated as two members whose bases collide,'
    + ' which would disambiguate one directory against itself',
  );

  for (const contradiction of [
    [{ path: 'a' }, { path: 'a', optOut: true }],
    [{ path: 'a', id: 'x' }, { path: 'a', id: 'y' }],
  ]) {
    const registry = registryOf(contradiction);
    assert.equal(registry.kind, 'opaque', JSON.stringify(contradiction));
    assert.match(registry.kind === 'opaque' ? registry.why : '', /lists a twice with different terms/,
      'a file that answers the same question twice, differently, means neither answer');
  }

  withRoot((root) => {
    // …and the agreement is asserted end to end rather than by inspection: what
    // the writer accepts, the reader reads back as a legible registry.
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    const written = writeWorkspaceMemberRegistry(ws, ['a', 'a']);
    assert.equal(written.outcome, 'written', JSON.stringify(written));
    assert.equal(readWorkspaceMemberRegistry(ws).kind, 'members');
  });
});

test('member opt-out: a non-boolean flag is a malformed entry, not a truthy yes', () => {
  for (const bad of ['true', 1, {}, []]) {
    const registry = registryOf([{ path: 'a', optOut: bad }]);
    assert.equal(registry.kind, 'opaque', `optOut: ${JSON.stringify(bad)} must poison the registry`);
    assert.match(registry.kind === 'opaque' ? registry.why : '', /non-boolean optOut/);
  }
  assert.equal(registryOf([{ path: 'a', optOut: false }]).kind, 'members', 'control: false is legal and means managed');
});

// ── (c) vendor directories ───────────────────────────────────────────────────

test('vendor dirs: EVERY name in the single skip authority is refused as a member path segment', () => {
  assertFixture('the skip authority', [
    ['it still names the four canonical vendor dirs', () => (
      ['vendor', 'node_modules', 'Pods', '.venv'].every((name) => SKIP_DIRS.has(name))
    ), true],
    ['and it is not empty', () => SKIP_DIRS.size > 0, true],
  ]);

  // Asserted over the authority itself, so a hand-copied subset in the
  // production predicate cannot pass this: adding a name to SKIP_DIRS adds a
  // case here automatically, and dropping one from a private copy fails here.
  for (const name of SKIP_DIRS) {
    assert.equal(isVendorDirName(name), true, `${name} is in SKIP_DIRS and must never be mistaken for a member`);
    assert.equal(memberPathVerdict(name).ok, false, `a member at ${JSON.stringify(name)} must be refused`);
    assert.equal(memberPathVerdict(`packages/${name}`).ok, false,
      `a member UNDER ${JSON.stringify(name)} must be refused too — the check is per segment, not on the head`);
    assert.equal(memberPathVerdict(`${name}/inner`).ok, false,
      `and a member INSIDE ${JSON.stringify(name)} must be refused — this is where node_modules/* would enter`);
  }
});

test('vendor dirs: the refusal names the vendor directory, and segment matching does not eat real members', () => {
  const refused = memberPathVerdict('services/node_modules/pkg');
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.why, /dependency\/build directory "node_modules"/,
    'a vendor refusal reported as a syntax failure sends whoever reads it looking at the wrong thing');

  // SUBSTRING matching would destroy ordinary members, so the guard is segment
  // equality. These are all real directory names in real repositories.
  for (const good of ['services/target-api', 'apps/distribution', 'packages/build-tools', 'src/outbox', 'vendors']) {
    assert.equal(memberPathVerdict(good).ok, true, `${good} is an ordinary member and must not be refused`);
  }
  // …and the two names the authority deliberately withholds stay members, so
  // this predicate inherits SKIP_DIRS' curation rather than second-guessing it.
  for (const good of ['services/bin', 'packages/lib']) {
    assert.equal(memberPathVerdict(good).ok, true,
      `${good}: SKIP_DIRS omits bin and bare lib because they are ordinary source dirs in enough ecosystems`);
  }
});

test('vendor dirs: validateMemberPath stays the exact boolean-shaped projection of the verdict', () => {
  // The narrow export nothing inside this module calls any more, kept because
  // it is a published signature. Asserted AS A PROJECTION over the same inputs
  // rather than re-specified, so the two can never answer differently — a
  // second copy of the rules is the drift pair this whole item exists to avoid.
  const inputs: readonly unknown[] = [
    'apps/web', './apps/web', 'apps/web/', 'apps\\web', '  apps/web  ',
    '', '   ', '.', '..', '/etc', 'C:\\Users\\x', '../sibling', 'packages/*', 'packages/{a,b}',
    'node_modules/pkg', 'services/vendor/x', 'Pods', '.venv/lib', 'services/bin',
    null, undefined, 42, {}, [], ['apps/web'],
  ];
  let accepted = 0;
  let refused = 0;
  for (const input of inputs) {
    const verdict = memberPathVerdict(input);
    const projected = validateMemberPath(input);
    assert.equal(projected, verdict.ok ? verdict.path : null,
      `${JSON.stringify(input)}: the boolean-shaped export must agree with the verdict it projects`);
    if (verdict.ok) accepted += 1; else refused += 1;
  }
  assert.equal(accepted > 0 && refused > 0, true,
    'the table must exercise BOTH arms, or the projection is only proven on one of them');
});

test('vendor dirs: the writer refuses one too, with the reason forwarded rather than flattened', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    const outcome = writeWorkspaceMemberRegistry(ws, ['storefront', 'node_modules/some-pkg']);
    assert.equal(outcome.outcome, 'rejected', JSON.stringify(outcome));
    assert.match(outcome.outcome === 'rejected' ? outcome.why : '', /dependency\/build directory "node_modules"/);
    assert.equal(fs.existsSync(path.join(ws, '.traffic-one', '.one.json')), false,
      'all-or-nothing: the good member alongside it is not written either');
  });
});

// ── (d) git ownership ────────────────────────────────────────────────────────

test('git ownership: a member with its own .git is a different animal from one inside the container’s repo', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    const inside = memberDir(ws, 'storefront');
    const own = memberDir(ws, 'ledger');
    fs.mkdirSync(path.join(own, '.git'), { recursive: true });
    // A worktree/submodule `.git` is a FILE, which is why the probe is
    // existsSync and never isDirectory (shared/project-membership.ts dirHasVcs).
    const worktree = memberDir(ws, 'etl');
    write(path.join(worktree, '.git'), 'gitdir: ../../.git/worktrees/etl\n');

    assertFixture('a container repository holding three members', [
      ['the container owns version control', () => fs.existsSync(path.join(ws, '.git')), true],
      ['storefront owns none', () => fs.existsSync(path.join(inside, '.git')), false],
      ['ledger owns a .git DIRECTORY', () => fs.statSync(path.join(own, '.git')).isDirectory(), true],
      ['etl owns a .git FILE', () => fs.statSync(path.join(worktree, '.git')).isFile(), true],
    ]);

    assert.deepEqual(memberGitOwnership(ws, 'storefront'), { kind: 'container-repository', repositoryRoot: ws });
    assert.deepEqual(memberGitOwnership(ws, 'ledger'), { kind: 'own-repository', marker: '.git' });
    assert.deepEqual(memberGitOwnership(ws, 'etl'), { kind: 'own-repository', marker: '.git' },
      'a worktree or submodule marker is a FILE, and a directory-only probe would call it the container’s');
    assert.deepEqual(memberGitOwnership(ws, path.join(ws, 'ledger')), { kind: 'own-repository', marker: '.git' },
      'absolute and relative member spellings both answer');
  });
});

test('git ownership: the third arm is named for the bound it was measured within', () => {
  withRoot((root) => {
    // A repository ABOVE the container. The walk never looks there, so the
    // answer must not claim there is no version control anywhere — it claims
    // only what it measured: none between the member and the workspace root.
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const ws = path.join(root, 'ws');
    memberDir(ws, 'storefront');
    assertFixture('a workspace inside somebody else’s repository', [
      ['the repository is ABOVE the container', () => fs.existsSync(path.join(root, '.git')), true],
      ['and the container owns none of its own', () => fs.existsSync(path.join(ws, '.git')), false],
    ]);
    assert.deepEqual(memberGitOwnership(ws, 'storefront'), { kind: 'no-repository-within-workspace' },
      'the walk stops at the workspace root, and the arm says so rather than claiming a fact it never checked');
  });
});

test('git ownership: the walk climbs THROUGH intermediate directories to the repository that owns the member', () => {
  withRoot((root) => {
    // Nested deeply enough that the walk has to iterate: a one-level member
    // would let a loop that never climbs pass by accident.
    const ws = path.join(root, 'ws');
    const group = path.join(ws, 'group');
    fs.mkdirSync(path.join(group, '.git'), { recursive: true });
    const member = memberDir(group, path.join('nested', 'storefront'));
    assertFixture('a repository BETWEEN the container and the member', [
      ['the container owns no version control', () => fs.existsSync(path.join(ws, '.git')), false],
      ['an intermediate directory does', () => fs.existsSync(path.join(group, '.git')), true],
      ['and the member is two levels below it', () => path.relative(group, member).split(path.sep).length, 2],
    ]);
    assert.deepEqual(memberGitOwnership(ws, 'group/nested/storefront'),
      { kind: 'container-repository', repositoryRoot: group },
      'the nearest enclosing repository owns the member, and the walk must reach it rather than stopping at the'
      + ' member’s immediate parent');
  });
});

test('git ownership: a member path outside the workspace is UNOBSERVABLE, named as such', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    const outside = memberDir(root, 'sibling');
    assertFixture('a directory beside the workspace, not inside it', [
      ['it exists', () => fs.existsSync(outside), true],
      ['and it is genuinely outside the workspace', () => outside.startsWith(`${ws}${path.sep}`), false],
    ]);
    const verdict = memberGitOwnership(ws, outside);
    assert.equal(verdict.kind, 'unobservable',
      '"which repository owns this member" is not a question about a directory that is not in the workspace, and'
      + ' answering it from a walk that never started would report a measurement nobody took');
    assert.match(verdict.kind === 'unobservable' ? verdict.why : '', /is not inside/);
  });
});

test('git ownership: a member path naming nothing is UNOBSERVABLE, not a finding', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    write(path.join(ws, 'not-a-dir'), 'file\n');
    assert.equal(memberGitOwnership(ws, 'ghost').kind, 'unobservable',
      'a registry entry is untrusted data and may name a directory that is not there');
    assert.equal(memberGitOwnership(ws, 'not-a-dir').kind, 'unobservable',
      'and one that names a FILE has not been observed either');
    const ghost = memberGitOwnership(ws, 'ghost');
    assert.equal(ghost.kind === 'unobservable' && ghost.why.length > 0, true,
      'the inability says what it could not read');
  });
});

// ── (e) recursive gitignore ──────────────────────────────────────────────────

test('recursive gitignore: the member body is the container authority RE-ANCHORED, never a second list', () => {
  const patternLines = (body: string) => body.split('\n').filter((line) => line && !line.startsWith('#'));
  const authority = patternLines(TRAFFIC_ONE_BLOCK_BODY);
  const derived = patternLines(WORKSPACE_MEMBER_GITIGNORE_BODY);

  assertFixture('the container ignore authority', [
    ['it carries at least one pattern', () => authority.length > 0, true],
    ['every pattern is a .traffic-one entry', () => authority.every((l) => l.includes('.traffic-one/')), true],
  ]);

  assert.equal(derived.length, authority.length,
    're-anchoring must not add or drop an entry — the authority decides WHAT git may ignore, this decides WHERE');
  // The container authority already ships `**/.traffic-one/…` (match in all
  // directories). Re-anchoring only prefixes a leftover `.traffic-one/` line;
  // an already-recursive line is left alone so we do not emit `**/**/`.
  assert.deepEqual(
    derived,
    authority.map((line) => (line.startsWith('.traffic-one/') ? `**/${line}` : line)),
    'each still-anchored pattern gains git’s match-in-all-directories prefix and nothing else',
  );
  assert.deepEqual(
    WORKSPACE_MEMBER_GITIGNORE_BODY.split('\n').filter((l) => l.startsWith('#')),
    TRAFFIC_ONE_BLOCK_BODY.split('\n').filter((l) => l.startsWith('#')),
    'the authority’s comments survive the transform, including the one recording why digests/ is kept',
  );
});

test('recursive gitignore: it still never hides what the reader needs to see', () => {
  // PATTERN lines only: the authority's own comment mentions `digests/` in
  // order to explain the omission, so a whole-body substring check would
  // confuse the explanation with the rule.
  const patterns = WORKSPACE_MEMBER_GITIGNORE_BODY.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.equal(patterns.some((line) => line.includes('digests')), false,
    'digests/ is deliberately NOT ignored — the handoff record is worth keeping, and re-anchoring a list must'
    + ' not become an opportunity to lengthen it');
  assert.equal(patterns.length > 0, true, 'and the check above is not vacuous — there ARE patterns to inspect');
  assert.match(WORKSPACE_MEMBER_GITIGNORE_BODY, /digests\/` is deliberately NOT ignored/,
    'and the reason travels with the region, into the member’s own file');
});

test('recursive gitignore: WHERE the region goes follows git’s repository boundary, not a preference', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    memberDir(ws, 'storefront');
    const own = memberDir(ws, 'ledger');
    fs.mkdirSync(path.join(own, '.git'), { recursive: true });
    memberDir(ws, 'legacy');

    const inside = memberGitignorePlan(ws, { path: 'storefront', optOut: false });
    assert.equal(inside.kind, 'at-workspace',
      'a member inside the container’s repository is covered by ONE recursive region at the container — writing'
      + ' a file per member imposes N new files on a repository Traffic One did not create');
    assert.equal(inside.kind === 'at-workspace' ? inside.file : '', path.join(ws, '.gitignore'));
    assert.equal(inside.kind === 'at-workspace' ? inside.body : '', WORKSPACE_MEMBER_GITIGNORE_BODY);

    const separate = memberGitignorePlan(ws, { path: 'ledger', optOut: false });
    assert.equal(separate.kind, 'at-member',
      'ignore rules do not cross a repository boundary, so the container’s region cannot reach a member that'
      + ' owns its own repository — measured with git check-ignore, not inferred');
    assert.equal(separate.kind === 'at-member' ? separate.file : '', path.join(own, '.gitignore'));
    assert.equal(separate.kind === 'at-member' ? separate.body : '', TRAFFIC_ONE_BLOCK_BODY,
      'and inside its own repository the member IS the root, so the region is the unanchored authority');

    const declined = memberGitignorePlan(ws, { path: 'legacy', optOut: true });
    assert.equal(declined.kind, 'none',
      'Traffic One writes nothing inside a member it does not manage, so a .gitignore there would be the first'
      + ' artifact of the management the user declined');

    const ghost = memberGitignorePlan(ws, { path: 'ghost', optOut: false });
    assert.equal(ghost.kind, 'none',
      'and a member we could not observe gets no plan rather than a guessed one');
  });
});

// ── the write path, with identity ────────────────────────────────────────────

test('workspace members: the writer RECORDS the id it minted, so a later read never re-derives one', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    const written = writeWorkspaceMemberRegistry(ws, [
      'apps/web',
      { dir: 'services/web' },
      { dir: 'legacy', optOut: true },
    ]);
    assert.equal(written.outcome, 'written', JSON.stringify(written));
    assert.deepEqual(written.outcome === 'written' ? written.members : null, ['apps/web', 'services/web'],
      'the managed list excludes the opted-out member');

    const onDisk = JSON.parse(fs.readFileSync(path.join(ws, '.traffic-one', '.one.json'), 'utf8')) as {
      workspaceMembers: { path: string; id?: string; optOut?: boolean }[];
    };
    assert.deepEqual(onDisk.workspaceMembers.map((entry) => entry.path), ['apps/web', 'services/web', 'legacy']);
    assert.equal(onDisk.workspaceMembers.every((entry) => typeof entry.id === 'string' && entry.id.length > 0), true,
      'every entry carries a recorded id — a registry storing only paths would re-derive, and therefore silently'
      + ' re-assign, an id on every read');
    assert.deepEqual(onDisk.workspaceMembers.map((entry) => entry.optOut), [undefined, undefined, true]);

    const read = readWorkspaceMemberRegistry(ws);
    assert.deepEqual(
      read.kind === 'members' ? read.identities.map((i) => [i.path, i.id, i.origin]) : null,
      (written.outcome === 'written' ? written.identities : []).map((i) => [i.path, i.id, 'declared']),
      'what the writer published is what the reader reads back, and the reader now sees them as DECLARED',
    );
  });
});

test('workspace members: nominating one directory twice with different terms is a contradiction, not a duplicate', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    memberDir(ws, 'storefront');

    const same = writeWorkspaceMemberRegistry(ws, ['storefront', 'storefront']);
    assert.equal(same.outcome, 'written', 'an identical duplicate is deduplicated, exactly as it always was');
    assert.deepEqual(same.outcome === 'written' ? same.members : null, ['storefront']);

    for (const conflicting of [
      [{ dir: 'storefront' }, { dir: 'storefront', optOut: true }],
      [{ dir: 'storefront', id: 'a' }, { dir: 'storefront', id: 'b' }],
    ]) {
      const outcome = writeWorkspaceMemberRegistry(ws, conflicting);
      assert.equal(outcome.outcome, 'rejected', JSON.stringify(outcome));
      assert.match(outcome.outcome === 'rejected' ? outcome.why : '', /nominated twice with different terms/,
        'picking one silently would record an opt-out the caller meant to revoke, or revoke one it meant to keep');
    }
  });
});

// ── 4. two ways a registry entry and its directory can fall out of step ──────
//
// The registry is a list of directories, and the two tests below are the two
// ways the list and the disk can disagree while the AUTHOR believes they agree:
// an entry that names a directory INSIDE another entry (both correct, and the
// deepest one has to win), and an entry whose spelling differs from the
// directory's while naming the same directory (a typo the filesystem forgives).
// Both were resolved to the wrong member; one of them was resolved to deletion.

/** A member that also holds committed state of its own — an onboarded member. */
function onboardedMemberDir(container: string, id: string): string {
  const dir = memberDir(container, id);
  writeStateFile(dir, { mode: 'new-project', stack: 'default', onboardingComplete: true });
  return dir;
}

test('workspace members: overlapping registry entries resolve to the DEEPEST one, even from a stateless directory', () => {
  withRoot((root) => {
    // A container registering BOTH `apps` and `apps/web`. `memberPathVerdict`
    // accepts each on its own terms and `writeWorkspaceMemberRegistry` permits
    // the pair, so this is a shape the product can produce, not a hand-forged
    // one — and `enclosingRegisteredMember` documents the deepest-match rule
    // with exactly this example.
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    write(path.join(ws, 'package.json'), `${JSON.stringify({ name: 'ws', workspaces: ['apps'] })}\n`);
    workspaceRoot(ws, ['apps', 'apps/web']);
    // The shallower member is ONBOARDED and the deeper one is not, which is the
    // only arrangement that reaches the defect: the walk up from `apps/web`
    // stops at `apps`'s own committed state one level below the container, so
    // the container's redirect — the only code that implements deepest-match —
    // never runs unless the acceptance clause declines.
    const apps = onboardedMemberDir(ws, 'apps');
    const web = memberDir(apps, 'web');
    const registry = readWorkspaceMemberRegistry(ws);

    assert.equal(enclosingRegisteredMember(ws, registry, path.join(web, 'src')), web,
      'the pure rule: the deepest registered entry enclosing the target wins');
    assert.equal(enclosingRegisteredMember(ws, registry, apps), apps,
      'and a target that IS the shallower member still resolves to it');

    // MEASURED AT A STATELESS DIRECTORY, which is the point of this row. `web`
    // and `web/src` hold no state, so no retention sweep ever evaluates them and
    // no deletion table can see this: the whole cost is ATTRIBUTION.
    for (const [label, dir] of [['the member itself', web], ['a source dir inside it', path.join(web, 'src')]] as const) {
      const detailed = resolveProjectRootDetailed(dir);
      assert.equal(detailed.root, web,
        `${label}: work in the deeper member must not be attributed to the shallower one — every gate,`
        + ' plan, run state and role claim follows this answer, and a write from here into `apps` stops'
        + ' looking cross-member to the fence once both sides resolve to `apps`');
      assert.equal(detailed.workspaceContainer, ws, `${label}: carrying the container that registered it`);
    }

    // And the shallower member is undisturbed: it is still its own root, still
    // a member, and still not a deletion candidate.
    assert.equal(resolveProjectRoot(apps, undefined, { workspaceAuthority: 'membership' }), apps,
      'the shallower member still resolves to ITSELF, which is what makes retention keep its state');
    assert.equal(workspaceMembershipOf(apps).kind, 'member');
    assert.deepEqual(plannedLeaks(ws), [], 'and no sweep action anywhere in the shape');
  });
});

test('workspace members: once the deeper member is onboarded too, both keep their own roots', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    write(path.join(ws, 'package.json'), `${JSON.stringify({ name: 'ws', workspaces: ['apps'] })}\n`);
    workspaceRoot(ws, ['apps', 'apps/web']);
    const apps = onboardedMemberDir(ws, 'apps');
    const web = onboardedMemberDir(apps, 'web');

    for (const member of [apps, web]) {
      assert.equal(resolveProjectRoot(member, undefined, { workspaceAuthority: 'membership' }), member,
        'each overlapping member is its own root — the direction retention reads as KEEP');
      const detailed = resolveProjectRootDetailed(member);
      assert.equal(detailed.root, member);
      assert.equal(detailed.workspaceContainer, ws);
    }
    assert.equal(resolveProjectRootDetailed(path.join(web, 'src')).root, web);
    assert.deepEqual(plannedLeaks(ws), []);
  });
});

/**
 * Does this volume fold case? Asked of the volume the fixture lives on rather
 * than assumed from `process.platform`, because the answer is a property of the
 * FILESYSTEM: a case-sensitive APFS volume and a case-insensitive one both exist
 * on macOS, and a `ciopfs` mount exists on Linux.
 */
function volumeFoldsCase(root: string): boolean {
  const probe = path.join(root, 'CaseProbe');
  fs.mkdirSync(probe, { recursive: true });
  try {
    return fs.existsSync(path.join(root, 'caseprobe'));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * Does this volume treat NFC and NFD as one name — a SECOND axis, not a
 * restatement of case folding.
 *
 * APFS is normalization-insensitive in BOTH its case-sensitive and its
 * case-insensitive variant, so a table row keyed on `volumeFoldsCase` would
 * assert the wrong thing on a case-sensitive APFS image. Probed the same way and
 * for the same reason: this is a property of the filesystem, and the whole
 * argument for identity matching is that the platform is asked instead of
 * guessed at.
 */
function volumeFoldsNormalization(root: string): boolean {
  const probe = path.join(root, 'caf\u00e9-probe');            // NFC
  fs.mkdirSync(probe, { recursive: true });
  try {
    return fs.existsSync(path.join(root, 'cafe\u0301-probe')); // NFD
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

test('workspace members: a registry entry is matched by FILESYSTEM IDENTITY, so a case typo cannot delete a member', () => {
  withRoot((root) => {
    const folds = volumeFoldsCase(root);
    const normalizes = volumeFoldsNormalization(root);

    // Every spelling of `api` a committed `.one.json` could plausibly carry,
    // plus the ones that must NOT match anything. `want` is what the entry
    // should claim about the real directory `<ws>/api`:
    //   'same'     — the entry names the same directory, so the member resolves
    //                to itself and its state survives. On a case-SENSITIVE
    //                volume the case rows genuinely name a directory that does
    //                not exist, so they fall to 'other' there — and that is the
    //                right answer, not a gap: `<ws>/Api` and `<ws>/api` really
    //                are two directories there, and unregistered state inside a
    //                workspace really is the packages/ui leak. One rule, the
    //                platform's own, gives both answers correctly, which is
    //                exactly what a hand-written folding table could not do.
    //   'other'    — a different directory; the entry claims nothing here.
    //   'declined' — `memberPathVerdict` refuses the entry, so the whole
    //                registry goes opaque and grants nothing at all.
    //
    // THE FOURTH COLUMN is the directory the row is about, defaulting to `api`.
    // It exists for one row: the only spelling difference a folding table is
    // MOST likely to get wrong is not case at all but Unicode normalization, and
    // testing that needs a non-ASCII directory to be wrong about.
    //
    // A RESIDUAL THIS TABLE MAKES VISIBLE AND CANNOT CLOSE: the `folds` rows are
    // harmless where they were authored and expensive where the repository lands.
    // A registry entry carrying a case typo, committed on macOS, matches by
    // identity there and costs nothing; cloned onto a case-sensitive Linux
    // filesystem the entry names a directory that does not exist, the member
    // stops being recognised, and the sweep takes its `.one.json`. `.one.json` is
    // a TRACKED file, so the typo travels with the repository. Nothing in this
    // module can fix that — the two platforms genuinely disagree about how many
    // directories there are — and the fix belongs to whatever writes registry
    // entries (`writeWorkspaceMemberRegistry` records the spelling it validated,
    // which is why a product-written registry cannot carry this).
    const SPELLINGS: readonly [entry: string, want: 'same' | 'other' | 'declined', why: string, dir?: string][] = [
      ['api', 'same', 'the exact spelling'],
      ['./api', 'same', 'a ./ prefix, normalized away by the entry validator'],
      ['api/', 'same', 'a trailing slash, normalized away'],
      ['  api  ', 'same', 'surrounding whitespace, trimmed'],
      ['api\\', 'same', 'a Windows separator, normalized then stripped'],
      ['Api', folds ? 'same' : 'other', 'the committed typo this test exists for'],
      ['API', folds ? 'same' : 'other', 'shouted'],
      ['aPi', folds ? 'same' : 'other', 'mixed case'],
      ['ApI/', folds ? 'same' : 'other', 'mixed case plus a trailing slash'],
      ['Api/', folds ? 'same' : 'other', 'capitalized plus a trailing slash'],
      // NOT a case row, and not the `'\u0041pi'` row this replaces: that escape
      // is byte-identical to `'Api'` above it, so it re-measured the same input
      // and left the table's own stated hazard — "whatever Unicode normalization
      // does that nobody here has tested" — untested. This row is the test.
      ['cafe\u0301', normalizes ? 'same' : 'other',
        'the same name in NFD where the directory is NFC — the difference a folding table forgets', 'caf\u00e9'],
      ['apiary', 'other', 'a name this one is a PREFIX of'],
      ['ap', 'other', 'a name that is a prefix of this one'],
      ['api2', 'other', 'a sibling with a digit'],
      ['web', 'other', 'a genuinely unrelated directory that really exists'],
      ['nosuchdir', 'other', 'a directory that does not exist at all'],
      ['api-', 'other', 'a trailing hyphen is part of the name, not punctuation to strip'],
      ['.', 'declined', 'the container itself is never its own member'],
      ['../api', 'declined', 'an entry escaping the workspace'],
      ['/api', 'declined', 'an absolute entry'],
      ['ap*', 'declined', 'a glob — a registry lists directories, never patterns'],
      ['node_modules/api', 'declined', 'an entry under a dependency directory'],
    ];
    assert.equal(SPELLINGS.length, 22, 'the table is the evidence; keep its size honest');

    for (const [entry, want, why, dir] of SPELLINGS) {
      const ws = path.join(root, `s-${Buffer.from(entry).toString('hex')}`);
      fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
      write(path.join(ws, 'package.json'), `${JSON.stringify({ name: 'ws' })}\n`);
      writeStateFile(ws, {
        mode: WORKSPACE_PROJECT_MODE, onboardingComplete: true, workspaceMembers: [{ path: entry }],
      });
      // The delete-exposed half of the shape: the member owns NO project marker
      // of its own, so nothing but the registry stands between its state and the
      // leaked-nested-root sweep.
      const api = path.join(ws, dir ?? 'api');
      writeStateFile(api, { mode: 'new-project', stack: 'default', onboardingComplete: true });
      write(path.join(api, 'src', 'main.ts'), 'export const boot = (): number => 0;\n');
      fs.mkdirSync(path.join(ws, 'web'), { recursive: true });
      // Named by no entry in the table, on any row: the control for "identity
      // matching did not start handing membership to whatever is lying around".
      const unrelated = path.join(ws, 'unrelated');
      fs.mkdirSync(unrelated, { recursive: true });
      const label = `${JSON.stringify(entry)} (${why})`;

      const registry = readWorkspaceMemberRegistry(ws);
      assert.equal(registry.kind, want === 'declined' ? 'opaque' : 'members', `${label}: registry arm`);
      assert.equal(enclosingRegisteredMember(ws, registry, path.join(api, 'src')), want === 'same' ? api : null,
        `${label}: the member the deepest-match rule finds`);
      assert.equal(isRegisteredWorkspaceMember(api), want === 'same', `${label}: membership verdict`);

      // The consequence, which is the whole reason identity is the primary test.
      const resolved = resolveProjectRoot(api, undefined, { workspaceAuthority: 'membership' });
      if (want === 'same') {
        assert.equal(resolved, api,
          `${label}: the member must resolve to ITSELF — anything else is what retention reads as a leaked`
          + ' nested root, and the sweep then removes this member\'s live state');
        assert.deepEqual(plannedLeaks(ws), [], `${label}: and the sweep plans nothing`);
        assert.equal(resolveProjectRootDetailed(api).workspaceContainer, ws,
          `${label}: recognised as a member OF this container, not merely left alone`);
      } else if (want === 'other') {
        assert.notEqual(resolved, api,
          `${label}: an entry that names some OTHER directory must not silently anchor this one`);
      } else {
        // A DECLINED entry poisons the registry, so the container's member list
        // could not be ENUMERATED — and an unreadable list is not evidence that
        // this directory is unregistered. Every one of these five rows used to
        // resolve `api` to the container, which is precisely what retention
        // reads as a leaked nested root, so the sweep removed the live state of
        // a member the registry named correctly on the row above. All five are
        // reachable from bytes an agent's Write tool produces.
        assert.equal(registry.kind, 'opaque', `${label}: fixture — this row is the unreadable-registry half`);
        assert.equal(resolved, api,
          `${label}: a registry nobody could enumerate must not license taking this directory's state`);
        assert.deepEqual(plannedLeaks(ws), [],
          `${label}: and the sweep plans nothing while the registry stays unreadable`);
        // The other axis is untouched: withholding a deletion is not granting
        // authority, and `isRegisteredWorkspaceMember` above already said no.
        assert.equal(resolveProjectRootDetailed(api).workspaceContainer, ws,
          `${label}: the container is still reported, so the fence engages and no gate operates here`);
      }
      // Never, on any row: a directory nobody registered picking up membership
      // from a spelling that was meant for somebody else.
      assert.equal(enclosingRegisteredMember(ws, registry, path.join(unrelated, 'src')), null,
        `${label}: control — a genuinely unrelated directory is claimed by nothing`);
      assert.equal(isRegisteredWorkspaceMember(unrelated), false, `${label}: control, through the membership verdict`);
    }
  });
});

test('workspace members: a correctly-spelled registry pays NO identity syscall at all', () => {
  withRoot((root) => {
    // The cost the two-pass structure exists for. Instrumented on a 60-member
    // workspace over 200 warm calls, the single-pass form built the whole
    // identity set at the first depth whose spelling missed: 61 `statSync` per
    // resolution from inside a member, 65 at six levels deep, against 0 before
    // member identity existed. Every one of them was spent on the registry shape
    // that is overwhelmingly the common one — the correctly spelled one — and
    // this row is what keeps it at zero.
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    write(path.join(ws, 'package.json'), `${JSON.stringify({ name: 'ws' })}\n`);
    const names = Array.from({ length: 12 }, (unused, index) => `m${String(index).padStart(2, '0')}`);
    workspaceRoot(ws, names);
    for (const name of names) {
      const dir = memberDir(ws, name);
      writeStateFile(dir, { mode: 'new-project', stack: 'default', onboardingComplete: true });
    }
    const member = path.join(ws, 'm07');
    const deep = path.join(member, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    const registry = readWorkspaceMemberRegistry(ws);

    const fsModule = createRequire(__filename)('fs') as { statSync: typeof fs.statSync };
    const real = fsModule.statSync;
    let stats = 0;
    fsModule.statSync = ((target: fs.PathLike, ...rest: unknown[]) => {
      stats += 1;
      return (real as (...args: unknown[]) => unknown)(target, ...rest) as fs.Stats;
    }) as typeof fs.statSync;
    try {
      for (const [label, from] of [['the member itself', member], ['three levels inside it', deep]] as const) {
        stats = 0;
        assert.equal(enclosingRegisteredMember(ws, registry, from), member, `${label}: the answer is unchanged`);
        assert.equal(stats, 0,
          `${label}: matching cost ${stats} statSync on a registry whose every entry is spelled exactly right —`
          + ' the identity pass must only run at the depths that could still beat the spelling match');
      }
    } finally {
      fsModule.statSync = real;
    }
  });
});

test('workspace members: a DEEPER entry matched only by identity still beats a shallower spelling match', () => {
  withRoot((root) => {
    if (!volumeFoldsCase(root)) return;
    // The row that forbids the cheap version of the two-pass structure. Returning
    // the deepest SPELLING match without looking deeper by identity would answer
    // `apps` here — and then `apps/web`'s own state stops resolving to itself,
    // which is exactly what retention reads as a leaked nested root. An
    // optimization would have reintroduced the deletion the matcher exists to
    // prevent, so the second pass runs at every depth deeper than the first
    // pass's answer.
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    write(path.join(ws, 'package.json'), `${JSON.stringify({ name: 'ws' })}\n`);
    workspaceRoot(ws, ['apps', 'apps/Web']);       // the deeper entry carries the typo
    const apps = onboardedMemberDir(ws, 'apps');
    const web = onboardedMemberDir(apps, 'web');
    const registry = readWorkspaceMemberRegistry(ws);

    assert.equal(enclosingRegisteredMember(ws, registry, path.join(web, 'src')), web,
      'the deepest match wins whether it was found by spelling or by identity');
    assert.equal(enclosingRegisteredMember(ws, registry, path.join(apps, 'src')), apps,
      'and the shallower member still owns everything the deeper one does not');
    assert.equal(resolveProjectRoot(web, undefined, { workspaceAuthority: 'membership' }), web,
      'so the deeper member resolves to ITSELF, which is what retention reads as KEEP');
    assert.deepEqual(plannedLeaks(ws), [], 'and nothing in the shape is swept');
  });
});

// ── 4. the two axes identity moves in opposite directions ────────────────────
//
// Identity matching is PROTECTIVE on the deletion axis and a WIDENING on the
// authority axis, and the same mechanism produces both. An entry that reaches a
// directory it does not name — a symlink — must therefore be granted enough
// standing that the sweep never takes the target's state, and none at all for
// the fence, the claim and the plan. Picking one axis loses the other.

/** A container registering `entry`, plus a real member `other` to span against. */
function laundering(root: string, name: string, entry: string, plant: (ws: string) => string): {
  ws: string; target: string; other: string;
} {
  const ws = path.join(root, name);
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  write(path.join(ws, 'package.json'), `${JSON.stringify({ name: 'ws' })}\n`);
  workspaceRoot(ws, [entry, 'other']);
  const other = memberDir(ws, 'other');
  writeStateFile(other, { mode: 'new-project', stack: 'default', onboardingComplete: true });
  return { ws, target: plant(ws), other };
}

test('workspace members: a symlinked entry protects its target from the sweep and grants it NOTHING else', () => {
  withRoot((root) => {
    for (const [label, entry, plant] of [
      ['a sibling the registry never names', 'x', (ws: string) => {
        const secret = memberDir(ws, 'secret');
        writeStateFile(secret, { mode: 'new-project', stack: 'default', onboardingComplete: true });
        fs.symlinkSync(secret, path.join(ws, 'x'), 'dir');
        return secret;
      }],
      ['a DEEPER directory, so the entry is not even the same depth', 'y', (ws: string) => {
        const inner = memberDir(ws, path.join('deep', 'inner'));
        writeStateFile(inner, { mode: 'new-project', stack: 'default', onboardingComplete: true });
        fs.symlinkSync(inner, path.join(ws, 'y'), 'dir');
        return inner;
      }],
    ] as const) {
      const { ws, target } = laundering(root, `launder-${entry}`, entry, plant);
      const registry = readWorkspaceMemberRegistry(ws);

      // AUTHORITY: nothing. The entry points at this directory, so no gate may
      // treat it as a project of its own — pre-identity behaviour, and the
      // widening a `dev:ino` comparison on its own reintroduced. A ghost entry
      // needs no privilege to try this: nothing has to be overwritten.
      assert.equal(enclosingRegisteredMember(ws, registry, path.join(target, 'src')), null,
        `${label}: an entry that POINTS AT a directory must not make it a member`);
      assert.equal(isRegisteredWorkspaceMember(target), false, `${label}: nor a member by the exact predicate`);
      assert.equal(workspaceMembershipOf(target).kind, 'vouched-not-member',
        `${label}: and the verdict says which of the two it is, rather than denying silently`);

      // DELETION: full protection. The directory resolves to ITSELF, which is
      // what retention reads as KEEP, and the sweep plans nothing.
      assert.equal(resolveProjectRoot(target, undefined, { workspaceAuthority: 'membership' }), target,
        `${label}: the target's own state must never be swept for standing we declined to grant it`);
      assert.deepEqual(plannedLeaks(ws), [], `${label}: and the sweep plans nothing at all`);
      // The container is still reported, which is what makes the fence engage
      // and refuse instead of treating the directory as a standalone project.
      assert.equal(resolveProjectRootDetailed(target).workspaceContainer, ws, label);

      // The LINK PATH itself keeps full standing: the registry names it, and a
      // name the workspace wrote is standing on its own terms whatever sits at
      // that name. Only the directory the link happens to reach is demoted, so
      // the demotion cannot be reached by declining registered spellings.
      assert.equal(isRegisteredWorkspaceMember(path.join(ws, entry)), true,
        `${label}: the registered spelling is a member even though a link sits at it`);
    }
  });
});

// TWO SIDES, AND THE SECOND ONE HAD NO ROW AT ALL. `registryEnclosureOf` stats
// two things: every ENTRY the registry names, and the CANDIDATE — the directory
// whose fate is being decided. Only the entry side was injected on, which left
// the candidate-side guard entirely unpinned: replacing it with a "no entry
// reaches this" answer survived the whole file. It is not dead code — with that
// mutant applied, an injected failure on the member's OWN directory flips it
// from keep to container and the sweep plans its state directory. The two rows
// below differ in exactly one value, `blocked`.
for (const [side, spelling] of [
  ['the ENTRY the registry names', 'Api'],
  ['the CANDIDATE — the member\'s own directory, whose fate is being decided', 'api'],
] as const) {
  test(`workspace members: an INDETERMINATE identity may not license a deletion (${side})`, () => {
    withRoot((root) => {
      // A member matched only by identity — the committed entry carries a case
      // typo — whose `statSync` fails transiently: EACCES, EIO, a network mount
      // blipping, an antivirus or Spotlight hold. Closed for membership is OPEN
      // for deletion, and this is the row that says so.
      if (!volumeFoldsCase(root)) return;    // nothing to match by identity here
      const ws = path.join(root, `transient-${spelling}`);
      fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
      write(path.join(ws, 'package.json'), `${JSON.stringify({ name: 'ws' })}\n`);
      workspaceRoot(ws, ['Api']);
      // The delete-exposed shape: the member owns no project marker, so only the
      // registry stands between its state and the sweep.
      const api = path.join(ws, 'api');
      writeStateFile(api, { mode: 'new-project', stack: 'default', onboardingComplete: true });
      write(path.join(api, 'src', 'main.ts'), 'export const boot = (): number => 0;\n');
      assert.equal(resolveProjectRoot(api, undefined, { workspaceAuthority: 'membership' }), api,
        'FIXTURE without the failure the member resolves to itself, so the row measures the failure');

      // The counter is installed on the CJS module object the runtime calls
      // through: `import * as fs` yields getter-only namespace members.
      const fsModule = createRequire(__filename)('fs') as { statSync: typeof fs.statSync };
      const real = fsModule.statSync;
      const blocked = path.join(ws, spelling);
      // EACCES is the headline case; the rest are the errnos `fsIdentity` also
      // refuses to read as evidence, and each one of them kills the mutant on
      // its own.
      for (const errno of ['EACCES', 'EPERM', 'EIO', 'ELOOP', 'ENAMETOOLONG', 'EMFILE', 'ETIMEDOUT']) {
        let refused = 0;
        fsModule.statSync = ((target: fs.PathLike, ...rest: unknown[]) => {
          if (path.resolve(String(target)) === blocked) {
            refused += 1;
            const error = new Error(`${errno}: injected, stat '${String(target)}'`) as Error & { code: string };
            error.code = errno;
            throw error;
          }
          return (real as (...args: unknown[]) => unknown)(target, ...rest) as fs.Stats;
        }) as typeof fs.statSync;
        try {
          const where = `${side} / ${errno}`;
          const verdict = workspaceMembershipOf(api);
          assert.equal(verdict.kind, 'vouched-not-member',
            `${where}: we could not establish membership, and "could not tell" is not the same answer as "no"`);
          assert.ok(refused > 0, `${where}: FIXTURE the injected failure must actually have been reached`);
          assert.equal(isRegisteredWorkspaceMember(api), false,
            `${where}: fail CLOSED for authority — an unestablished membership grants nothing`);
          assert.equal(resolveProjectRoot(api, undefined, { workspaceAuthority: 'membership' }), api,
            `${where}: and fail closed for DATA — a transient stat failure must not turn a live member into a`
            + ' leaked nested root and take its .one.json');
          assert.deepEqual(plannedLeaks(ws), [], `${where}: the sweep plans nothing while the failure lasts`);
        } finally {
          fsModule.statSync = real;
        }
      }
    });
  });
}

// The identity union closed STAT-level indeterminacy. REGISTRY-level
// indeterminacy is the other half of the same hazard and was wide open: the
// membership walk answers before `registryEnclosureOf` is ever reached, so the
// arm that folds an unestablished answer into the protected verdict never ran.
// Every shape below is bytes an agent's Write tool produces, and every one of
// them deleted the state of a member the registry named CORRECTLY on the line
// above it.
test('workspace members: a registry nobody could ENUMERATE may not license a deletion either', () => {
  withRoot((root) => {
    const POISON: readonly [label: string, plant: (ws: string) => void][] = [
      ['a malformed second entry beside the good one', (ws) => writeStateFile(ws, {
        mode: WORKSPACE_PROJECT_MODE,
        onboardingComplete: true,
        workspaceMembers: [{ path: 'api' }, { path: 'packages/*' }],
      })],
      ['a non-string entry', (ws) => writeStateFile(ws, {
        mode: WORKSPACE_PROJECT_MODE,
        onboardingComplete: true,
        workspaceMembers: [{ path: 'api' }, { path: 7 }],
      })],
      ['two entries colliding on one id', (ws) => writeStateFile(ws, {
        mode: WORKSPACE_PROJECT_MODE,
        onboardingComplete: true,
        workspaceMembers: [{ path: 'api' }, { path: 'other', id: 'api' }],
      })],
      ['a non-array members field', (ws) => writeStateFile(ws, {
        mode: WORKSPACE_PROJECT_MODE,
        onboardingComplete: true,
        workspaceMembers: { api: true },
      })],
      ['a corrupt container state file', (ws) => write(
        path.join(ws, '.traffic-one', '.one.json'), '{ "mode": "workspace"\n',
      )],
    ];

    for (const [label, plant] of POISON) {
      const ws = path.join(root, `poison-${Buffer.from(label).toString('hex').slice(0, 12)}`);
      fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
      write(path.join(ws, 'package.json'), `${JSON.stringify({ name: 'ws' })}\n`);
      // The delete-exposed shape, exactly as everywhere else in this file: an
      // onboarded member owning no project marker of its own.
      const api = path.join(ws, 'api');
      writeStateFile(api, { mode: 'new-project', stack: 'default', onboardingComplete: true });
      write(path.join(api, 'src', 'main.ts'), 'export const boot = (): number => 0;\n');

      // FIXTURE: with a legible registry naming the same member, everything holds.
      workspaceRoot(ws, ['api']);
      assert.equal(isRegisteredWorkspaceMember(api), true, `${label}: FIXTURE the legible control is a member`);
      assert.equal(resolveProjectRoot(api, undefined, { workspaceAuthority: 'membership' }), api, label);

      plant(ws);
      const verdict = workspaceMembershipOf(api);
      assert.equal(verdict.kind, 'indeterminate',
        `${label}: a registry that could not be enumerated is an inability, never a finding about this directory`);
      assert.equal(isRegisteredWorkspaceMember(api), false,
        `${label}: fail CLOSED for authority — nothing is granted on the strength of bytes nobody could read`);
      assert.equal(resolveProjectRoot(api, undefined, { workspaceAuthority: 'membership' }), api,
        `${label}: and fail closed for DATA — one malformed entry must not take a correctly-registered`
        + " member's .one.json");
      assert.deepEqual(plannedLeaks(ws), [], `${label}: the sweep plans nothing while the registry is unreadable`);
      // THE TWO AXES PART COMPANY ON THE LAST SHAPE, and only there. Withholding
      // the deletion grants no authority in either case, but the container is
      // only REPORTED when the state file parsed and said `mode: 'workspace'`:
      // an `opaque` registry is a demonstrable container with an unusable list,
      // so the fence must engage and refuse its members. A file that does not
      // parse cannot say even that — and reporting it as a container refuses
      // every gated call under any directory whose parent merely got
      // merge-conflicted, which is a freeze with nothing on the other side of
      // it. See the `indeterminate` disjunct's note in hook/paths.ts.
      const illegible = verdict.kind === 'indeterminate' && verdict.registry.kind === 'illegible';
      assert.equal(resolveProjectRootDetailed(api).workspaceContainer, illegible ? '' : ws, label);
    }
  });
});

// ENOENT and ENOTDIR are evidence about a NAME, which is sound for an ENTRY and
// self-contradictory for the CANDIDATE: the caller asking is standing in a
// directory because it found committed state there, so a name reaching nothing
// while that state is still readable is a rename in flight — a `git checkout`
// swapping the tree under a session sweep — and not a directory that stopped
// existing.
test('workspace members: an absent CANDIDATE that still holds state is a race, not a finding', () => {
  withRoot((root) => {
    if (!volumeFoldsCase(root)) return;   // the member is matched by identity here
    const ws = path.join(root, 'racing');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    write(path.join(ws, 'package.json'), `${JSON.stringify({ name: 'ws' })}\n`);
    workspaceRoot(ws, ['Api']);
    const api = path.join(ws, 'api');
    writeStateFile(api, { mode: 'new-project', stack: 'default', onboardingComplete: true });
    assert.equal(resolveProjectRoot(api, undefined, { workspaceAuthority: 'membership' }), api,
      'FIXTURE without the race the member resolves to itself');

    const fsModule = createRequire(__filename)('fs') as { statSync: typeof fs.statSync };
    const real = fsModule.statSync;
    for (const errno of ['ENOENT', 'ENOTDIR']) {
      let refused = 0;
      fsModule.statSync = ((target: fs.PathLike, ...rest: unknown[]) => {
        if (path.resolve(String(target)) === api) {
          refused += 1;
          const error = new Error(`${errno}: injected, stat '${String(target)}'`) as Error & { code: string };
          error.code = errno;
          throw error;
        }
        return (real as (...args: unknown[]) => unknown)(target, ...rest) as fs.Stats;
      }) as typeof fs.statSync;
      try {
        assert.equal(workspaceMembershipOf(api).kind, 'vouched-not-member',
          `${errno}: the name reached nothing while its state file did not — that is an inability, not a finding`);
        assert.ok(refused > 0, `${errno}: FIXTURE the injected failure must actually have been reached`);
        assert.equal(resolveProjectRoot(api, undefined, { workspaceAuthority: 'membership' }), api,
          `${errno}: a candidate that reaches nothing while its own state file is still readable is a`
          + ' rename in flight, and the sweep must not act inside that window');
        assert.deepEqual(plannedLeaks(ws), [], `${errno}: nothing is planned`);
      } finally {
        fsModule.statSync = real;
      }
    }

    // The positive negative is untouched: a directory that genuinely is not
    // there has no state file, so it stays the finding it has always been.
    assert.equal(workspaceMembershipOf(path.join(ws, 'nosuchdir')).kind, 'not-member',
      'a legible registry that does not list a directory nothing lives in is still a POSITIVE negative');
  });
});

test('workspace members: member directories are counted by identity, not by spelling', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    const api = memberDir(ws, 'api');
    const web = memberDir(ws, 'web');
    const folds = volumeFoldsCase(root);
    // The counting side of the question `enclosingRegisteredMember` answers on
    // the matching side: `<ws>/api` and `<ws>/Api` are ONE directory where the
    // volume folds, so a fence counting by string reports a span of two about a
    // call that spans one.
    assert.deepEqual(dedupeMemberDirectories([api, path.join(ws, 'Api')]), folds ? [api] : [api, path.join(ws, 'Api')],
      'two spellings of one directory count once — and two genuine directories still count twice');
    assert.deepEqual(dedupeMemberDirectories([api, web]), [api, web], 'two real members are two');
    assert.deepEqual(dedupeMemberDirectories([api, api]), [api], 'and the plain repeat still collapses');
    // A directory we cannot stat stays SEPARATE: merging what we cannot prove is
    // one would under-count a span and allow a cross-member call, which is the
    // unsafe direction for this consumer.
    const ghost = path.join(ws, 'nosuchdir');
    assert.deepEqual(dedupeMemberDirectories([ghost, path.join(ws, 'alsonone')]), [ghost, path.join(ws, 'alsonone')]);
  });
});

test('workspace members: identity matching does not resurrect an entry naming a FILE or a ghost directory', () => {
  withRoot((root) => {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    write(path.join(ws, 'package.json'), `${JSON.stringify({ name: 'ws' })}\n`);
    workspaceRoot(ws, ['api', 'ghost', 'notes']);
    const api = memberDir(ws, 'api');
    write(path.join(ws, 'notes'), 'a FILE, not a directory\n');
    const registry = readWorkspaceMemberRegistry(ws);

    assert.equal(enclosingRegisteredMember(ws, registry, path.join(api, 'src')), api, 'the real member still resolves');
    // A ghost entry keeps its pre-existing meaning: it claims a descendant
    // spelled the same way, and stats nothing. Nothing about identity matching
    // may widen or narrow that.
    assert.equal(enclosingRegisteredMember(ws, registry, path.join(ws, 'ghost', 'src')), path.join(ws, 'ghost'),
      'an entry naming no real directory still claims a target spelled the same way');
    assert.equal(enclosingRegisteredMember(ws, registry, path.join(ws, 'elsewhere')), null,
      'and claims nothing else');
    // A FILE cannot be a member: its inode must not enter the comparison set,
    // or a registry typo of a different shape would grant membership to
    // whatever else happens to be hard-linked to it.
    assert.equal(enclosingRegisteredMember(ws, registry, path.join(ws, 'notes')), path.join(ws, 'notes'),
      'the exact spelling is unchanged — this entry was always matched by name');
    const link = path.join(ws, 'notes-copy');
    fs.linkSync(path.join(ws, 'notes'), link);
    assert.equal(enclosingRegisteredMember(ws, registry, link), null,
      'but a second hard link to that file is NOT a member: only directories carry member identity');
  });
});

// ── 4. the population the mode never bounded ─────────────────────────────────
//
// `readWorkspaceMemberRegistry` decides ILLEGIBILITY two lines before it looks
// at `mode`, so `workspaceMembershipOf` answers `indeterminate` for ANY ancestor
// whose `.one.json` cannot be parsed — workspace or not. These three rows are
// the measurement behind property 2's correction: the shelter is real, it is
// wider than "a container", and it stops at the authority axis.

/** An ordinary git repository whose committed state file is merge-conflicted. */
function conflictedRepo(root: string): string {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  write(path.join(repo, 'package.json'), `${JSON.stringify({ name: 'repo' })}\n`);
  write(path.join(repo, '.traffic-one', '.one.json'),
    '<<<<<<< HEAD\n{"mode":"new-project"}\n=======\n{"mode":"existing-codebase"}\n>>>>>>> theirs\n');
  return repo;
}

/** A Go-package-shaped stray: leaked new-project state, no project marker of its own. */
function strayNestedRoot(parent: string): string {
  const stray = path.join(parent, 'strategies');
  write(path.join(stray, 'main.go'), 'package strategies\n');
  // Same shape as the historical mercury/strategies leak and
  // workspace-declaration.test.ts: `{ mode: 'new-project' }` without
  // onboardingComplete. Completed onboarding is project evidence
  // (`nestedRootHasProjectEvidence`) and would KEEP the tree even when the
  // resolver climbs — which is a different population than this leak.
  writeStateFile(stray, { mode: 'new-project' });
  return stray;
}

test('workspace members: an UNPARSEABLE ordinary ancestor shelters a stray beneath it from the sweep', () => {
  withRoot((root) => {
    const repo = conflictedRepo(root);
    const stray = strayNestedRoot(repo);
    // The shelter, stated as the resolver states it: the stray answers with
    // ITSELF, which is what retention's `resolveProjectRoot(dir) !== dir` reads
    // as KEEP.
    assert.equal(resolveProjectRoot(stray), stray,
      'a directory under an ancestor nobody could parse must resolve to itself — treating unreadable'
      + ' bytes as evidence that it is unregistered is the inversion this module refuses everywhere else');
    assert.deepEqual(plannedLeaks(root), [],
      'and the SessionStart sweep must therefore plan no deletion inside it');
    // NOT A WORKSPACE ANYWHERE IN THIS FIXTURE, which is the whole point of the
    // row: the sheltering ancestor carries no `mode: 'workspace'` and could not
    // be read to see whether it does.
    assert.equal(workspaceMembershipOf(stray).kind, 'indeterminate');
  });
});

test('workspace members: the LEGIBLE twin of that ancestor still reports the stray', () => {
  withRoot((root) => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(path.join(repo, 'package.json'), `${JSON.stringify({ name: 'repo' })}\n`);
    writeStateFile(repo, { mode: 'new-project', stack: 'default', onboardingComplete: true });
    const stray = strayNestedRoot(repo);

    // NON-VACUITY for the row above: the shelter is the unparseable file, not
    // the fixture. Same tree, one legible byte-range, and the leak comes back.
    assert.equal(resolveProjectRoot(stray), repo,
      'a stray inside a legible repository still climbs past itself');
    assert.deepEqual(plannedLeaks(root), [path.join('repo', 'strategies', '.traffic-one')],
      'and is still healed by the sweep — the mercury/strategies case, unchanged');
  });
});

test('workspace members: an unparseable ancestor withholds a deletion WITHOUT freezing the gates', () => {
  withRoot((root) => {
    const repo = conflictedRepo(root);
    // A legitimate, independently onboarded project under the same conflicted
    // ancestor. It is nobody's member and the ancestor is not a workspace.
    const app = memberDir(repo, 'app');
    writeStateFile(app, { mode: 'new-project', stack: 'default', onboardingComplete: true });

    const resolved = resolveProjectRootDetailed(app);
    assert.equal(resolved.root, app, 'it is its own root, as it always was');
    // THE AUTHORITY HALF IS NARROWED, and this row is why. Reporting a container
    // here engages the member fence, and an `illegible` registry resolves no
    // member — so every gated call in this project would be refused as
    // `workspace-member-unresolved` because a file one level up got
    // merge-conflicted. `opaque` still reports (it PARSED and said
    // `mode: 'workspace'`); `illegible` cannot say even that.
    assert.equal(resolved.workspaceContainer, '',
      'an ancestor whose mode nobody could read must not be reported as a workspace container');
    assert.equal(resolved.workspaceRegistry, null);
  });
});

test('workspace members: a MALFORMED registry is strictly worse than no registry, and the note says so', () => {
  withRoot((root) => {
    // The measurement behind the corrected note above `validateMemberEntry`.
    // Three containers, one member shape, one question: does the member resolve
    // to itself and keep a container-free scope?
    const rows: [label: string, plant: (ws: string) => void, container: string][] = [
      ['no registry at all', () => { /* nothing */ }, ''],
      ['a legible registry naming the member', (ws) => { workspaceRoot(ws, ['api']); }, 'ws'],
      ['a malformed registry', (ws) => {
        writeStateFile(ws, { mode: WORKSPACE_PROJECT_MODE, onboardingComplete: true, workspaceMembers: { api: true } });
      }, 'ws'],
    ];
    for (const [label, plant, expectContainer] of rows) {
      const ws = path.join(root, label.replace(/[^a-z]+/g, '-'));
      fs.mkdirSync(ws, { recursive: true });
      plant(ws);
      const api = memberDir(ws, 'api');
      writeStateFile(api, { mode: 'new-project', stack: 'default', onboardingComplete: true });
      const resolved = resolveProjectRootDetailed(api);
      assert.equal(resolved.root, api, `${label}: the member is its own root`);
      assert.equal(
        resolved.workspaceRegistry ? resolved.workspaceRegistry.kind : 'none',
        expectContainer ? (label.includes('malformed') ? 'opaque' : 'members') : 'none',
        label,
      );
    }
  });
});
