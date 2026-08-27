// CHARACTERIZATION of `resolveProjectRoot` and `isLeakedNestedRoot` against a
// multi-project polyglot WORKSPACE — one container directory holding several
// independent projects in different languages. It records what happens TODAY, so
// a later lane's P4 "workspace" change is visible as a diff rather than as an
// assertion written after the fact. Nothing here is a correction: rows that
// describe behaviour a workspace mode will have to move say so by name.
//
// `isLeakedNestedRoot` (shared/retention.ts:144) is module-private and has ONE
// caller, `listNestedTrafficOneDirs`, which only ever asks about a directory
// that already holds a `.traffic-one/.one.json`. So it is measured two ways and
// the difference is deliberate:
//   - by its BODY, `resolveProjectRoot(dir) !== dir`, asserted directly, and
//   - by its REACHABLE effect, the deletion actions `sweepTrafficOneRetention`
//     plans, which is the only way a verdict from it ever reaches a user.
// A row that only exercised the body would report leaks the sweep can never act
// on; a row that only exercised the sweep could not tell a false predicate from
// an unreachable one.
//
// CANONICALITY. The predicate is a STRING compare against its own input, and the
// resolvers deliberately never realpath their exits (shared/hook/paths.ts:258-277)
// precisely so a project reached by a non-canonical spelling keeps equalling its
// own directory. Every row below therefore states which spelling it measured:
// the default rows realpath the temp root so a `/var` vs `/private/var` mismatch
// can never manufacture a finding, and the non-canonical row builds its own
// SYMLINK rather than relying on `os.tmpdir()` being a symlink — which it is on
// macOS and is not on Linux, so a tmpdir-derived opt-out is a platform coin flip
// rather than a measurement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isRegisteredWorkspaceMember, resolveProjectRoot, workspaceMembershipOf } from '../../shared/hook/paths';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { dirOwnsProject } from '../../shared/project-membership';
import { sweepTrafficOneRetention } from '../../shared/retention';
import {
  HARNESS_TOOLCHAINS,
  buildPolyglotWorkspace,
  failedPreconditions,
  polyglotPreconditions,
  type PolyglotWorkspace,
  type PolyglotWorkspaceOptions,
} from './polyglot-workspace';

const TMP_PREFIX = 't1-polyglot-workspace-';

interface Harness {
  readonly root: string;
  readonly created: string;
}

function makeRoot(): Harness {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  return { created, root: fs.realpathSync(created) };
}

/** Read every fixture precondition back, and fail as a FIXTURE error naming what changed. */
function readbackFixture(workspace: PolyglotWorkspace, label: string): void {
  for (const [name, actual, expected] of polyglotPreconditions(workspace)) {
    assert.deepEqual(actual(), expected, `FIXTURE [${label}] ${name}`);
  }
  assert.deepEqual(failedPreconditions(workspace), [], `FIXTURE [${label}] preconditions`);
}

/**
 * The body of shared/retention.ts isLeakedNestedRoot, verbatim — including the
 * `membership` authority, which is the whole difference between what the sweep
 * asks and what a gate asks. A copy that dropped it would measure the resolver
 * and report it as the deleter.
 */
function leakedByPredicate(dir: string): boolean {
  const resolved = path.resolve(dir);
  try {
    return resolveProjectRoot(resolved, undefined, { workspaceAuthority: 'membership' }) !== resolved;
  } catch {
    return false;
  }
}

/**
 * Layer D leftover when membership is null and there is no `.git`.
 * `prefsCapableRoot` remaps a one-level child of a manifest parent (`src/`,
 * `reporting_etl/`) to the owning member. A two-level package
 * (`internal/ledger`) has no enclosing membership hop — parent `internal` owns
 * nothing, ancestor absorb is VCS-only — so the nested dir stays itself and a
 * container+file-hint call stays on the container cwd.
 */
function recordedNoVcsAnswers(
  workspace: PolyglotWorkspace,
  member: PolyglotWorkspace['members'][number],
): { nested: string; hintedFromContainer: string } {
  const remaps = path.dirname(member.nestedSourceDir) === member.dir;
  return {
    nested: remaps ? member.dir : member.nestedSourceDir,
    hintedFromContainer: remaps ? member.dir : workspace.container,
  };
}

/** The deletion actions the sweep plans for nested state roots, relative to the container. */
function plannedNestedLeaks(container: string): string[] {
  return sweepTrafficOneRetention(container, { dryRun: true }).actions
    .filter((action) => action.reason.includes('leaked nested'))
    .map((action) => path.relative(container, action.path))
    .sort();
}

function withWorkspace(
  options: PolyglotWorkspaceOptions,
  body: (workspace: PolyglotWorkspace, root: string) => void,
): void {
  const { created, root } = makeRoot();
  try {
    body(buildPolyglotWorkspace(path.join(root, 'workspace'), options), root);
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
  }
}

const ONBOARDED_MEMBERS: PolyglotWorkspaceOptions = { onboardMembers: true, memberVcs: true };

// ── the fixture is what it claims ────────────────────────────────────────────

test('polyglot workspace fixture: the shape is three independently owned projects in three languages', () => {
  withWorkspace(ONBOARDED_MEMBERS, (workspace, root) => {
    readbackFixture(workspace, 'baseline');

    assert.equal(workspace.container, fs.realpathSync(workspace.container),
      'FIXTURE the container path is canonical, so a /var vs /private/var mismatch cannot manufacture a finding');
    assert.equal(root, fs.realpathSync(root), 'FIXTURE the temp root is canonical');

    for (const member of workspace.members) {
      assert.equal(dirOwnsProject(member.dir), true,
        `FIXTURE ${member.id} must own a project through its own manifest`);
      assert.equal(isNonProjectRoot(member.dir), false,
        `FIXTURE ${member.id} must not be machine-config space or the plugin authoring root`);
    }
    assert.equal(dirOwnsProject(workspace.container), false,
      'FIXTURE the container owns no manifest and no version control of its own — it is a container, not a project');
    assert.equal(isNonProjectRoot(workspace.container), false,
      'FIXTURE the container must not be machine-config space either');
  });
});

// A fixture that silently stops being polyglot is worse than no fixture, so the
// precondition list has to be able to SAY so. This drives it from the negative
// direction, because a readback nobody has seen fail is a readback nobody has
// tested.
test('polyglot workspace fixture: a member that stops being its own language fails as a FIXTURE error', () => {
  withWorkspace(ONBOARDED_MEMBERS, (workspace) => {
    assert.deepEqual(failedPreconditions(workspace), []);

    const go = workspace.members.find((member) => member.toolchain === 'go')!;
    fs.rmSync(go.manifestPath);
    fs.writeFileSync(path.join(go.dir, 'package.json'), '{"name":"ledger-api"}\n', 'utf8');

    const failures = failedPreconditions(workspace);
    assert.ok(failures.length > 0, 'a member that lost its manifest must fail the preconditions');
    assert.ok(
      failures.some((failure) => failure.includes('DISTINCT')),
      `the failure must name the lost polyglot shape; got ${JSON.stringify(failures)}`,
    );
    assert.ok(
      failures.some((failure) => failure.includes('the manifest its spec declares')),
      `the failure must name the missing manifest; got ${JSON.stringify(failures)}`,
    );
  });
});

// The composer question, answered as an assertion rather than as prose: the
// fixture is buildable from the toolchains a --strict run already has.
test('polyglot workspace fixture: needs no toolchain beyond node, go and python3', () => {
  withWorkspace(ONBOARDED_MEMBERS, (workspace) => {
    readbackFixture(workspace, 'toolchains');
    assert.deepEqual([...HARNESS_TOOLCHAINS].sort(), ['go', 'node', 'python3']);
    for (const member of workspace.members) {
      assert.ok(
        (HARNESS_TOOLCHAINS as readonly string[]).includes(member.toolchain),
        `${member.id} would add ${member.toolchain} as a machine prerequisite for a --strict run`,
      );
    }
    assert.equal(
      workspace.members.some((member) => member.manifest === 'composer.json'),
      false,
      'no member is a PHP project, so `composer` is not a prerequisite of this fixture',
    );
  });
});

// ── what the resolvers answer today ──────────────────────────────────────────

test('polyglot workspace: every onboarded member resolves to ITSELF from every entry point', () => {
  withWorkspace(ONBOARDED_MEMBERS, (workspace) => {
    readbackFixture(workspace, 'members-resolve-to-self');

    for (const member of workspace.members) {
      assert.equal(resolveProjectRoot(member.dir), member.dir,
        `${member.id}: cwd at the member`);
      assert.equal(resolveProjectRoot(member.nestedSourceDir), member.dir,
        `${member.id}: cwd in a nested source dir that owns no marker`);
      assert.equal(resolveProjectRoot(member.dir, member.nestedSourcePath), member.dir,
        `${member.id}: cwd at the member with a nested file hint`);
      assert.equal(resolveProjectRoot(workspace.container, member.nestedSourcePath), member.dir,
        `${member.id}: cwd at the CONTAINER with a file hint into the member`);
      assert.equal(
        resolveProjectRoot(member.dir, member.nestedSourcePath, { ceiling: workspace.container }),
        member.dir,
        `${member.id}: with the container as the host workspace ceiling (the multi-root window shape)`,
      );
    }

    // The container is nobody's project and adopts nothing from its members.
    const containerRoot = resolveProjectRoot(workspace.container);
    assert.equal(containerRoot, workspace.container);
    for (const member of workspace.members) {
      assert.notEqual(containerRoot, member.dir);
    }
  });
});

test('polyglot workspace: no member is a leaked nested root, by predicate or by sweep', () => {
  withWorkspace(ONBOARDED_MEMBERS, (workspace) => {
    readbackFixture(workspace, 'no-leak');

    for (const member of workspace.members) {
      assert.equal(leakedByPredicate(member.dir), false,
        `${member.id}: resolveProjectRoot(dir) !== dir is what marks a nested .traffic-one for deletion`);
    }
    assert.deepEqual(plannedNestedLeaks(workspace.container), [],
      'the SessionStart retention sweep run from the container must plan no deletions');
  });
});

// The load-bearing non-canonical row. Built from an explicit symlink rather than
// from `os.tmpdir()`, so it measures the same thing on macOS and on Linux.
test('polyglot workspace [non-canonical]: a member reached through a symlink still equals itself', () => {
  const { created, root } = makeRoot();
  try {
    const real = path.join(root, 'real');
    const workspace = buildPolyglotWorkspace(path.join(real, 'workspace'), ONBOARDED_MEMBERS);
    readbackFixture(workspace, 'non-canonical/real');

    const link = path.join(root, 'link');
    fs.symlinkSync(real, link);
    const linked = buildPolyglotWorkspace(path.join(link, 'workspace'), ONBOARDED_MEMBERS);

    assert.equal(fs.lstatSync(link).isSymbolicLink(), true,
      'FIXTURE the alias must be a symlink, not a copy');
    assert.notEqual(linked.container, fs.realpathSync(linked.container),
      'FIXTURE the aliased container must NOT be canonical, or this row measures the same thing as the row above');
    assert.equal(fs.realpathSync(linked.container), workspace.container,
      'FIXTURE both spellings must reach one directory');

    for (const member of linked.members) {
      assert.equal(resolveProjectRoot(member.dir), member.dir,
        `${member.id}: an exit that canonicalized would answer the /real spelling here, and the deletion predicate`
        + ' compares BY STRING — every member of a symlinked workspace would become a deletion candidate');
      assert.equal(leakedByPredicate(member.dir), false, `${member.id}: not a leak through the alias either`);
    }
    assert.deepEqual(plannedNestedLeaks(linked.container), [],
      'the sweep run through the alias must plan no deletions either');
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
  }
});

// ── recorded characterizations a workspace mode will have to move ────────────

/**
 * A container `package.json` carrying ANY non-empty `workspaces` array still
 * collapses the whole workspace onto the container for RESOLUTION — even when
 * the glob matches none of the members and two of them are not npm packages at
 * all. It no longer marks their state for deletion.
 *
 * This row USED to record all three members as planned deletions, and it was
 * the measurement that forced the split. `dirDeclaresWorkspace`
 * (hook/paths.ts:182-203) asks only whether the ANCESTOR declares workspaces; it
 * never reads the glob, and never asks what language the member is. That
 * leniency is right for resolution — "the cost of a false positive is resolving
 * up one level" — and was catastrophic once `isLeakedNestedRoot` turned the same
 * answer into a deletion plan for three independently onboarded projects.
 *
 * So the two halves are now asserted SEPARATELY and they deliberately disagree:
 * resolution still climbs to the container, and the sweep plans nothing. A
 * change that "fixed" this by making resolution glob-aware would make both rows
 * say `member.dir`, and would hand back the stray-minting failure the leniency
 * exists to prevent — so the disagreement below is the contract, not a seam.
 */
test('polyglot workspace: a container `workspaces` glob that matches NO member collapses resolution but grants no deletion', () => {
  withWorkspace(
    { ...ONBOARDED_MEMBERS, containerPackageJson: { name: 'workspace', private: true, workspaces: ['packages/*'] } },
    (workspace) => {
      readbackFixture(workspace, 'npm-workspaces-glob');
      assert.equal(
        fs.existsSync(path.join(workspace.container, 'packages')), false,
        'FIXTURE the declared glob must match nothing on disk, or the row measures an ordinary monorepo',
      );

      for (const member of workspace.members) {
        assert.equal(resolveProjectRoot(member.dir), workspace.container,
          `${member.id}: resolution is UNCHANGED — it still climbs past its own mode-bearing state to the container`);
        assert.equal(leakedByPredicate(member.dir), false,
          `${member.id}: but the declaration claims no member, so it carries no deletion authority`);
      }
      assert.deepEqual(
        plannedNestedLeaks(workspace.container), [],
        'the SessionStart sweep must plan no deletions: `packages/*` matches none of these three, and two of them'
        + ' (Go, Python) could not be npm workspace members under any reading of that declaration',
      );
    },
  );
});

/**
 * The other side of the same coin, and the reason the fix is not "read the
 * glob": a declaration whose member list cannot be established keeps its
 * resolution leniency and loses its deletion authority. Failing in opposite
 * directions for the two consumers is the point — a hook that guesses wrong
 * about resolution mints a stray `.traffic-one` the next sweep heals, and a
 * sweep that guesses wrong reclaims a real member's run history and its
 * `.one.json`, neither of which anything regenerates. The member's durable
 * documents outlive that much — retention.ts carves them out of the heal by
 * name — so what a wrong guess costs is the project's identity and its record
 * of what it built, not its product.md.
 */
test('polyglot workspace: an UNPARSEABLE container declaration still anchors resolution and still grants no deletion', () => {
  withWorkspace(ONBOARDED_MEMBERS, (workspace) => {
    readbackFixture(workspace, 'unparseable-declaration');
    // `packages:` holding a MAP rather than a list — a shape the hand-written
    // reader declines rather than guesses at (no YAML parser may reach the hook
    // runtime). Written after the readback so the fixture's own assertion that
    // the container declares no npm workspace still holds.
    fs.writeFileSync(path.join(workspace.container, 'pnpm-workspace.yaml'), 'packages:\n  foo:\n    bar: 1\n', 'utf8');

    for (const member of workspace.members) {
      assert.equal(resolveProjectRoot(member.dir), workspace.container,
        `${member.id}: an unreadable declaration is STILL a declaration, and still anchors resolution`);
      assert.equal(leakedByPredicate(member.dir), false,
        `${member.id}: "we could not tell" must never resolve to the irreversible act`);
    }
    assert.deepEqual(plannedNestedLeaks(workspace.container), [],
      'before the split this shape planned all three deletions off a declaration nobody could read');
  });
});

/**
 * BEFORE anything is onboarded, and with NO workspace registered, membership of
 * a marker-less nested source dir is still null (VCS-only absorb — members have
 * no `.git` in this half). Resolution then follows `prefsCapableRoot` of the
 * start: a one-level child (`src/`, `reporting_etl/`) remaps to the enclosing
 * owning member (`member.dir`). A two-level Go package (`internal/ledger`) does
 * not — `prefsCapableRoot` asks membership of the parent only, `internal` owns
 * nothing, and ancestor absorb stays VCS-only — so the nested dir remains
 * itself. The container+file-hint row follows that remap when it happens;
 * otherwise the container cwd stays (not necessarily the container for every
 * member).
 *
 * Membership still does not absorb via ancestor manifests. The VCS half below
 * is unchanged: version control alone already moved both answers onto the member.
 */
test('polyglot workspace [recorded]: with no workspace registered, only version control anchors a member', () => {
  withWorkspace({ memberVcs: false }, (workspace) => {
    readbackFixture(workspace, 'pre-onboarding/no-vcs');
    for (const member of workspace.members) {
      const recorded = recordedNoVcsAnswers(workspace, member);
      assert.equal(resolveProjectRoot(member.nestedSourceDir), recorded.nested,
        `${member.id}: a marker-less source dir follows prefsCapableRoot`
        + (recorded.nested === member.dir
          ? ' to the owning member'
          : '; a deeper package has no enclosing membership hop'));
      assert.equal(
        resolveProjectRoot(workspace.container, member.nestedSourcePath),
        recorded.hintedFromContainer,
        `${member.id}: pre-onboarding resolution follows prefsCapableRoot to the owning member;`
        + ' membership still does not absorb via ancestor manifests',
      );
    }
  });

  withWorkspace({ memberVcs: true }, (workspace) => {
    readbackFixture(workspace, 'pre-onboarding/vcs');
    for (const member of workspace.members) {
      assert.equal(resolveProjectRoot(member.nestedSourceDir), member.dir,
        `${member.id}: version control alone moves both answers onto the member`);
      assert.equal(resolveProjectRoot(workspace.container, member.nestedSourcePath), member.dir,
        `${member.id}: and the container-level cwd follows it`);
    }
  });
});

/**
 * THE ROW THAT USED TO BE A SIMULATION.
 *
 * `mode: 'workspace'` plus a members registry is the P4 workspace project, and
 * it is what makes the three members anchor without version control, without a
 * language the resolver understands, and without a `workspaces` glob that could
 * never have named two of them. Mutation M9 asserted this by patching the
 * resolver; it is asserted here against the shipped one.
 *
 * The fixture is deliberately the WEAKEST possible member: no `.git`, no
 * `.one.json`, and a source file in a subdirectory owning no marker at all. That
 * is the exact shape the row above records as resolving to the container, so
 * the difference between the two rows is the registry and nothing else.
 *
 * Note what does NOT change: the container still resolves to itself, and no
 * member becomes a deletion candidate. The registry moves resolution DOWN, never
 * a project's state off its own directory.
 */
test('polyglot workspace: a registered member anchors with no version control and no state of its own', () => {
  withWorkspace({ memberVcs: false, registerMembers: true }, (workspace) => {
    readbackFixture(workspace, 'workspace-mode/registered');

    for (const member of workspace.members) {
      assert.equal(fs.existsSync(path.join(member.dir, '.git')), false,
        `FIXTURE ${member.id} must own no version control, or this row measures the recorded row above`);
      assert.equal(fs.existsSync(path.join(member.dir, '.traffic-one')), false,
        `FIXTURE ${member.id} must not be onboarded`);

      assert.equal(resolveProjectRoot(member.nestedSourceDir), member.dir,
        `${member.id}: a marker-less source dir inside a REGISTERED member resolves to the member`);
      assert.equal(resolveProjectRoot(workspace.container, member.nestedSourcePath), member.dir,
        `${member.id}: and the container-level cwd — the moment onboarding is offered — follows it,`
        + ' so the wizard is offered for the member rather than for the container');
      assert.equal(resolveProjectRoot(member.dir), member.dir, `${member.id}: cwd at the member`);
      assert.equal(
        resolveProjectRoot(member.dir, member.nestedSourcePath, { ceiling: workspace.container }),
        member.dir,
        `${member.id}: with the container as the host workspace ceiling (the multi-root window shape)`,
      );
      assert.equal(isRegisteredWorkspaceMember(member.dir), true, `${member.id}: and it says so as a predicate`);
      assert.equal(isRegisteredWorkspaceMember(member.nestedSourceDir), false,
        `${member.id}: while a directory inside it is not itself a member`);
    }

    assert.equal(resolveProjectRoot(workspace.container), workspace.container,
      'the workspace is still its own root and adopts none of its members');
    assert.equal(isRegisteredWorkspaceMember(workspace.container), false,
      'a workspace is never its own member');
    assert.deepEqual(plannedNestedLeaks(workspace.container), [],
      'and registering members plans no deletion of anything');
  });

  // The same registry over members that ARE independently onboarded: every one
  // of them keeps its own state, and none becomes a leak.
  withWorkspace({ ...ONBOARDED_MEMBERS, registerMembers: true }, (workspace) => {
    readbackFixture(workspace, 'workspace-mode/onboarded');
    for (const member of workspace.members) {
      assert.equal(resolveProjectRoot(member.dir), member.dir, `${member.id}: still its own root`);
      assert.equal(leakedByPredicate(member.dir), false, `${member.id}: still not a leak`);
      assert.equal(isRegisteredWorkspaceMember(member.dir), true, `${member.id}: and now registered as well`);
    }
    assert.deepEqual(plannedNestedLeaks(workspace.container), []);
  });
});

/**
 * The registry is the WORKSPACE's word, and an illegible workspace has no word.
 *
 * Same direction as the declaration reader's `opaque` arm, arrived at from the
 * other side: there an unreadable declaration keeps its resolution leniency and
 * loses its deletion authority, and here an unreadable workspace grants no
 * membership at all. A torn registry still grants no membership; resolution
 * falls through to prefsCapableRoot of the file's start — the owning member
 * when that remaps, otherwise the container cwd.
 */
test('polyglot workspace: a TORN workspace state registers nobody, and says so as ignorance', () => {
  withWorkspace({ memberVcs: false, registerMembers: true }, (workspace) => {
    readbackFixture(workspace, 'workspace-mode/before-tearing');
    fs.writeFileSync(
      path.join(workspace.container, '.traffic-one', '.one.json'),
      '{ "mode": "workspace", "workspaceMembers": [\n',
      'utf8',
    );

    for (const member of workspace.members) {
      assert.equal(workspaceMembershipOf(member.dir).kind, 'indeterminate',
        `${member.id}: a torn workspace state must not be reported as "not a member"`);
      assert.equal(isRegisteredWorkspaceMember(member.dir), false,
        `${member.id}: and the boolean grants nothing on an answer nobody established`);
      assert.equal(
        resolveProjectRoot(workspace.container, member.nestedSourcePath),
        recordedNoVcsAnswers(workspace, member).hintedFromContainer,
        `${member.id}: a torn registry still grants no membership; resolution falls through`
        + " to prefsCapableRoot of the file's start, which is the owning member"
        + ' when that remaps',
      );
    }
    assert.deepEqual(plannedNestedLeaks(workspace.container), [],
      'and an unreadable workspace never authorizes a deletion');
  });
});

/**
 * A git umbrella around the members is NOT the npm-workspaces shape: the members
 * keep their own roots and none is a deletion candidate. Recorded because it is
 * the layout a "workspace" most resembles on disk, and it is the one that
 * already behaves the way a workspace mode would want.
 */
test('polyglot workspace [recorded]: a git umbrella container leaves every member its own root', () => {
  withWorkspace({ ...ONBOARDED_MEMBERS, containerVcs: true, onboardContainer: true }, (workspace) => {
    readbackFixture(workspace, 'git-umbrella');
    for (const member of workspace.members) {
      assert.equal(resolveProjectRoot(member.dir), member.dir);
      assert.equal(leakedByPredicate(member.dir), false);
    }
    assert.deepEqual(plannedNestedLeaks(workspace.container), []);
  });
});
