// `writeState`'s creation-time veto and the third clause it was always missing.
//
// THE VETO: a directory that is not itself a project must not CREATE state when
// an enclosing project already exists — otherwise a Go package, a `docs/` folder
// or a build subdirectory quietly becomes its own project. Two clauses excused a
// directory from it: it already owns state, or `dirOwnsProject` says it is a
// project. The third, added here, is that it DECLARES A WORKSPACE.
//
// WHY IT WAS INVISIBLE UNTIL NOW. npm and yarn declare `workspaces` inside
// `package.json`, which is also a `MANIFEST_MARKERS` entry, so `dirOwnsProject`
// said yes for a reason that had nothing to do with the declaration and the
// container was excused by accident. A Gradle aggregator (`settings.gradle` with
// no build file) and a pnpm container (`pnpm-workspace.yaml` with no
// `package.json`) are DECLARATION-ONLY, and they were refused the state that
// records their own members.
//
// WHAT THE CLAUSE MUST NOT DO, pinned as hard as the fix itself: confer
// projecthood. `dirOwnsProject` must keep answering false for these containers.
// Moving the declaration into ownership instead is the inversion this codebase
// removed — the file that ENUMERATES members would be claiming to BE one, and
// every submodule would re-anchor at itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { statePath, writeState } from '../normalize';
import { dirDeclaresWorkspace } from '../../hook/workspace-declaration';
import { dirOwnsProject } from '../../project-membership';
import { registerWorkspaceMember } from '../workspace-members';
import { resolveProjectRoot } from '../../hook/paths';
import { resetAuthoringRootCache } from '../../authoring-root';
import { resetPluginUseCache } from '../plugin-use';

process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

const TMP_PREFIX = 't1-declaration-container-';

/** A repository holding a nested directory — the shape where the veto applies at all. */
function withHolder(body: (holder: string) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  resetAuthoringRootCache();
  resetPluginUseCache();
  try {
    const holder = fs.realpathSync(created);
    fs.mkdirSync(path.join(holder, '.git'), { recursive: true });
    body(holder);
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
    resetAuthoringRootCache();
    resetPluginUseCache();
  }
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

function container(holder: string, files: Record<string, string>): string {
  const dir = path.join(holder, 'build');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) write(path.join(dir, name), body);
  return dir;
}

const CONTAINER_STATE = { mode: 'workspace', onboardingComplete: true };

const DECLARATION_ONLY: Array<[string, Record<string, string>]> = [
  ['Gradle aggregator (settings.gradle)', { 'settings.gradle': "include 'svc'\n" }],
  ['Gradle aggregator (settings.gradle.kts)', { 'settings.gradle.kts': 'include("svc")\n' }],
  ['pnpm container with no package.json', { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' }],
];

test('state veto: a DECLARATION-ONLY container nested in a repository may hold its state', () => {
  // The regression, measured: before the clause each of these came back `false`
  // with nothing on disk, so the container could not record who its members were
  // — while the identical layout at a repository ROOT worked, because `.git`
  // made `dirOwnsProject` true for an unrelated reason.
  for (const [label, files] of DECLARATION_ONLY) {
    withHolder((holder) => {
      const dir = container(holder, files);

      assert.equal(dirDeclaresWorkspace(dir), true, label);
      assert.equal(writeState(dir, CONTAINER_STATE), true, `${label}: state must be permitted`);
      assert.equal(fs.existsSync(statePath(dir)), true, `${label}: and must actually land`);
    });
  }
});

test('state veto: the clause grants CONTAINER state, never projecthood', () => {
  // The inversion fence. If somebody "simplifies" this by teaching
  // `dirOwnsProject` about the declaration files instead, this dies — which is
  // the point, because that change re-anchors every submodule at itself.
  for (const [label, files] of DECLARATION_ONLY) {
    withHolder((holder) => {
      const dir = container(holder, files);
      assert.equal(dirOwnsProject(dir), false,
        `${label}: declaring members is not being one`);
    });
  }
});

test('state veto: a declaring container registers members, and they anchor at the container until they own state', () => {
  withHolder((holder) => {
    const dir = container(holder, { 'settings.gradle': "include 'svc'\n" });
    const member = path.join(dir, 'svc');
    write(path.join(member, 'build.gradle'), '\n');
    write(path.join(member, 'src', 'main', 'java', 'A.java'), 'class A {}\n');

    // Anchoring is the pre-registration answer, and it is what the M2 fix bought:
    // the submodule belongs to the root that declares it.
    assert.equal(
      resolveProjectRoot(dir, path.join(member, 'src', 'main', 'java', 'A.java')),
      dir,
      'before anyone registers anything, the deep file belongs to the declaring root',
    );

    assert.equal(writeState(dir, CONTAINER_STATE), true);
    assert.equal(registerWorkspaceMember(dir, 'svc').outcome, 'registered',
      'which is the whole thing the container was being refused the state for');
  });
});

test('state veto: what a declaration earns is CONTAINER state and only that', () => {
  // The clause read `dirDeclaresWorkspace(cwd)` on its own, which made it wider
  // than the sentence above it: measured, an ordinary project state landed at a
  // declaration-only aggregator nested in a repository, and resolution then
  // anchored every file beneath it at the aggregator instead of the repository —
  // a repository split by a file whose only job was to enumerate members. Not an
  // oscillation (the retention sweep keeps such a state, so nothing deleted it
  // afterwards), which is exactly why nothing was going to notice.
  const modes: Array<[string, Record<string, unknown>, boolean]> = [
    ['the container state it was added for', CONTAINER_STATE, true],
    ['an ordinary existing-codebase project', { mode: 'existing-codebase', stack: 'minimal', onboardingComplete: true }, false],
    ['an ordinary new-project', { mode: 'new-project', stack: 'minimal', onboardingComplete: true }, false],
    ['a state with no mode at all', { stack: 'minimal' }, false],
  ];
  for (const [label, files] of DECLARATION_ONLY) {
    for (const [modeLabel, body, permitted] of modes) {
      withHolder((holder) => {
        const dir = container(holder, files);
        assert.equal(writeState(dir, body), permitted, `${label} / ${modeLabel}`);
        assert.equal(fs.existsSync(statePath(dir)), permitted, `${label} / ${modeLabel}: and on disk`);
      });
    }
  }
});

test('state veto: what it still refuses is unchanged', () => {
  const refused: Array<[string, Record<string, string>]> = [
    ['a bare directory', {}],
    ['a directory holding only source', { 'main.go': 'package main\n' }],
    ['a docs folder', { 'index.md': '# docs\n' }],
    ['an EMPTY npm workspaces array (not a declaration)', { 'package.json': '{"name":"x","workspaces":[]}\n' }],
  ];
  for (const [label, files] of refused) {
    withHolder((holder) => {
      const dir = container(holder, files);
      const declares = dirDeclaresWorkspace(dir);
      const owns = dirOwnsProject(dir);
      // The last row carries a package.json, so it is a project by MARKER and is
      // excused by the SECOND clause — the assertion that matters there is that
      // the declaration clause is not what let it through.
      assert.equal(declares, false, `${label}: declares nothing`);
      assert.equal(writeState(dir, CONTAINER_STATE), owns,
        `${label}: permitted only if it owns a project, never for declaring one`);
    });
  }
});

test('state veto: a directory that already owns state keeps updating, declaration or not', () => {
  // The incumbent first clause, unmoved. Re-asserted here because the new clause
  // sits in the same boolean and an edit that reorders it could swallow this.
  withHolder((holder) => {
    const dir = container(holder, { 'notes.md': '# nothing\n' });
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(statePath(dir), '{"mode":"existing-codebase","stack":"minimal"}\n', 'utf8');

    assert.equal(dirDeclaresWorkspace(dir), false);
    assert.equal(dirOwnsProject(dir), false);
    assert.equal(writeState(dir, { mode: 'existing-codebase', stack: 'minimal', onboardingComplete: true }), true,
      'an already-strayed root can still be written until the retention sweep heals it');
  });
});

test('state veto: with no enclosing project the veto never applies at all', () => {
  // The third operand. A container that is not inside anything was always
  // permitted, and must not start depending on the declaration clause.
  const created = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  resetAuthoringRootCache();
  resetPluginUseCache();
  try {
    const solo = path.join(fs.realpathSync(created), 'solo');
    fs.mkdirSync(solo, { recursive: true });
    write(path.join(solo, 'notes.md'), '# nothing\n');
    assert.equal(writeState(solo, CONTAINER_STATE), true);
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
    resetAuthoringRootCache();
    resetPluginUseCache();
  }
});
