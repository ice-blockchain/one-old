// The ecosystems `MANIFEST_MARKERS` used to omit, the ones that are a PATTERN
// rather than a name, the one that is a DEPENDENCY LIST rather than a manifest,
// and the one that was never a manifest at all.
//
// WHY THIS LIST IS A DATA-LOSS-ADJACENT LIST, not a nicety: `dirOwnsProject` is
// the test BOTH state writers use to decide whether a directory may hold state
// of its own (state/normalize.ts writeState, state/local-prefs/prefs-store.ts
// updateProjectPrefs). A directory it answers `false` for, inside a repository,
// is refused at CREATION time — no `.one.json`, and no per-project preferences
// bucket either, so not even the use-plugin consent answer can be recorded.
// Under a Traffic One workspace that is terminal: the member is never `done`,
// and onboarding-server/flow.ts holds the whole container at `members-pending`
// forever waiting for it.
//
// AND WHY IT IS *THIS* LIST AND NOT shared/paths.ts's `PROJECT_MARKERS`, which
// is deliberately NOT widened here: `findUp` returns the NEAREST marker-bearing
// ancestor, so a name added there re-roots a repository onto whichever
// subdirectory happens to carry it during the pre-`mode` window — and once
// `mode` commits there, the split is permanent. One of the tests below is the
// pin for that: a `pom.xml` sub-module still resolves to its repository.
//
// THE LIST HAS THREE STRENGTHS NOW, and the middle one is the correction this
// round makes. A STRONG marker declares a project. A WEAK marker
// (`requirements.txt`) names dependencies and only declares a project when no
// ancestor holds a strong one. And `settings.gradle(.kts)` is neither: it
// declares MEMBERS, so it lives in hook/paths.ts `dirDeclaresWorkspace` and is
// asserted ABSENT from this list below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  MANIFEST_MARKERS,
  MANIFEST_SUFFIX_MARKERS,
  WEAK_MANIFEST_MARKERS,
  dirOwnsProject,
  projectMembershipRoot,
} from '../project-membership';
import { resetAuthoringRootCache } from '../authoring-root';
import { projectRoot } from '../paths';
import { isRegisteredWorkspaceMember, isUnclaimedWorkspaceSubPackage, resolveProjectRoot } from '../hook/paths';
import { WORKSPACE_PROJECT_MODE } from '../hook/workspace-members';
import { statePath, writeState } from '../state/normalize';
import { projectPrefsPath, updateProjectPrefs } from '../state/local-prefs/prefs-store';
import { resetPluginUseCache } from '../state/plugin-use';

// The write fence (shared/fsjson.ts) refuses every `.traffic-one/**` write while
// the use-plugin question is pending, which would mask the veto under test by
// refusing all cases for a reason that is not the veto. Ask-first off is the
// same pin prompt-submit.test.ts and onboarding-gate.test.ts take.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

// Per-project preference buckets are keyed by a hash of the directory under the
// machine-wide state dir. Redirect that dir into scratch so a test never touches
// the developer's real `~/.traffic-one/projects/`.
const PREFS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 't1-markers-xdg-'));
process.env.XDG_STATE_HOME = PREFS_HOME;

// The marker each wedged ecosystem actually ships. `Svc.csproj` and its three
// siblings are a STEM plus a suffix — MSBuild names the file after the project,
// so there is no literal to look for.
//
// THE PARENT PLAN NAMED FIVE ECOSYSTEMS and this is more rows than that, because
// the plan's five were an enumeration of the defect and not its definition: the
// claim being fixed is that a member "silently gets no state at all", and a
// Kotlin-DSL Gradle module ships only `build.gradle.kts`, a setuptools
// distribution only `setup.py`/`setup.cfg`, and an F#/VB/C++ project only its
// own MSBuild spelling. Each is the same member, wedged the same way, and each
// row below is MEASURED rather than argued from the analogy.
const WEDGED_ECOSYSTEMS: readonly [label: string, marker: string][] = [
  ['pip', 'requirements.txt'],
  ['setuptools (setup.py)', 'setup.py'],
  ['setuptools (setup.cfg)', 'setup.cfg'],
  ['Maven', 'pom.xml'],
  ['Gradle (Groovy)', 'build.gradle'],
  ['Gradle (Kotlin DSL)', 'build.gradle.kts'],
  ['.NET (C#)', 'Svc.csproj'],
  ['.NET (F#)', 'Svc.fsproj'],
  ['.NET (VB)', 'Svc.vbproj'],
  ['MSBuild (C++)', 'Svc.vcxproj'],
  ['Elixir', 'mix.exs'],
];

function withRepo(body: (repo: string) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 't1-markers-'));
  const repo = fs.realpathSync(created);
  resetAuthoringRootCache();
  resetPluginUseCache();
  try {
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    body(repo);
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
    resetAuthoringRootCache();
    resetPluginUseCache();
  }
}

/** A sub-directory of `repo` whose only project signal is `marker`. */
function moduleDir(repo: string, marker: string): string {
  const dir = path.join(repo, 'svc');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, marker), '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'main.txt'), 'x\n', 'utf8');
  return dir;
}

test('manifest markers: each wedged ecosystem OWNS a project, so the state-write veto lets it through', () => {
  for (const [label, marker] of WEDGED_ECOSYSTEMS) {
    withRepo((repo) => {
      const dir = moduleDir(repo, marker);
      assert.equal(dirOwnsProject(dir), true, `${label}: ${marker} makes the directory a module root`);
      assert.equal(projectMembershipRoot(dir), dir,
        `${label}: it therefore belongs to ITSELF, not to the repository above it`);

      // The veto is CREATION-time and lives in writeState; before the widening
      // this refused and left the directory with no `.one.json` at all.
      assert.equal(
        writeState(dir, { mode: 'existing-codebase', stack: 'minimal', onboardingComplete: true, confirmed: true }),
        true,
        `${label}: writeState persists rather than refusing`,
      );
      assert.equal(fs.existsSync(statePath(dir)), true, `${label}: and the state file is on disk`);

      // The TWIN veto (prefs-store.ts). Its refusal is quieter and worse: with
      // no bucket the member cannot record the use-plugin consent answer, so
      // every later `.traffic-one/**` write is fenced for a second reason.
      updateProjectPrefs(dir, process.env, (current) => ({ ...current, graphifyAutoRun: true }));
      assert.equal(fs.existsSync(projectPrefsPath(dir, process.env)), true,
        `${label}: the per-project preferences bucket is created`);
    });
  }
});

// ── the settings file is a DECLARATION, not a manifest ───────────────────────

test('manifest markers: `settings.gradle` is NOT a manifest — it is Gradle\'s spelling of `workspaces`', () => {
  for (const name of ['settings.gradle', 'settings.gradle.kts']) {
    assert.equal(MANIFEST_MARKERS.includes(name as never), false,
      `${name} names the build's MEMBERS; registering it as "I am a project" is the inversion of what this list means`);
  }
});

test('manifest markers: the Gradle row now matches the npm row on identical layouts', () => {
  // The measurement that settled it. Two trees with the same shape — a root
  // that declares members, one submodule with a build file of its own — asked
  // the same three questions. Before the move the Gradle submodule answered
  // "I am my own project" while the npm sub-package answered "I belong to the
  // workspace root", from the same layout.
  const ask = (root: string, member: string): Record<string, unknown> => ({
    ownsProject: dirOwnsProject(member),
    resolvesToRootFromCwd: resolveProjectRoot(member) === root,
    isUnclaimedSubPackage: isUnclaimedWorkspaceSubPackage(member),
  });

  withRepo((repo) => {
    const npmRoot = path.join(repo, 'npm');
    const npmMember = path.join(npmRoot, 'modules', 'api');
    fs.mkdirSync(npmMember, { recursive: true });
    fs.writeFileSync(path.join(npmRoot, 'package.json'), `${JSON.stringify({ name: 'ws', private: true, workspaces: ['modules/*'] })}\n`, 'utf8');
    fs.writeFileSync(path.join(npmMember, 'package.json'), `${JSON.stringify({ name: 'api' })}\n`, 'utf8');

    const gradleRoot = path.join(repo, 'gradle');
    const gradleMember = path.join(gradleRoot, 'modules', 'api');
    fs.mkdirSync(gradleMember, { recursive: true });
    fs.writeFileSync(path.join(gradleRoot, 'settings.gradle'), "include 'modules:api'\n", 'utf8');
    fs.writeFileSync(path.join(gradleMember, 'build.gradle'), '\n', 'utf8');

    const npm = ask(npmRoot, npmMember);
    const gradle = ask(gradleRoot, gradleMember);
    assert.deepEqual(npm, {
      ownsProject: true, resolvesToRootFromCwd: true, isUnclaimedSubPackage: true,
    }, 'the npm row is the reference and is unchanged');
    assert.deepEqual(gradle, npm, 'and the Gradle row now agrees with it, row for row');
  });
});

test('manifest markers: a Gradle submodule still owns a project through its BUILD file', () => {
  // The other half of the same move: the settings file stops making the ROOT a
  // manifest-bearing project, and `build.gradle(.kts)` — which every submodule
  // carries — is what keeps a genuine member able to hold state.
  withRepo((repo) => {
    const root = path.join(repo, 'build-root');
    const member = path.join(root, 'modules', 'api');
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(root, 'settings.gradle'), "include 'modules:api'\n", 'utf8');
    fs.writeFileSync(path.join(member, 'build.gradle.kts'), '\n', 'utf8');

    assert.equal(dirOwnsProject(root), false, 'a settings file alone no longer declares a project');
    assert.equal(dirOwnsProject(member), true, 'the submodule does, through its build file');
    assert.equal(
      writeState(member, { mode: 'existing-codebase', stack: 'minimal', onboardingComplete: true, confirmed: true }),
      true,
      'so a registered member in a Gradle workspace can still hold state of its own',
    );
  });
});

// ── the weak marker ──────────────────────────────────────────────────────────

test('weak markers: `requirements.txt` is a DEPENDENCY LIST, and the list says so', () => {
  assert.deepEqual([...WEAK_MANIFEST_MARKERS], ['requirements.txt']);
  assert.equal(MANIFEST_MARKERS.includes('requirements.txt' as never), false,
    'it must not also be strong, or the strength test never runs');
});

test('weak markers: `docs/` and `tests/` under a Python project belong to the REPOSITORY', () => {
  // The false positive, measured: a `.git` + `pyproject.toml` repo with a
  // conventional Sphinx `docs/requirements.txt` had `dirOwnsProject(docs)`
  // true, resolved to `docs`, and persisted a `.one.json` there — splitting the
  // repository during the window in which onboarding runs.
  for (const sub of ['docs', 'tests']) {
    withRepo((repo) => {
      fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\nname="a"\n', 'utf8');
      const dir = path.join(repo, sub);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'requirements.txt'), 'sphinx\n', 'utf8');

      assert.equal(dirOwnsProject(dir), false, `${sub}/: an ancestor already declares the project`);
      assert.equal(projectMembershipRoot(dir), repo, `${sub}/: so it belongs to the repository`);
      assert.equal(resolveProjectRoot(dir), repo, `${sub}/: and resolution agrees`);
      assert.equal(
        writeState(dir, { mode: 'existing-codebase', stack: 'minimal', onboardingComplete: true, confirmed: true }),
        false,
        `${sub}/: the state-write veto refuses to split the repository`,
      );
      assert.equal(fs.existsSync(statePath(dir)), false, `${sub}/: nothing was written`);
    });
  }
});

test('weak markers: the ancestor test is MANIFEST-based, never `.git`-based', () => {
  // Keying it on version control would re-wedge the shape the marker exists
  // for: the holder of a pip member has `.git` too, so every member would be
  // absorbed back into it and the container would wait at `members-pending`
  // forever. `withRepo` gives the holder a `.git` and no manifest, which is
  // exactly the discriminating fixture.
  withRepo((repo) => {
    const member = path.join(repo, 'svc');
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, 'requirements.txt'), 'flask\n', 'utf8');

    assert.equal(dirOwnsProject(repo), true, 'the holder owns a project — through `.git`, not a manifest');
    assert.equal(dirOwnsProject(member), true,
      'and the member still owns one, because no ANCESTOR carries a manifest');
    assert.equal(projectMembershipRoot(member), member);
  });
});

test('weak markers: a strong marker in the directory ITSELF always wins', () => {
  // Strength is about ancestors. A directory carrying both `pyproject.toml` and
  // `requirements.txt` is a project by the strong marker and never consults the
  // walk, wherever it sits.
  withRepo((repo) => {
    fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\nname="a"\n', 'utf8');
    const member = path.join(repo, 'svc');
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, 'requirements.txt'), 'flask\n', 'utf8');
    fs.writeFileSync(path.join(member, 'pyproject.toml'), '[project]\nname="svc"\n', 'utf8');

    assert.equal(dirOwnsProject(member), true);
    assert.equal(projectMembershipRoot(member), member);
  });
});

// ── the suffix markers ───────────────────────────────────────────────────────

test('manifest markers: MSBuild project files are matched as a SUFFIX, in all four spellings', () => {
  assert.deepEqual([...MANIFEST_SUFFIX_MARKERS], ['.csproj', '.fsproj', '.vbproj', '.vcxproj']);
  assert.equal(MANIFEST_MARKERS.some((marker) => marker.includes('*')), false,
    'no entry in the literal list is a pattern');

  for (const suffix of MANIFEST_SUFFIX_MARKERS) {
    withRepo((repo) => {
      const dir = path.join(repo, 'svc');
      fs.mkdirSync(dir, { recursive: true });
      assert.equal(dirOwnsProject(dir), false, 'an empty sub-directory owns nothing');
      fs.writeFileSync(path.join(dir, `Anything.At.All${suffix}`), '\n', 'utf8');
      assert.equal(dirOwnsProject(dir), true, `any stem ahead of ${suffix} is an MSBuild project`);
    });
  }
});

test('manifest markers: a bare suffix dotfile is not a project, in any spelling', () => {
  for (const suffix of MANIFEST_SUFFIX_MARKERS) {
    withRepo((repo) => {
      const dir = path.join(repo, 'svc');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, suffix), '\n', 'utf8');
      assert.equal(dirOwnsProject(dir), false,
        `the suffix rule requires a stem — a dotfile named ${suffix} is not a manifest`);
    });
  }
});

// ── the invariants the widening must not move ────────────────────────────────

test('manifest markers: the ASYMMETRY is untouched — a new marker in an ANCESTOR still absorbs nothing', () => {
  // The rule the module header records: for the START dir a manifest is enough,
  // but only VERSION CONTROL lets an ancestor absorb a child. Widening the
  // manifest list must not give a stray `pom.xml` high in a tree authority over
  // everything beneath it — the `~/Documents/go.mod` incident, with a new name.
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 't1-markers-anc-'));
  const outer = fs.realpathSync(created);
  resetAuthoringRootCache();
  try {
    fs.writeFileSync(path.join(outer, 'pom.xml'), '\n', 'utf8');
    const child = path.join(outer, 'unrelated', 'leaf');
    fs.mkdirSync(child, { recursive: true });
    assert.equal(projectMembershipRoot(child), null,
      'a marker-less directory under a marker-bearing, VCS-less ancestor belongs to nobody');
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
    resetAuthoringRootCache();
  }
});

test('manifest markers: root RESOLUTION is unchanged — PROJECT_MARKERS was not widened', () => {
  // shared/paths.ts findUp walks to the NEAREST marker-bearing ancestor, which
  // is exactly why the parent plan forbids widening its list: a `pom.xml`
  // sub-module would become the project root during the pre-`mode` window and
  // the split would outlive it. This is that list, asked through its own
  // resolver rather than by reading the constant. Every widened marker is
  // asked, not just one.
  for (const [label, marker] of WEDGED_ECOSYSTEMS) {
    withRepo((repo) => {
      const dir = moduleDir(repo, marker);
      assert.equal(
        projectRoot({
          event: 'PreToolUse',
          host: 'claude',
          cwd: repo,
          raw: {},
          tool: { class: 'file-write', rawName: 'Write', filePath: path.join(dir, 'src', 'main.txt') },
        }),
        repo,
        `${label}: the repository still owns the file, exactly as before the widening`,
      );
    });
  }
});

test('manifest markers: a workspace member in a wedged ecosystem is registered AND can hold state', () => {
  // The composition Phase 4 is about: the member is the project. The registry
  // makes it a member; the marker list is what lets it own state once it is one.
  withRepo((repo) => {
    fs.mkdirSync(path.join(repo, '.traffic-one'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.traffic-one', '.one.json'),
      `${JSON.stringify({
        mode: WORKSPACE_PROJECT_MODE,
        onboardingComplete: true,
        workspaceMembers: [{ path: 'svc' }],
      }, null, 2)}\n`,
      'utf8',
    );
    const member = moduleDir(repo, 'requirements.txt');
    assert.equal(isRegisteredWorkspaceMember(member), true, 'the registry says so');
    assert.equal(
      writeState(member, { mode: 'existing-codebase', stack: 'minimal', onboardingComplete: true, confirmed: true }),
      true,
      'and the member now holds an ordinary single-stack .one.json of its own',
    );
  });
});
