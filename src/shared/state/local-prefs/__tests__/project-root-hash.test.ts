import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { overrideProjectPaths } from '../../../override/paths';
import {
  defaultProjectPrefsPath,
  legacyProjectRootHash,
  migrateHashNamedFolder,
  migrateMiscasedPrefsBucket,
  projectRootHash,
  projectRootHashAliases,
} from '../prefs-store';
import { writeProjectRootSidecarAt } from '../project-root-sidecar';

const TMP_PREFIX = 't1-lane-prhash-';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function withStateHome(fn: (env: NodeJS.ProcessEnv, home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  const saved = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TRAFFIC_ONE_PROJECT_PREFS_PATH: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    TRAFFIC_ONE_STATE_PATH: process.env.TRAFFIC_ONE_STATE_PATH,
  };
  process.env.XDG_STATE_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete process.env.TRAFFIC_ONE_STATE_PATH;
  try {
    fn({ ...process.env, XDG_STATE_HOME: home, HOME: home, USERPROFILE: home }, home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('projectRootHash is sha256 of realpathSync.native', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  try {
    const native = fs.realpathSync.native(dir);
    assert.equal(projectRootHash(dir), sha256(native));
    assert.ok(projectRootHashAliases(dir).includes(projectRootHash(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateHashNamedFolder renames src onto dest when dest is absent', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  try {
    const from = 'a'.repeat(64);
    const to = 'b'.repeat(64);
    fs.mkdirSync(path.join(parent, from));
    fs.writeFileSync(path.join(parent, from, 'preferences.json'), '{"kept":true}\n');
    assert.equal(migrateHashNamedFolder(parent, to, from), true);
    assert.equal(fs.existsSync(path.join(parent, from)), false);
    assert.equal(
      fs.readFileSync(path.join(parent, to, 'preferences.json'), 'utf8'),
      '{"kept":true}\n',
    );
    assert.equal(migrateHashNamedFolder(parent, to, from), false, 'second pass is a no-op');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('migrateHashNamedFolder refuses to clobber an existing canonical folder', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  try {
    const from = 'c'.repeat(64);
    const to = 'd'.repeat(64);
    fs.mkdirSync(path.join(parent, from));
    fs.mkdirSync(path.join(parent, to));
    fs.writeFileSync(path.join(parent, to, 'preferences.json'), '{"canonical":true}\n');
    assert.equal(migrateHashNamedFolder(parent, to, from), false);
    assert.equal(fs.existsSync(path.join(parent, from)), true);
    assert.equal(
      fs.readFileSync(path.join(parent, to, 'preferences.json'), 'utf8'),
      '{"canonical":true}\n',
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('migrateMiscasedPrefsBucket moves a sidecar-matching leftover onto the native hash', () => {
  withStateHome((env, home) => {
    const project = path.join(home, 'work', 'MyProj');
    fs.mkdirSync(project, { recursive: true });
    const leftoverHash = sha256('miscased-spelling-of-this-project');
    const leftover = path.join(home, 'traffic-one', 'projects', leftoverHash);
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'preferences.json'), '{"consent":true}\n');
    writeProjectRootSidecarAt(path.join(leftover, 'preferences.json'), project);

    const canonical = projectRootHash(project);
    assert.notEqual(leftoverHash, canonical, 'FIXTURE leftover is not already the native hash');
    const from = migrateMiscasedPrefsBucket(project, env);
    assert.equal(from, leftoverHash);
    assert.equal(fs.existsSync(leftover), false);
    assert.equal(
      fs.readFileSync(path.join(home, 'traffic-one', 'projects', canonical, 'preferences.json'), 'utf8'),
      '{"consent":true}\n',
    );
    assert.equal(migrateMiscasedPrefsBucket(project, env), null, 'idempotent once the canonical folder exists');
  });
});

test('defaultProjectPrefsPath migrates then lands on the native-hash folder', () => {
  withStateHome((env, home) => {
    const project = path.join(home, 'work', 'App');
    fs.mkdirSync(project, { recursive: true });
    const leftoverHash = sha256('old-js-realpath-bucket');
    const leftover = path.join(home, 'traffic-one', 'projects', leftoverHash);
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'preferences.json'), '{"hosts":{}}\n');
    writeProjectRootSidecarAt(path.join(leftover, 'preferences.json'), project);

    const prefs = defaultProjectPrefsPath(project, env);
    assert.equal(path.basename(path.dirname(prefs)), projectRootHash(project));
    assert.equal(fs.readFileSync(prefs, 'utf8'), '{"hosts":{}}\n');
  });
});

test('overrideProjectPaths renames a leftover ledger folder onto the native hash', () => {
  withStateHome((env, home) => {
    const project = path.join(home, 'work', 'Lib');
    fs.mkdirSync(project, { recursive: true });
    const leftoverHash = sha256('old-override-bucket');
    const leftover = path.join(home, 'traffic-one', 'projects', leftoverHash);
    fs.mkdirSync(leftover, { recursive: true });
    writeProjectRootSidecarAt(path.join(leftover, 'preferences.json'), project);
    const overrideLeftover = path.join(home, 'traffic-one', 'overrides', leftoverHash);
    fs.mkdirSync(overrideLeftover, { recursive: true });
    fs.writeFileSync(path.join(overrideLeftover, 'overrides.jsonl'), '{"id":"kept"}\n');

    const paths = overrideProjectPaths(project, env);
    assert.equal(paths.key, projectRootHash(project));
    assert.equal(fs.existsSync(overrideLeftover), false);
    assert.equal(
      fs.readFileSync(path.join(paths.dir, 'overrides.jsonl'), 'utf8'),
      '{"id":"kept"}\n',
    );
  });
});

test('legacyProjectRootHash stays the JS-realpath spelling so aliases can find it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  try {
    const js = fs.realpathSync(dir);
    assert.equal(legacyProjectRootHash(dir), sha256(js));
    const aliases = projectRootHashAliases(dir);
    assert.ok(aliases.includes(projectRootHash(dir)));
    assert.ok(aliases.includes(legacyProjectRootHash(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
