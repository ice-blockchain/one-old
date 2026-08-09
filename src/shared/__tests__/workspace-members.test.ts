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
import {
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
    assert.equal(workspaceMembershipOf(out).kind, 'not-member',
      'and it is a POSITIVE negative, not an inability: the registry was perfectly legible');

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
    ['every pattern is a .traffic-one entry', () => authority.every((l) => l.startsWith('.traffic-one/')), true],
  ]);

  assert.equal(derived.length, authority.length,
    're-anchoring must not add or drop an entry — the authority decides WHAT git may ignore, this decides WHERE');
  assert.deepEqual(derived, authority.map((line) => `**/${line}`),
    'each pattern gains git’s match-in-all-directories prefix and nothing else');
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
