// CHARACTERIZATION of `resolveProjectRoot` and `isLeakedNestedRoot` against a
// multi-project polyglot WORKSPACE — one container directory holding several
// independent projects in different languages. It records what happens TODAY, so
// a later lane's P4 "workspace" change is visible as a diff rather than as an
// assertion written after the fact. Nothing here is a correction: rows that
// describe behaviour a workspace mode will have to move say so by name.
//
// `isLeakedNestedRoot` (shared/retention.ts:118) is module-private and has ONE
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
// resolvers deliberately never realpath their exits (shared/hook/paths.ts:215-234)
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

import { resolveProjectRoot } from '../../shared/hook/paths';
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

/** The body of shared/retention.ts isLeakedNestedRoot, verbatim. */
function leakedByPredicate(dir: string): boolean {
  const resolved = path.resolve(dir);
  try {
    return resolveProjectRoot(resolved) !== resolved;
  } catch {
    return false;
  }
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
 * A container `package.json` carrying ANY non-empty `workspaces` array collapses
 * the whole workspace onto the container and marks all three members' state for
 * deletion — even when the glob matches none of them and two of them are not npm
 * packages at all.
 *
 * `dirDeclaresWorkspace` (hook/paths.ts:151-160) asks only whether the ANCESTOR
 * declares workspaces; it never reads the glob, and never asks what language the
 * member is. The leniency is documented and deliberate — "the cost of a false
 * positive is resolving up one level" — but in this shape the cost is not one
 * level: `isLeakedNestedRoot` turns the same answer into a deletion plan for
 * three independently onboarded projects. Recorded, not corrected.
 */
test('polyglot workspace [recorded]: a container `workspaces` glob that matches NO member still collapses all three', () => {
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
          `${member.id}: climbs past its own mode-bearing state to the container`);
        assert.equal(leakedByPredicate(member.dir), true,
          `${member.id}: and is therefore judged a leaked nested root`);
      }
      assert.deepEqual(
        plannedNestedLeaks(workspace.container),
        ['ledger-api/.traffic-one', 'reporting-etl/.traffic-one', 'storefront-web/.traffic-one'],
        'all three members are planned for deletion by the SessionStart sweep',
      );
    },
  );
});

/**
 * BEFORE anything is onboarded, whether a member resolves to itself depends
 * entirely on whether it is a git repository — its language manifest does not
 * decide it.
 *
 * `projectMembershipRoot` (project-membership.ts:78) accepts a manifest for the
 * START dir but only VERSION CONTROL for an ANCESTOR, so a tool touching
 * `<member>/internal/ledger/ledger.go` in a member with no `.git` finds no
 * owner: the nested directory becomes its own root, and a hook whose cwd is the
 * container adopts the CONTAINER. That is the moment onboarding is offered, so
 * it decides which directory a workspace member's `.one.json` is written into.
 */
test('polyglot workspace [recorded]: pre-onboarding, only version control anchors a member', () => {
  withWorkspace({ memberVcs: false }, (workspace) => {
    readbackFixture(workspace, 'pre-onboarding/no-vcs');
    for (const member of workspace.members) {
      assert.equal(resolveProjectRoot(member.nestedSourceDir), member.nestedSourceDir,
        `${member.id}: a marker-less source dir becomes its own project root`);
      assert.equal(resolveProjectRoot(workspace.container, member.nestedSourcePath), workspace.container,
        `${member.id}: a container-level cwd with a file hint into the member adopts the CONTAINER`);
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
