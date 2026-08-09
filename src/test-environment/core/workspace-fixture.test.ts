// The CASE-MODEL WIDENING, tested at the seam a workspace case depends on: a
// `Case.fixture` that is a container of N members materializes N independently
// owned projects, and each of them gets the preferences bucket production would
// give it.
//
// These are not the workspace's BEHAVIOUR rows — those are harness assertions
// measured on a real case run (assertions/workspace-*.assert.ts), and the
// resolver characterizations live one file over in polyglot-workspace.test.ts.
// What is tested here is the thing that used to be impossible: expressing the
// shape at all. Every row below fails if the widening silently collapses back to
// one project, which is the regression that would leave the workspace assertions
// passing while measuring a single directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { defaultProjectPrefsPath } from '../../shared/state/local-prefs/prefs-store';
import { buildCaseEnv, memberCaseEnv } from './env';
import { defaultConfig } from '../config/test-config';
import { isWorkspaceFixture, materializeCaseFixture } from './fixtures';
import type { CaseFixture, WorkspaceFixture } from './types';

const TMP_PREFIX = 't1-ws-case-model-';

function withTmp(fn: (root: string) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  try {
    fn(fs.realpathSync(created));
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
  }
}

const THREE_MEMBERS: WorkspaceFixture = {
  members: [
    { id: 'storefront-web', fixture: 'existing-react-vite' },
    { id: 'ledger-api', fixture: 'existing-go-api' },
    { id: 'reporting-etl', fixture: 'existing-python-api' },
  ],
};

// The discriminator is `typeof fixture === 'string'` and nothing else, so a
// FixtureKind added later can never accidentally read as a workspace.
test('case fixture: a FixtureKind and a workspace are told apart by shape alone', () => {
  for (const kind of ['empty', 'existing-go-api', 'existing-python-api'] as CaseFixture[]) {
    assert.equal(isWorkspaceFixture(kind), false, `${String(kind)} is one project`);
  }
  assert.equal(isWorkspaceFixture(THREE_MEMBERS), true);
});

test('case fixture: a single-project case still materializes exactly one root and no members', () => {
  withTmp((root) => {
    const dir = path.join(root, 'project');
    const project = materializeCaseFixture(dir, 'existing-node-api');
    assert.equal(project.root, dir);
    assert.deepEqual(project.members, [],
      'a single-project case must report NO members, or every workspace assertion becomes applicable to it');
    assert.equal(fs.existsSync(path.join(dir, 'package.json')), true);
  });
});

test('case fixture: a workspace materializes N independently owned members under a BARE container', () => {
  withTmp((root) => {
    const container = path.join(root, 'workspace');
    const project = materializeCaseFixture(container, THREE_MEMBERS);

    assert.equal(project.root, container);
    assert.deepEqual(project.members.map((m) => m.id), ['storefront-web', 'ledger-api', 'reporting-etl'],
      'members are reported in declaration order');

    // The container is a CONTAINER. `materializeFixture` would have planted a
    // package.json and a `.git` here; a workspace case must not get either
    // unless it asks, or "the container adopts no member" is answered by the
    // container's own markers rather than by the resolver.
    assert.equal(fs.existsSync(path.join(container, 'package.json')), false,
      'a bare container must own no manifest');
    assert.equal(fs.existsSync(path.join(container, '.git')), false,
      'a bare container must own no version control');
    assert.equal(fs.existsSync(path.join(container, '.traffic-one')), false,
      'materialization must never onboard the container');

    // Each member is a real project, built by the SAME materializeFixture every
    // single-project case uses — read back through the manifest its own fixture
    // is defined by rather than through a marker the workspace builder planted.
    const manifests: Record<string, string> = {
      'storefront-web': 'package.json',
      'ledger-api': 'go.mod',
      'reporting-etl': 'pyproject.toml',
    };
    for (const member of project.members) {
      const manifest = manifests[member.id] ?? '';
      assert.notEqual(manifest, '', `FIXTURE this test declares no expected manifest for ${member.id}`);
      assert.equal(path.dirname(member.root), container, `${member.id} is a direct child of the container`);
      assert.equal(fs.existsSync(path.join(member.root, manifest)), true,
        `${member.id} must carry ${manifest} — the manifest its declared fixture is defined by`);
      // The probe: a directory INSIDE the member owning no manifest of its own.
      // The nesting is what reaches the membership fallback in resolveProjectRoot.
      assert.equal(fs.existsSync(member.probeFile), true, `${member.id} must carry a probe file`);
      assert.notEqual(path.resolve(member.probeDir), path.resolve(member.root),
        `${member.id}: the probe must be NESTED, or it measures the member root twice`);
      for (const manifest of ['package.json', 'go.mod', 'pyproject.toml']) {
        assert.equal(fs.existsSync(path.join(member.probeDir, manifest)), false,
          `${member.id}: the probe directory must own no manifest`);
      }
    }

    // Polyglot, read from DISK: three members carrying one manifest set between
    // them is a workspace that has stopped being polyglot without saying so.
    const distinct = new Set(project.members.flatMap((m) => (
      ['package.json', 'go.mod', 'pyproject.toml'].filter((f) => fs.existsSync(path.join(m.root, f)))
    )));
    assert.ok(distinct.size >= 2, `expected at least two distinct manifests, got ${[...distinct].join(', ')}`);
  });
});

test('case fixture: a container that declares its own fixture becomes a project, and containerVcs adds only git', () => {
  withTmp((root) => {
    const asProject = materializeCaseFixture(path.join(root, 'as-project'), {
      ...THREE_MEMBERS, container: 'existing-node-api',
    });
    assert.equal(fs.existsSync(path.join(asProject.root, 'package.json')), true,
      'a declared container fixture is materialized by the ordinary materializeFixture');
    assert.equal(asProject.members.length, 3, 'and the members are still built');

    const umbrella = materializeCaseFixture(path.join(root, 'umbrella'), { ...THREE_MEMBERS, containerVcs: true });
    assert.equal(fs.existsSync(path.join(umbrella.root, '.git')), true, 'containerVcs plants version control');
    assert.equal(fs.existsSync(path.join(umbrella.root, 'package.json')), false,
      'containerVcs must NOT also make the container a manifest-owning project — the git umbrella is its own shape');
  });
});

// ── the preferences-bucket collapse ─────────────────────────────────────────

test('member env: each member gets the bucket production would name for its own root', () => {
  withTmp((root) => {
    const caseFolder = path.join(root, 'case');
    fs.mkdirSync(caseFolder, { recursive: true });
    const project = materializeCaseFixture(path.join(caseFolder, 'project'), THREE_MEMBERS);
    const config = { ...defaultConfig(), isolateStateHome: true };
    const base = buildCaseEnv(config, caseFolder, '', 'pure-node');

    const envs = project.members.map((m) => memberCaseEnv(base, caseFolder, { id: m.id, root: m.root }));
    const buckets = envs.map((env) => env.TRAFFIC_ONE_PROJECT_PREFS_PATH);

    assert.equal(new Set(buckets).size, project.members.length,
      'N members must get N buckets — one shared file means the last member seeded overwrites the others');
    assert.notEqual(buckets[0], base.TRAFFIC_ONE_PROJECT_PREFS_PATH,
      'and none of them may be the case-wide file the collapse came from');

    // The DERIVATION, not merely the distinctness: anything in production that
    // resolves a bucket from a ROOT rather than from the variable has to agree.
    project.members.forEach((member, index) => {
      const bucket = buckets[index] ?? '';
      assert.equal(bucket, defaultProjectPrefsPath(member.root, envs[index] ?? {}),
        `${member.id}: the harness bucket must be the one production names for this root`);
      assert.ok(bucket.startsWith(path.resolve(caseFolder) + path.sep),
        `${member.id}: and it must stay inside the case folder, never the maintainer's real ~/.traffic-one`);
    });
  });
});

// withCaseEnv restores BY KEY, so a member env that merely omitted the variable
// would inherit whatever an enclosing scope had applied — silently reinstating
// the shared file. The variable must be present and absolute.
test('member env: the prefs variable is SET, never omitted', () => {
  withTmp((root) => {
    const caseFolder = path.join(root, 'case');
    const project = materializeCaseFixture(path.join(caseFolder, 'project'), THREE_MEMBERS);
    const base = buildCaseEnv(defaultConfig(), caseFolder, '', 'pure-node');
    for (const member of project.members) {
      const env = memberCaseEnv(base, caseFolder, { id: member.id, root: member.root });
      assert.ok(
        Object.prototype.hasOwnProperty.call(env, 'TRAFFIC_ONE_PROJECT_PREFS_PATH'),
        `${member.id}: the key must exist, or withCaseEnv leaves the enclosing case-wide value in place`,
      );
      assert.equal(path.isAbsolute(env.TRAFFIC_ONE_PROJECT_PREFS_PATH ?? ''), true);
    }
  });
});

// The one configuration where production's own derivation would name the
// maintainer's REAL ~/.traffic-one/projects/<hash>. Distinctness — what the
// assertions measure — survives; only the bucket spelling is given up.
test('member env: with no isolated state home the buckets stay in the case folder and stay distinct', () => {
  withTmp((root) => {
    const caseFolder = path.join(root, 'case');
    const project = materializeCaseFixture(path.join(caseFolder, 'project'), THREE_MEMBERS);
    const config = { ...defaultConfig(), isolateStateHome: false };
    const base = buildCaseEnv(config, caseFolder, '', 'pure-node');
    assert.equal(base.XDG_STATE_HOME, undefined, 'FIXTURE isolateStateHome:false must leave XDG_STATE_HOME unset');

    const buckets = project.members.map((m) => (
      memberCaseEnv(base, caseFolder, { id: m.id, root: m.root }).TRAFFIC_ONE_PROJECT_PREFS_PATH
    ));
    assert.equal(new Set(buckets).size, project.members.length, 'still one bucket per member');
    for (const bucket of buckets) {
      assert.ok(bucket && bucket.startsWith(path.resolve(caseFolder) + path.sep),
        `a case must never write to the maintainer's machine: ${String(bucket)}`);
    }
  });
});
