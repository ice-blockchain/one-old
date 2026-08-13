// WHICH WAY THE MANIFEST WIDENING MOVES THE RETENTION SWEEP.
//
// `dirOwnsProject` is not only the state-write veto. hook/paths.ts
// `nearestOnboardedRoot` reads it twice inside its leak rule —
//
//   nearestWorkspaceRoot(dirname(current)) === null
//     && (dirOwnsProject(current) || projectMembershipRoot(dirname(current)) === null)
//
// — and shared/retention.ts `isLeakedNestedRoot` turns the resolver's answer
// into a DELETION: a nested `.traffic-one/` whose directory does not resolve to
// itself is scheduled for removal by the SessionStart sweep, runs, claims, plan
// and all. So every name added to `MANIFEST_MARKERS` moves two populations, in
// opposite directions, and neither of them is the state-write veto this list is
// usually discussed in terms of.
//
// THIS FILE IS A SEPARATE ONE ON PURPOSE. `isLeakedNestedRoot` is not exported,
// so the four lines above are reproduced below rather than imported;
// `retention.ts` and its own test file belong to a different change and are not
// touched here. The copy is asserted to be faithful the only way it can be — it
// is the whole body of the function as of this commit, and it is short enough
// to read against the source.
//
// The unlisted control is `CMakeLists.txt`: naming files is all
// `MANIFEST_MARKERS` does, so an identical tree built with a marker the list
// does not carry reproduces the pre-widening answers exactly, with no source
// edit and no mocking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { obj } from '../obj';
import { readJsonResult } from '../fsjson';
import { resolveProjectRoot } from '../hook/paths';
import { dirOwnsProject } from '../project-membership';
import { resetAuthoringRootCache } from '../authoring-root';
import { resetPluginUseCache } from '../state/plugin-use';

process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

/** shared/retention.ts `isLeakedNestedRoot`, verbatim. True means SWEPT. */
function isLeakedNestedRoot(projectDir: string): boolean {
  const dir = path.resolve(projectDir);
  const state = readJsonResult<unknown>(path.join(dir, '.traffic-one', '.one.json'));
  if (state.kind !== 'ok' || !obj(state.value)) return false;
  try {
    return resolveProjectRoot(dir, undefined, { workspaceAuthority: 'membership' }) !== dir;
  } catch {
    return false;
  }
}

const LISTED = 'build.gradle';
const UNLISTED = 'CMakeLists.txt';

function withScratch(body: (root: string) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 't1-marker-retention-'));
  const root = fs.realpathSync(created);
  resetAuthoringRootCache();
  resetPluginUseCache();
  try {
    body(root);
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
    resetAuthoringRootCache();
    resetPluginUseCache();
  }
}

function seedState(dir: string, body: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function marked(dir: string, marker: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, marker), '\n', 'utf8');
}

/** Both columns of one shape, so every assertion is an A/B and not an absolute. */
function bothColumns(build: (root: string, marker: string) => boolean): { unlisted: boolean; listed: boolean } {
  const out: Record<string, boolean> = {};
  for (const [column, marker] of [['unlisted', UNLISTED], ['listed', LISTED]] as const) {
    withScratch((root) => { out[column] = build(root, marker); });
  }
  return { unlisted: out.unlisted!, listed: out.listed! };
}

test('marker widening: a stray inside a newly recognised module is KEPT, and no longer self-heals', () => {
  // The safe direction, and a behaviour change nothing else in the tree names.
  // A full `new-project` state accrued inside a Gradle or Maven submodule used
  // to be reported as a leak and healed by the next SessionStart sweep. The
  // submodule owns a project now, so its state is its own — correct, and the
  // automatic cleanup is gone with it. Removing such a stray is now manual.
  const verdicts = bothColumns((root, marker) => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    marked(repo, marker);
    seedState(repo, { mode: 'existing-codebase', onboardingComplete: true });
    const api = path.join(repo, 'modules', 'api');
    marked(api, marker);
    seedState(api, { mode: 'new-project', onboardingComplete: true });
    assert.equal(dirOwnsProject(api), marker === LISTED, 'the control marker must really be unlisted');
    return isLeakedNestedRoot(api);
  });

  assert.deepEqual(verdicts, { unlisted: true, listed: false },
    'swept before the widening, kept after it');
});

test('marker widening: it ENLARGES the keep → delete population, in one narrow shape', () => {
  // The dangerous direction, and the reason this file exists. The leak rule
  // reads `projectMembershipRoot(dirname(current))`, so a HOLDER that starts
  // owning a project flips the second disjunct to false; with the nested
  // directory owning no marker of its own, the walk climbs PAST a real root and
  // the sweep schedules it. Version control is what the walk normally finds
  // instead, so the shape needs a tree with none anywhere.
  const verdicts = bothColumns((root, marker) => {
    const holder = path.join(root, 'holder');
    marked(holder, marker);
    seedState(holder, { mode: 'existing-codebase', onboardingComplete: true });
    const sub = path.join(holder, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    seedState(sub, { mode: 'new-project', onboardingComplete: true });
    return isLeakedNestedRoot(sub);
  });

  assert.deepEqual(verdicts, { unlisted: false, listed: true },
    'a directory the sweep used to KEEP is now a deletion candidate');
});

test('marker widening: version control anywhere above removes that population again', () => {
  // The bound, which is what keeps the finding narrow rather than alarming.
  // With `.git` on the holder the membership answer is already non-null, so the
  // disjunct was false before the widening too and nothing moved.
  const verdicts = bothColumns((root, marker) => {
    const holder = path.join(root, 'holder');
    fs.mkdirSync(path.join(holder, '.git'), { recursive: true });
    marked(holder, marker);
    seedState(holder, { mode: 'existing-codebase', onboardingComplete: true });
    const sub = path.join(holder, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    seedState(sub, { mode: 'new-project', onboardingComplete: true });
    return isLeakedNestedRoot(sub);
  });

  assert.equal(verdicts.unlisted, verdicts.listed, 'the widening moves nothing once the holder is a repository');
});

test('marker widening: a directory that owns a project is never made a deletion candidate BY owning one', () => {
  // The invariant the leak rule rests on, asserted directly so a future
  // reordering of the disjunction cannot quietly break it: `dirOwnsProject`
  // appears on the KEEP side, so adding a name to the list can only ever rescue
  // the directory that carries it. Everything the widening endangers is a
  // NEIGHBOUR, which is the whole content of the previous two tests.
  const verdicts = bothColumns((root, marker) => {
    const holder = path.join(root, 'holder');
    marked(holder, marker);
    seedState(holder, { mode: 'existing-codebase', onboardingComplete: true });
    const sub = path.join(holder, 'sub');
    marked(sub, marker);
    seedState(sub, { mode: 'new-project', onboardingComplete: true });
    return isLeakedNestedRoot(sub);
  });

  assert.deepEqual(verdicts, { unlisted: false, listed: false },
    'the marker-carrying nested directory is kept either way');
});
