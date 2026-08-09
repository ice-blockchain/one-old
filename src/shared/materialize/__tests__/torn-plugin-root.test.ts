// A plugin root that is TORN rather than empty, and the sweep it used to trigger.
//
// The measured failure: a root caught mid-`rsync` (or half-extracted, or copied
// by an interrupted host cache refresh) resolves SOME of what a project needs —
// 1 of 47 skills. Every clause of contentLossRefusal keys on `length === 0`, so
// nothing fired: cleanupPrevious deleted the other 46 previously materialized
// skills because they were manifest-tracked and absent from the new set, the
// manifest was rewritten to claim 1 skill, and the project was stamped
// `materializedAt` as though the run had succeeded. `.traffic-one/skills` is the
// project's ONLY copy, and the stamp then suppressed the retry that would have
// healed it.
//
// Three properties are proved here, and the third is what keeps the fix from
// being worse than the bug:
//
//   1. a torn root refuses, deletes nothing, and writes nothing;
//   2. a whole root still materializes the FULL declared set (a refusal that
//      also refused healthy roots would make every other case vacuous);
//   3. a legitimate upgrade — the previous manifest carries entries the current
//      release retired, so the resolved set is genuinely SMALLER than what the
//      project has — is NOT refused, and the retired assets are swept.
//
// Every case runs against a real 'installed' plugin root, asserted as such
// before it is relied on: the suite-wide root pinned by src/build/test-preload.mjs
// is this SOURCE checkout, which materializeProjectAssets refuses outright, and
// the torn root must ALSO classify 'installed' or the refusal under test would
// be the layout one wearing a different name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { pluginRootInfo } from '../../paths';
import { resetPluginUseCache } from '../../state/plugin-use';
import { materializeProjectAssets } from '../materialize';
import { declaredProjectContent, writeMaterializedContent, type ProjectContent } from './fixtures/materialized-content';

const STATE = {
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
  realtime: 'none',
  confirmed: true,
  onboardingComplete: true,
  mode: 'new-project',
} as const;

// 'whole' is the healthy install. 'skills'/'rules' are the two halves of a torn
// one: a tree whose entries exist but are a strict subset of what the running
// runtime declares. Both keep the FILE half of the `installed` predicate
// (scripts/hook-runtime.cjs) and both keep the other tree whole, because the
// ordinary rsync shape is a complete `rules/` beside a `skills-catalog/` that
// lost the race — not a uniformly shrunken tree.
// 'modes' is the third: `rules/**` is complete except for ONE mode rule, which
// is the tear the completeness check could not see until the mode candidates
// stopped being read from the root's own `rules/modes/` directory.
type Tear = 'whole' | 'skills' | 'rules' | 'modes';

const MODULES = path.resolve(__dirname, '..', '..', '..', 'modules');
const SOURCE_RULES = path.join(MODULES, 'rules', 'rules');
const SOURCE_SKILLS = path.join(MODULES, 'skills', 'skills-catalog');

// The one survivor of the tear. `project-memory` for skills and the auth gate
// for rules are both real entries of the shipped spine, so the resolved set is a
// real subset rather than a synthetic one.
const KEPT_SKILL = 'project-memory';
const KEPT_RULE = path.join('common', 'auth-gate.md');

// The single casualty of the 'modes' tear. STATE below resolves the `vite-react`
// profile, so cleanup.ts NEW_PROJECT_PROFILE_RULE_BY_ID declares exactly this
// path — which is what makes its absence a shortfall rather than a mode that
// ships nothing.
const TORN_MODE_RULE_REL = path.join('modes', 'new-project-vite-react.md');
const TORN_MODE_RULE_ID = 'rules/modes/new-project-vite-react.md';

interface Fixture {
  project: string;
  plugin: string;
}

function withRoot(tear: Tear, fn: (fixture: Fixture) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-torn-root-')));
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'scripts', 'hook-runtime.cjs'), '// test fixture stub\n', 'utf8');
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'traffic-one', version: '9.9.9' }), 'utf8');
  fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });

  if (tear === 'skills') {
    const kept = path.join(plugin, 'skills-catalog', KEPT_SKILL);
    fs.mkdirSync(kept, { recursive: true });
    fs.copyFileSync(path.join(SOURCE_SKILLS, KEPT_SKILL, 'SKILL.md'), path.join(kept, 'SKILL.md'));
  } else {
    fs.symlinkSync(SOURCE_SKILLS, path.join(plugin, 'skills-catalog'), 'dir');
  }
  if (tear === 'rules') {
    const kept = path.join(plugin, 'rules', KEPT_RULE);
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.copyFileSync(path.join(SOURCE_RULES, KEPT_RULE), kept);
  } else if (tear === 'modes') {
    // A COPY rather than the symlink, because exactly one file has to go
    // missing: deleting through the link would mutate the checkout.
    fs.cpSync(SOURCE_RULES, path.join(plugin, 'rules'), { recursive: true });
    fs.rmSync(path.join(plugin, 'rules', TORN_MODE_RULE_REL), { force: true });
  } else {
    fs.symlinkSync(SOURCE_RULES, path.join(plugin, 'rules'), 'dir');
  }

  const project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });

  const env = process.env;
  const saved = {
    root: env.TRAFFIC_ONE_PLUGIN_ROOT,
    host: env.TRAFFIC_ONE_HOST,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    home: env.HOME,
    xdg: env.XDG_STATE_HOME,
  };
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_HOST = 'codex';
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  env.HOME = path.join(base, 'home');
  env.XDG_STATE_HOME = path.join(base, 'xdg');
  resetPluginUseCache();
  try {
    fn({ project, plugin });
  } finally {
    for (const [key, value] of Object.entries({
      TRAFFIC_ONE_PLUGIN_ROOT: saved.root,
      TRAFFIC_ONE_HOST: saved.host,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      HOME: saved.home,
      XDG_STATE_HOME: saved.xdg,
    })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// What the running runtime declares for this project — the same config-side
// authority the writer resolves candidates from, and the reason this predicate
// survives an upgrade: `rules/**`, `skills-catalog/**` and those tables are
// emitted by one `npm run gen` from one commit.
const declared = (project: string): ProjectContent => declaredProjectContent(project, { ...STATE });

// A project that has ALREADY been materialized in full. Every file carries the
// GENERATED marker, so cleanupPrevious is willing to delete it — without that the
// sweep is a no-op and "nothing was deleted" would prove nothing.
const seedFullyMaterialized = (project: string, extra?: Partial<ProjectContent>): ProjectContent =>
  writeMaterializedContent(project, { state: { ...STATE }, extra });

function snapshot(project: string, tracked: ProjectContent): Map<string, string> {
  const t1 = path.join(project, '.traffic-one');
  const out = new Map<string, string>();
  out.set('manifest.json', fs.readFileSync(path.join(t1, 'manifest.json'), 'utf8'));
  for (const relPath of tracked.rules) out.set(relPath, fs.readFileSync(path.join(t1, relPath), 'utf8'));
  for (const name of tracked.skills) {
    out.set(`skills/${name}`, fs.readFileSync(path.join(t1, 'skills', name, 'SKILL.md'), 'utf8'));
  }
  return out;
}

// ── the fixtures, asserted before anything relies on them ───────────────────

test('all four fixture roots classify as installed — the torn ones too', () => {
  for (const tear of ['whole', 'skills', 'rules', 'modes'] as const) {
    withRoot(tear, () => {
      // A torn root that classified 'unverified' would make the cases below pass
      // on the LAYOUT refusal, and the completeness refusal could be deleted
      // without a single test noticing.
      assert.equal(pluginRootInfo().layout, 'installed', `${tear} root must classify installed`);
    });
  }
});

// ── 2. the whole root still materializes everything ─────────────────────────

test('a whole installed root materializes the full declared set — no refusal', () => {
  withRoot('whole', ({ project }) => {
    const expected = declared(project);
    const result = materializeProjectAssets(project, { ...STATE });

    assert.equal(result.skipped, undefined, `a complete root must not be refused, got ${result.skipped}`);
    assert.equal(result.torn, undefined, 'a complete root carries no torn evidence');
    // Positively, per entry: counting writes would also be satisfied by a run
    // that wrote the wrong 45 files.
    for (const relPath of expected.rules) {
      assert.ok(fs.existsSync(path.join(project, '.traffic-one', relPath)), `materialized ${relPath}`);
    }
    for (const name of expected.skills) {
      assert.ok(
        fs.existsSync(path.join(project, '.traffic-one', 'skills', name, 'SKILL.md')),
        `materialized skill ${name}`,
      );
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.deepEqual([...(manifest.skills as string[])].sort(), expected.skills, 'the manifest tracks every declared skill');
    assert.ok(expected.skills.length > 20, `the declared set must be the real one, got ${expected.skills.length}`);
    assert.ok(result.rules > 20, `expected the real rule spine, got ${result.rules}`);
  });
});

// ── 1. the torn root refuses and deletes nothing ────────────────────────────

test('a torn skills-catalog: refused, nothing deleted, nothing written, manifest byte-identical', () => {
  withRoot('skills', ({ project }) => {
    const tracked = seedFullyMaterialized(project);
    const before = snapshot(project, tracked);
    assert.ok(tracked.skills.length > 20, 'the project starts with the whole skill set materialized');

    const result = materializeProjectAssets(project, { ...STATE });

    assert.equal(result.skipped, 'plugin-root-content-incomplete');
    assert.equal(result.removed, 0, 'not one manifest-tracked asset may be swept');
    assert.equal(result.written, 0, 'and nothing may be rewritten either');
    // The exact shape of the reported incident: 1 of N resolves.
    assert.equal(result.skills, 1, 'the torn root resolves exactly the one surviving skill');
    assert.equal(result.torn?.skills.resolved, 1);
    assert.equal(result.torn?.skills.candidates, tracked.skills.length);
    assert.equal(result.torn?.skills.missing.length, tracked.skills.length - 1);
    assert.equal(result.torn?.skills.missing.includes(KEPT_SKILL), false, 'the survivor is not reported missing');
    assert.deepEqual(result.torn?.rules.missing, [], 'the whole rules/ tree is not implicated');

    for (const [key, bytes] of before) {
      const file = key === 'manifest.json'
        ? path.join(project, '.traffic-one', 'manifest.json')
        : key.startsWith('skills/')
          ? path.join(project, '.traffic-one', 'skills', key.slice('skills/'.length), 'SKILL.md')
          : path.join(project, '.traffic-one', key);
      assert.equal(fs.existsSync(file), true, `${key} still exists`);
      assert.equal(fs.readFileSync(file, 'utf8'), bytes, `${key} is byte-identical`);
    }
  });
});

test('a torn rules/ tree is caught the same way, with the skills catalog whole', () => {
  withRoot('rules', ({ project }) => {
    const tracked = seedFullyMaterialized(project);
    const before = snapshot(project, tracked);

    const result = materializeProjectAssets(project, { ...STATE });

    assert.equal(result.skipped, 'plugin-root-content-incomplete');
    assert.equal(result.removed, 0);
    assert.equal(result.written, 0);
    assert.ok((result.torn?.rules.missing.length ?? 0) > 10, 'the rule shortfall is reported in full');
    assert.equal(result.torn?.rules.missing.includes(`rules/${KEPT_RULE}`), false, 'the survivor is not reported missing');
    assert.deepEqual(result.torn?.skills.missing, [], 'the whole catalog is not implicated');
    for (const [key, bytes] of before) {
      const file = key === 'manifest.json'
        ? path.join(project, '.traffic-one', 'manifest.json')
        : key.startsWith('skills/')
          ? path.join(project, '.traffic-one', 'skills', key.slice('skills/'.length), 'SKILL.md')
          : path.join(project, '.traffic-one', key);
      assert.equal(fs.readFileSync(file, 'utf8'), bytes, `${key} is byte-identical`);
    }
  });
});

test('a first run against a torn root is refused too — a project with nothing to lose is not stamped over a partial copy', () => {
  withRoot('skills', ({ project }) => {
    // No previous manifest at all. The refusal deliberately does not consult
    // one: completing this run would write a manifest claiming 1 skill and let
    // converge.ts stamp it, which is the half that never self-heals.
    const result = materializeProjectAssets(project, { ...STATE });
    assert.equal(result.skipped, 'plugin-root-content-incomplete');
    assert.equal(result.written, 0);
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'manifest.json')), false, 'no manifest was minted');
  });
});

// ── 1b. the tear confined to rules/modes/** ─────────────────────────────────
// The declared residual, closed. Mode rules used to be absent from the rule
// candidate set because both resolvers derive them WITH the root in hand
// (cleanup.ts modeRulesForState / modeReferenceRulesForState take a `root` and
// filter by existsSync), so a mode rule a torn tree lost simply dropped out of
// the resolved set and left no trace of having been expected.
//
// Measured before the fix, on this exact fixture: skipped=undefined,
// removed=1 — the project's only copy of the mode rule was deleted and the
// manifest was rewritten without it, while the run reported success and the
// caller stamped `materializedAt` over it.
//
// What made it fixable is that the expected set has an authority that is NOT
// the root's own directory: the spine comes from MODE_SPINE_RULE_BY_MODE and
// the profile rule from NEW_PROJECT_PROFILE_RULE_BY_ID, both compiled from the
// same commit that emits `rules/**`.
test('a torn rules/modes/ is caught: one missing mode rule refuses instead of sweeping the project copy', () => {
  withRoot('modes', ({ project }) => {
    const tracked = seedFullyMaterialized(project, { rules: [TORN_MODE_RULE_ID] });
    const modeCopy = path.join(project, '.traffic-one', TORN_MODE_RULE_ID);
    // The baseline that keeps this from passing vacuously: the project really
    // does hold the file the sweep would take, and the manifest really tracks it
    // (cleanupPrevious only deletes manifest-tracked, marker-carrying assets).
    assert.equal(fs.existsSync(modeCopy), true, 'the project starts with the mode rule materialized');
    assert.ok(tracked.rules.includes(TORN_MODE_RULE_ID), 'and the manifest tracks it, so the sweep is willing');
    const before = snapshot(project, tracked);

    const result = materializeProjectAssets(project, { ...STATE });

    assert.equal(result.skipped, 'plugin-root-content-incomplete');
    assert.equal(result.removed, 0, 'not one manifest-tracked asset may be swept');
    assert.equal(result.written, 0);
    assert.deepEqual(
      result.torn?.rules.missing,
      [TORN_MODE_RULE_ID],
      'the shortfall names the mode rule, and nothing else in a tree that is otherwise whole',
    );
    assert.deepEqual(result.torn?.skills.missing, [], 'the catalog is not implicated');
    assert.equal(fs.existsSync(modeCopy), true, 'the project copy survives');
    for (const [key, bytes] of before) {
      const file = key === 'manifest.json'
        ? path.join(project, '.traffic-one', 'manifest.json')
        : key.startsWith('skills/')
          ? path.join(project, '.traffic-one', 'skills', key.slice('skills/'.length), 'SKILL.md')
          : path.join(project, '.traffic-one', key);
      assert.equal(fs.readFileSync(file, 'utf8'), bytes, `${key} is byte-identical`);
    }
  });
});

// ── 3. the false-refusal guard ──────────────────────────────────────────────

test('a legitimate upgrade that retires a rule and a skill is NOT refused, and the retired assets are swept', () => {
  withRoot('whole', ({ project }) => {
    // The shape of an upgrade: the project was materialized by an OLDER release
    // whose config declared two entries this one has retired. The resolved set is
    // therefore genuinely smaller than the manifest — 2 fewer rules and skills —
    // which is exactly what a "resolved < previous manifest" comparison would
    // refuse on, and why this predicate reads the CONFIG-declared candidate set
    // instead: the retired entries are not candidates any more, so nothing is
    // missing and the run proceeds.
    const retiredRule = 'rules/common/retired-by-an-upgrade.md';
    const retiredSkill = 'retired-by-an-upgrade';
    const tracked = seedFullyMaterialized(project, { rules: [retiredRule], skills: [retiredSkill] });
    const current = declared(project);
    assert.equal(tracked.rules.length, current.rules.length + 1, 'the manifest carries more rules than the release declares');
    assert.equal(tracked.skills.length, current.skills.length + 1, 'and more skills');

    const result = materializeProjectAssets(project, { ...STATE });

    assert.equal(result.skipped, undefined, `an upgrade must not be refused, got ${result.skipped}`);
    assert.equal(result.torn, undefined);
    assert.ok(result.removed >= 2, `the retired rule and skill are swept, got removed=${result.removed}`);
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', retiredRule)), false, 'retired rule is gone');
    assert.equal(
      fs.existsSync(path.join(project, '.traffic-one', 'skills', retiredSkill)),
      false,
      'retired skill is gone',
    );
    // And everything the release DOES declare survived the sweep.
    for (const name of current.skills) {
      assert.ok(
        fs.existsSync(path.join(project, '.traffic-one', 'skills', name, 'SKILL.md')),
        `${name} survived the upgrade`,
      );
    }
    for (const relPath of current.rules) {
      assert.ok(fs.existsSync(path.join(project, '.traffic-one', relPath)), `${relPath} survived the upgrade`);
    }
  });
});
