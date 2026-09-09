// The upgrade that never arrived: a project keeps serving the PREVIOUS
// release's rules and skills because the freshness signal was a hand-bumped
// number.
//
// `isMaterialized(state)` compares `state.materializedVersion` against
// package.json's version. Measured on this repo: 11 of the last 14 non-merge
// commits that changed the emitted content tree carried no bump — 10 of 14
// counting only `rules/**` and `skills-catalog/**`, the two trees
// materialization actually copies. HEAD is a live instance:
// `skills-catalog/traffic-one-doctor/SKILL.md` gained 97 lines
// after the v1.0.52 release commit while package.json still reads 1.0.52. So
// the short circuit in materializeProjectIfNeeded fired on an upgrade, the
// project kept the old bytes, and doctor called it healthy.
//
// The fix is `materializedFromDifferentPluginBuild` — the fourth condition in
// that conjunction, comparing the plugin root's OWN build identity
// (build-provenance.json's `sourceHash`, already emitted, already reported by
// doctor as `plugin.contentHash`) against the copy the writer stamps into
// `.traffic-one/manifest.json`.
//
// What each test here has to avoid is passing for the wrong reason. Every
// end-to-end case asserts FIRST that the three pre-existing conditions all say
// "current" — same stack fingerprint, every tracked file on disk, the runtime's
// declared set satisfied, and the version literally unchanged — so a green
// result can only come from the build comparison. And every root is asserted
// 'installed' before it is relied on, because the suite-wide pinned root is
// this source checkout, which materializeProjectAssets refuses outright.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { pluginRootInfo } from '../../paths';
import { resetPluginUseCache } from '../../state/plugin-use';
import { isMaterialized, stateVersion, writeGlobalCodeGraphProvider } from '../../state';
import { materializeProjectFromState, materializeProjectIfNeeded } from '../converge';
import {
  hasMaterializedProjectAssets,
  materializedContentIsIncomplete,
  materializedFromDifferentPluginBuild,
} from '../has-assets';
import { materializeProjectAssets } from '../materialize';
import { pluginContentHash } from '../../build-provenance';
import { declaredProjectContent, writeMaterializedContent } from './fixtures/materialized-content';

const MODULES = path.resolve(__dirname, '..', '..', '..', 'modules');
const SOURCE_RULES = path.join(MODULES, 'rules', 'rules');
const SOURCE_SKILLS = path.join(MODULES, 'skills', 'skills-catalog');

// A real entry of the shipped catalog that this project's config declares, so
// mutating it exercises the same resolution path every other skill takes.
const MUTABLE_SKILL = 'project-memory';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { enabled: false, framework: 'none', source: 'prompted' },
  technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
  projectContext: { source: 'prompted', originalPrompt: 'x', summary: 'x', answers: {}, collectedAt: '2026-01-01T00:00:00Z' },
  realtime: 'none',
  supabaseFunctionsAutoDeploy: 'ask',
  confirmed: true,
  confirmedAt: '2026-01-01T00:00:00Z',
  onboardingComplete: true,
} as const;

interface Fixture {
  project: string;
  plugin: string;
}

type Tear = 'whole' | 'skills';

// `skills-catalog/` as a real directory of per-entry symlinks, with the one
// entry under test COPIED — the tree has to be mutable in exactly one place
// (that is what "the plugin was upgraded" means here) without duplicating 103
// skill directories per test.
function buildSkillsCatalog(plugin: string, tear: Tear, skillBody: string): void {
  const dest = path.join(plugin, 'skills-catalog');
  fs.mkdirSync(dest, { recursive: true });
  if (tear === 'skills') {
    // A torn tree: the survivor only. Everything else the runtime declares is
    // absent, which is what tornRootRefusal exists to catch.
    fs.mkdirSync(path.join(dest, MUTABLE_SKILL), { recursive: true });
    fs.writeFileSync(path.join(dest, MUTABLE_SKILL, 'SKILL.md'), skillBody, 'utf8');
    return;
  }
  for (const entry of fs.readdirSync(SOURCE_SKILLS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === MUTABLE_SKILL) {
      fs.mkdirSync(path.join(dest, MUTABLE_SKILL), { recursive: true });
      fs.writeFileSync(path.join(dest, MUTABLE_SKILL, 'SKILL.md'), skillBody, 'utf8');
      continue;
    }
    fs.symlinkSync(path.join(SOURCE_SKILLS, entry.name), path.join(dest, entry.name), 'dir');
  }
}

function skillBodyFor(release: string): string {
  return `# Project Memory\n\nRELEASE-MARKER:${release}\n`;
}

// `null` for either half removes that copy — the "root cannot state a build
// identity" case (a fixture root, a source checkout, an install predating the
// stamp).
function setProvenance(plugin: string, provenance: { content?: string | null; runtime?: string | null }): void {
  const write = (file: string, hash: string | null | undefined): void => {
    if (hash === undefined) return;
    if (hash === null) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ schema: 1, gitSha: null, sourceHash: hash }, null, 2)}\n`, 'utf8');
  };
  write(path.join(plugin, 'build-provenance.json'), provenance.content);
  write(path.join(plugin, 'scripts', 'build-provenance.json'), provenance.runtime);
}

function withFixture(
  opts: { tear?: Tear; release?: string; provenance?: { content?: string | null; runtime?: string | null } },
  fn: (fixture: Fixture) => void,
): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-build-fresh-')));
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'scripts', 'hook-runtime.cjs'), '// test fixture stub\n', 'utf8');
  // Pinned across the "upgrade" in every test below: the whole point is a
  // release whose version did NOT move.
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'traffic-one', version: '9.9.9' }), 'utf8');
  fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
  fs.symlinkSync(SOURCE_RULES, path.join(plugin, 'rules'), 'dir');
  buildSkillsCatalog(plugin, opts.tear ?? 'whole', skillBodyFor(opts.release ?? 'A'));
  if (opts.provenance) setProvenance(plugin, opts.provenance);

  const project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });

  const env = process.env;
  const saved = {
    root: env.TRAFFIC_ONE_PLUGIN_ROOT,
    host: env.TRAFFIC_ONE_HOST,
    plan: env.TRAFFIC_ONE_USER_PLAN,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: env.TRAFFIC_ONE_STATE_PATH,
    home: env.HOME,
    xdg: env.XDG_STATE_HOME,
  };
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_HOST = 'codex';
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(base, 'one.json');
  env.HOME = path.join(base, 'home');
  env.XDG_STATE_HOME = path.join(base, 'xdg');
  resetPluginUseCache();
  try {
    fn({ project, plugin });
  } finally {
    for (const [key, value] of Object.entries({
      TRAFFIC_ONE_PLUGIN_ROOT: saved.root,
      TRAFFIC_ONE_HOST: saved.host,
      TRAFFIC_ONE_USER_PLAN: saved.plan,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_STATE_PATH: saved.state,
      HOME: saved.home,
      XDG_STATE_HOME: saved.xdg,
    })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function seedProjectState(project: string): void {
  const t1 = path.join(project, '.traffic-one');
  fs.mkdirSync(t1, { recursive: true });
  fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({ ...STATE }), 'utf8');
  fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, JSON.stringify({
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
    hosts: {
      codex: {
        performance: { level: 'low', source: 'prompted', target: { plan: 'pro', appliedFingerprint: 'a'.repeat(64), configVersion: 0 } },
        team: { mode: 'main-agent', source: 'prompted' },
      },
    },
  }), 'utf8');
  writeGlobalCodeGraphProvider('graphify');
}

const readState = (project: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', '.one.json'), 'utf8'));

const readManifest = (project: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));

const materializedSkillBody = (project: string): string =>
  fs.readFileSync(path.join(project, '.traffic-one', 'skills', MUTABLE_SKILL, 'SKILL.md'), 'utf8');

/**
 * The three pre-existing conditions, all asserted to say "current".
 *
 * Without this every end-to-end case below could pass because the stack moved,
 * because a file went missing, or because the state failed validation — none of
 * which is the behaviour under test. This is the line that makes them
 * non-vacuous.
 */
function assertOldSignalsSayCurrent(project: string, why: string): void {
  const state = readState(project);
  assert.equal(state.materializedVersion, stateVersion(), `${why}: the version stamp is unchanged (no hand-bump shipped)`);
  assert.equal(isMaterialized(state), true, `${why}: isMaterialized still says current`);
  assert.equal(hasMaterializedProjectAssets(project, state), true, `${why}: every tracked asset is on disk`);
  assert.equal(materializedContentIsIncomplete(project, state), false, `${why}: the declared content set is satisfied`);
}

// ── the reader ───────────────────────────────────────────────────────────────

test('pluginContentHash prefers the content subtree, falls back to the runtime one, and admits when neither can answer', () => {
  withFixture({ provenance: { content: HASH_A, runtime: HASH_B } }, ({ plugin }) => {
    assert.equal(pluginRootInfo().layout, 'installed', 'the fixture root must classify installed');
    // Content first: `rules/` and `skills-catalog/` are the bytes a project is
    // copied from, so on a mixed install the content half is the honest answer.
    assert.equal(pluginContentHash(), HASH_A);

    setProvenance(plugin, { content: null });
    assert.equal(pluginContentHash(), HASH_B, 'a content-less tree still has the runtime stamp');

    setProvenance(plugin, { runtime: null });
    assert.equal(pluginContentHash(), null, 'no stamp anywhere is null, never a fabricated value');

    setProvenance(plugin, { content: '   ' });
    assert.equal(pluginContentHash(), null, 'a blank hash is not an identity');

    fs.writeFileSync(path.join(plugin, 'build-provenance.json'), 'not json{', 'utf8');
    assert.equal(pluginContentHash(), null, 'an unparseable stamp is null, not a throw');
  });
});

// ── the predicate ────────────────────────────────────────────────────────────

test('materializedFromDifferentPluginBuild: the whole truth table', () => {
  withFixture({ provenance: { content: HASH_A } }, ({ project, plugin }) => {
    seedProjectState(project);
    const write = (manifest: Record<string, unknown> | null): void => {
      const file = path.join(project, '.traffic-one', 'manifest.json');
      if (!manifest) { fs.rmSync(file, { force: true }); return; }
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
    };

    write({ generatedBy: 'traffic-one', pluginContentHash: HASH_A, rules: [], skills: [] });
    assert.equal(materializedFromDifferentPluginBuild(project), false, 'same build: nothing to do');

    write({ generatedBy: 'traffic-one', pluginContentHash: HASH_B, rules: [], skills: [] });
    assert.equal(materializedFromDifferentPluginBuild(project), true, 'a different build is stale');

    // THE TRANSITION. Every project already on disk looks exactly like this.
    write({ generatedBy: 'traffic-one', rules: [], skills: [] });
    assert.equal(materializedFromDifferentPluginBuild(project), true, 'no stamp at all is stale — once');

    write({ generatedBy: 'someone-else', rules: [], skills: [] });
    assert.equal(materializedFromDifferentPluginBuild(project), false, 'not our manifest, not our judgement');

    write(null);
    assert.equal(materializedFromDifferentPluginBuild(project), false, 'no manifest: hasMaterializedProjectAssets owns that');

    // A root that cannot state an identity must never read as stale, or a
    // project pointed at one would re-converge on every hook forever against a
    // root the writer refuses anyway — and a refusal writes no manifest, so it
    // could never heal.
    write({ generatedBy: 'traffic-one', rules: [], skills: [] });
    setProvenance(plugin, { content: null, runtime: null });
    assert.equal(materializedFromDifferentPluginBuild(project), false, 'an unstamped root is not evidence of staleness');
  });
});

// ── the writer ───────────────────────────────────────────────────────────────

test('the writer stamps the build it actually copied from into .traffic-one/manifest.json', () => {
  withFixture({ provenance: { content: HASH_A } }, ({ project }) => {
    seedProjectState(project);
    const result = materializeProjectAssets(project, { ...STATE });
    assert.equal(result.skipped, undefined, `a whole root must materialize, got ${result.skipped}`);
    assert.equal(readManifest(project).pluginContentHash, HASH_A);
    const hashes = readManifest(project).fileHashes as Record<string, string>;
    assert.equal(typeof hashes, 'object');
    assert.ok(hashes['AGENTS.md'], 'generated root AGENTS.md is stamped');
    assert.ok(hashes[`skills/${MUTABLE_SKILL}/SKILL.md`], 'each skill SKILL.md is stamped');
    assert.ok(Object.keys(hashes).some((key) => key.startsWith('rules/')), 'tracked rules are stamped');
  });
});

test('a root with no build identity writes no key rather than a null claim', () => {
  withFixture({}, ({ project }) => {
    seedProjectState(project);
    const result = materializeProjectAssets(project, { ...STATE });
    assert.equal(result.skipped, undefined, `a whole root must materialize, got ${result.skipped}`);
    assert.equal('pluginContentHash' in readManifest(project), false);
    // …and the project is not then judged stale for the omission.
    assert.equal(materializedFromDifferentPluginBuild(project), false);
  });
});

// ── end to end: the defect, and that it stays fixed ─────────────────────────

test('an upgrade that ships no version bump still re-materializes, delivers the new bytes, and then goes quiet', () => {
  withFixture({ provenance: { content: HASH_A }, release: 'A' }, ({ project, plugin }) => {
    seedProjectState(project);

    const first = materializeProjectFromState(project, { trigger: 'unit: release A' });
    assert.equal(first.status, 'materialized', first.context);
    assert.match(materializedSkillBody(project), /RELEASE-MARKER:A/);
    assert.equal(readManifest(project).pluginContentHash, HASH_A);

    // Steady state: the same build must not churn the project on every hook.
    assert.equal(materializeProjectIfNeeded(project, { trigger: 'unit: no upgrade' }), null);
    assert.equal(materializedFromDifferentPluginBuild(project), false);

    // ── the upgrade: new content, SAME version ──
    fs.writeFileSync(path.join(plugin, 'skills-catalog', MUTABLE_SKILL, 'SKILL.md'), skillBodyFor('B'), 'utf8');
    setProvenance(plugin, { content: HASH_B });

    assertOldSignalsSayCurrent(project, 'after an unbumped upgrade');
    assert.equal(materializedFromDifferentPluginBuild(project), true, 'only the build comparison can see this');

    const upgraded = materializeProjectIfNeeded(project, { trigger: 'unit: release B' });
    assert.ok(upgraded, 'an unbumped upgrade must invoke the materializer');
    assert.equal(upgraded?.status, 'materialized', upgraded?.context);
    assert.match(materializedSkillBody(project), /RELEASE-MARKER:B/, 'the project now serves release B');
    assert.equal(readManifest(project).pluginContentHash, HASH_B);

    // Self-limiting: one pass, not a loop. The manifest rewrite is what ends it.
    assert.equal(materializeProjectIfNeeded(project, { trigger: 'unit: settled' }), null);
  });
});

test('a project materialized before the stamp existed converges exactly once', () => {
  withFixture({ provenance: { content: HASH_A }, release: 'A' }, ({ project }) => {
    seedProjectState(project);
    assert.equal(materializeProjectFromState(project, { trigger: 'unit: seed' }).status, 'materialized');

    // Strip the field, exactly as every install predating it looks. Nothing else
    // about the project changes — same bytes, same stamps, same version.
    const manifest = readManifest(project);
    delete manifest.pluginContentHash;
    fs.writeFileSync(path.join(project, '.traffic-one', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    assertOldSignalsSayCurrent(project, 'a pre-stamp install');

    const converged = materializeProjectIfNeeded(project, { trigger: 'unit: legacy install' });
    assert.ok(converged, 'a pre-stamp project converges once so the stamp can land');
    assert.equal(readManifest(project).pluginContentHash, HASH_A);
    assert.equal(materializeProjectIfNeeded(project, { trigger: 'unit: settled' }), null, 'and never again for this build');
  });
});

// ── the refusal that must survive ───────────────────────────────────────────

test('a stale build against a TORN root still refuses: nothing is swept, nothing is stamped', () => {
  withFixture({ tear: 'skills', provenance: { content: HASH_B }, release: 'B' }, ({ project }) => {
    seedProjectState(project);
    // The project already holds the full declared set from an earlier, whole
    // root; the manifest carries a DIFFERENT build, so the new condition says
    // "converge". The torn-root refusal must still win — an earlier lane
    // measured 46 of 47 skills deleted when it did not.
    const tracked = writeMaterializedContent(project, { state: { ...STATE } });
    const manifestPath = path.join(project, '.traffic-one', 'manifest.json');
    const manifest = { ...readManifest(project), pluginContentHash: HASH_A };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    assert.ok(tracked.skills.length > 20, 'the project starts with the whole skill set');
    assert.equal(materializedFromDifferentPluginBuild(project), true, 'the new condition does ask for a convergence');
    const before = new Map(tracked.skills.map((name) => [
      name,
      fs.readFileSync(path.join(project, '.traffic-one', 'skills', name, 'SKILL.md'), 'utf8'),
    ]));

    const result = materializeProjectAssets(project, { ...STATE });

    assert.equal(result.skipped, 'plugin-root-content-incomplete');
    assert.equal(result.removed, 0, 'not one skill may be swept by a build-driven convergence');
    assert.equal(result.written, 0);
    for (const [name, bytes] of before) {
      assert.equal(
        fs.readFileSync(path.join(project, '.traffic-one', 'skills', name, 'SKILL.md'), 'utf8'),
        bytes,
        `${name} is byte-identical`,
      );
    }
    // The refusal also leaves the stamp alone, so the project stays retryable
    // against a root that is repaired later rather than being recorded current
    // over a partial copy.
    assert.equal(readManifest(project).pluginContentHash, HASH_A);
  });
});

test('the declared content set is real, so the cases above are not asserting over an empty project', () => {
  withFixture({ provenance: { content: HASH_A } }, ({ project }) => {
    seedProjectState(project);
    const declared = declaredProjectContent(project, { ...STATE });
    assert.ok(declared.rules.length > 10, `expected the real rule spine, got ${declared.rules.length}`);
    assert.ok(declared.skills.includes(MUTABLE_SKILL), 'the mutated skill is one this project actually materializes');
  });
});
