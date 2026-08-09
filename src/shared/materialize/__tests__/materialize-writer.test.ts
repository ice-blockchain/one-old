import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { HOST_IDS, HOST_PLAN_IDS } from '../../../config/model-tiers';
import { BOOTSTRAP_SKILLS, PROJECT_UNAVAILABLE_SKILLS } from '../../../config/skill-filters';
import { capabilityProfileForRun, capabilityStateForRun, ensureArchitectureRunSnapshot } from '../../architecture-contract';
import {
  eligibleRolesForProfile,
  runtimeCapabilityStateFromProfile,
} from '../../capabilities';
import { activeSkillsFor, activeSkillsForProject } from '../../skill-filters';
import { modelTierSnapshot } from '../../model-tiers';
import { pluginRootInfo } from '../../paths';
import { roleScopedRules, stackSpecForState } from '../../stacks';
import { GENERATED_MARKER } from '../generated';
import { cleanupPrevious } from '../cleanup';
import { hasMaterializedProjectAssets } from '../has-assets';
import { materializeProjectAssets } from '../materialize';
import { openCodeGlobalAgentPath } from '../opencode-assets';
import { pluginUseDeclined, recordPluginUseChoice } from '../../state/plugin-use';
import { assertInstalledPluginRoot } from './fixtures/installed-root';

// A COMPLETE 'installed' plugin root: the compiled runtime entry plus the real
// shipped content trees, reached through symlinks so nothing is copied and the
// resolved set is byte-current with the checkout.
//
// It used to ship two hand-written rule files and three skills, and that is no
// longer a plugin root the writer will touch: materializeProjectAssets now
// refuses a root that cannot satisfy the whole candidate set its own runtime
// declares (materialize.ts tornRootRefusal), and a 2-of-23 rule spine is the
// exact shape of the partially copied tree that refusal exists to catch. The
// stub was never a realistic install — a real one always carries the whole
// tree — so making it real is what keeps these tests characterizing
// materialization instead of characterizing a refusal.
function withPluginAndProject(fn: (project: string, plugin: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-matwriter-'));
  const plugin = path.join(base, 'plugin');
  const modules = path.resolve(__dirname, '..', '..', '..', 'modules');
  // classifyPluginRootLayout (src/shared/paths.ts) only calls a root 'installed'
  // when it carries BOTH the compiled runtime entry AND generated content —
  // without this stub, this fixture (content-only) classifies 'unverified' and
  // materializeProjectAssets now refuses to touch disk against it.
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'scripts', 'hook-runtime.cjs'), '// test fixture stub\n', 'utf8');
  fs.symlinkSync(path.join(modules, 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
  fs.symlinkSync(path.join(modules, 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
  // Real role agent docs, because the Codex materializer's whole job is to carry
  // the FULL body to a host that cannot receive it any other way. A stub body
  // would let a truncating regression pass.
  fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
  for (const role of ['senior-frontend', 'senior-backend']) {
    fs.copyFileSync(
      path.resolve(__dirname, '..', '..', '..', 'modules', role, 'agent.md'),
      path.join(plugin, 'agents', `${role}.md`),
    );
  }
  const project = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const env = process.env;
  const prevPlugin = env.TRAFFIC_ONE_PLUGIN_ROOT;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevHost = env.TRAFFIC_ONE_HOST;
  const prevHome = env.HOME;
  const prevXdgConfig = env.XDG_CONFIG_HOME;
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  env.TRAFFIC_ONE_HOST = 'codex';
  env.HOME = home;
  delete env.XDG_CONFIG_HOME;
  try {
    // Before anything relies on it. 43 of this file's materializeProjectAssets
    // calls run through here, and every one of them would pass over a refusal —
    // silently, having written and deleted nothing — if this root ever stopped
    // classifying 'installed'.
    assertInstalledPluginRoot('materialize-writer fixture');
    fn(project, plugin);
  } finally {
    if (prevPlugin === undefined) delete env.TRAFFIC_ONE_PLUGIN_ROOT; else env.TRAFFIC_ONE_PLUGIN_ROOT = prevPlugin;
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevHost === undefined) delete env.TRAFFIC_ONE_HOST; else env.TRAFFIC_ONE_HOST = prevHost;
    if (prevHome === undefined) delete env.HOME; else env.HOME = prevHome;
    if (prevXdgConfig === undefined) delete env.XDG_CONFIG_HOME; else env.XDG_CONFIG_HOME = prevXdgConfig;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function generatedProjectText(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push(target);
    }
  };
  walk(root);
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

function modelTokenPattern(model: string): RegExp {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9/_.-])${escaped}(?=$|[^A-Za-z0-9/_.-])`, 'm');
}

test('materializeProjectAssets writes rules + skills + manifest + AGENTS.md/CLAUDE.md', () => {
  withPluginAndProject((project) => {
    const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, mode: 'new-project' };
    const result = materializeProjectAssets(project, state);
    assert.ok(result.rules >= 1);
    assert.ok(result.skills >= 1);
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'rules', 'common', 'auth-gate.md')), true);
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'skills', 'project-memory', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), true);
    assert.equal(fs.existsSync(path.join(project, 'CLAUDE.md')), true);
    assert.equal(hasMaterializedProjectAssets(project, state), true);
    // Codex is a `plugin-injected-fallback` host: the child gets a ~2.5k kernel
    // excerpt in its SessionStart header and nothing else, so without a file on
    // disk its role contract simply does not reach it. Kilo, Copilot and
    // Windsurf all inline the full `roleAgentBody`; this asserts Codex has the
    // same. The length bar is what makes it a regression test — an empty or
    // kernel-sized file would satisfy mere existence.
    const contract = path.join(project, '.traffic-one', 'agents', 'senior-frontend.md');
    assert.equal(fs.existsSync(contract), true, 'the codex role contract must be materialized');
    assert.ok(
      fs.readFileSync(contract, 'utf8').length > 4000,
      'the contract must be the full role doc, not the kernel excerpt',
    );
    // re-run keeps the materialization valid
    materializeProjectAssets(project, state);
    assert.equal(hasMaterializedProjectAssets(project, state), true);
  });
});

// ── 'unverified' plugin root refusal (the incident this guards against) ────
// materializeProjectAssets filters its rule/skill lists by existsSync against
// pluginRoot(); an unresolvable root emptied both lists, and cleanupPrevious
// then read that emptiness as "nothing is active" and deleted every
// previously materialized rule/skill. A resolved-but-'unverified' root must
// refuse instead of reaching that path at all.
test("materializeProjectAssets refuses an 'unverified' plugin root: preserves existing rules/skills, runs no cleanup", () => {
  withPluginAndProject((project) => {
    const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, mode: 'new-project' };
    const first = materializeProjectAssets(project, state);
    assert.ok(first.rules >= 1 && first.skills >= 1, 'setup: real materialization against the good fixture root');
    const rulePath = path.join(project, '.traffic-one', 'rules', 'common', 'auth-gate.md');
    const skillPath = path.join(project, '.traffic-one', 'skills', 'project-memory', 'SKILL.md');
    const manifestPath = path.join(project, '.traffic-one', 'manifest.json');
    assert.equal(fs.existsSync(rulePath), true);
    assert.equal(fs.existsSync(skillPath), true);

    // Repoint at a directory that plainly exists but carries none of the
    // 'installed'/'source' markers (see classifyPluginRootLayout).
    const unverifiedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-matwriter-unverified-'));
    fs.writeFileSync(path.join(unverifiedRoot, 'README.txt'), 'not a plugin\n', 'utf8');
    const prevPlugin = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = unverifiedRoot;
    let second;
    try {
      second = materializeProjectAssets(project, state);
    } finally {
      if (prevPlugin === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = prevPlugin;
      fs.rmSync(unverifiedRoot, { recursive: true, force: true });
    }

    assert.equal(second.skipped, 'plugin-root-unverified');
    assert.equal(second.rules, 0);
    assert.equal(second.skills, 0);
    assert.equal(second.written, 0);
    assert.equal(second.removed, 0, 'no cleanup — the whole point is nothing gets swept');
    // The files from the first (good-root) run must be untouched.
    assert.equal(fs.existsSync(rulePath), true, 'previously materialized rule survives an unverified root');
    assert.equal(fs.existsSync(skillPath), true, 'previously materialized skill survives an unverified root');
    assert.equal(fs.existsSync(manifestPath), true, 'previously written manifest survives an unverified root');
    assert.ok(
      fs.readFileSync(rulePath, 'utf8').includes(
        fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules', 'common', 'auth-gate.md'), 'utf8').trimEnd(),
      ),
      'byte-identical to the first (good-root) run',
    );
  });
});

// ── The destruction guard, per layout ───────────────────────────────────────
// `written > 0` is NOT evidence of a healthy run and must never be the
// assertion: AGENTS.md, CLAUDE.md and manifest.json are written
// host-agnostically, so a run that resolved zero rules and zero skills and
// deleted every materialized file still reports `written: 5`. Everything below
// asserts the four numbers that describe what actually happened (`rules`,
// `skills`, `removed`, `skipped`) plus the on-disk tree and its BYTES.

const REFUSAL_STATE = {
  stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' },
  onboardingComplete: true, mode: 'new-project',
} as const;

function trafficOneTree(project: string): string[] {
  const root = path.join(project, '.traffic-one');
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function fileBytes(project: string, relPaths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of relPaths) out.set(rel, fs.readFileSync(path.join(project, '.traffic-one', rel), 'utf8'));
  return out;
}

// The WHOLE project, not just `.traffic-one/` — the consent contract is a
// byte-identical tree, and this writer's reach includes `.gitignore`,
// `AGENTS.md`, `CLAUDE.md` and `.cursor/**` at the project root, none of which
// the path fence in shared/fsjson.ts guards (it only knows `.traffic-one/`).
function projectSnapshot(project: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(project, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        out.set(`${rel}/`, '');
        walk(abs);
      } else if (entry.isSymbolicLink()) out.set(rel, `symlink:${fs.readlinkSync(abs)}`);
      else out.set(rel, fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(project);
  return out;
}

// A real authoring checkout: the source markers plus rules and skills at their
// SOURCE paths (src/modules/**), which is exactly what makes this the incident —
// `<root>/rules/**` and `<root>/skills-catalog/**` resolve to nothing.
function buildSourceCheckout(dir: string, plugin: string): void {
  fs.mkdirSync(path.join(dir, 'src', 'gen', 'static'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'gen', 'static', 'plugin-instructions.md'), '# stub\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
  fs.cpSync(path.join(plugin, 'rules'), path.join(dir, 'src', 'modules', 'rules', 'rules'), { recursive: true });
  fs.cpSync(path.join(plugin, 'skills-catalog'), path.join(dir, 'src', 'modules', 'skills', 'skills-catalog'), { recursive: true });
  for (const role of ['senior-frontend', 'senior-backend']) {
    const dest = path.join(dir, 'src', 'modules', role, 'agent.md');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(plugin, 'agents', `${role}.md`), dest);
  }
}

interface RefusalRoot {
  readonly name: string;
  readonly layout: 'installed' | 'source' | 'unverified';
  readonly skipped: string;
  readonly rulesResolve: 'none' | 'some';
  readonly build: (dir: string, plugin: string) => void;
}

const REFUSAL_ROOTS: readonly RefusalRoot[] = [
  {
    name: 'unverified: an unrelated directory',
    layout: 'unverified',
    skipped: 'plugin-root-unverified',
    rulesResolve: 'none',
    build: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.txt'), 'not a plugin\n', 'utf8');
    },
  },
  {
    // BLOCKER 2: classified 'installed' before the fix, because existsSync is
    // true for an empty directory.
    name: 'unverified: compiled runtime + EMPTY rules/ (a dist caught mid-gen)',
    layout: 'unverified',
    skipped: 'plugin-root-unverified',
    rulesResolve: 'none',
    build: (dir) => {
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scripts', 'hook-runtime.cjs'), '// stub\n', 'utf8');
      fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
    },
  },
  {
    // BLOCKER 1: the reported incident.
    name: 'source: a real authoring checkout (rules/skills under src/modules/**)',
    layout: 'source',
    skipped: 'plugin-root-source-checkout',
    rulesResolve: 'none',
    build: buildSourceCheckout,
  },
  {
    // The case no classifier can catch: a root that IS a well-formed install by
    // every structural test, and still resolves nothing this project needs. This
    // is the row that proves the guard is layout-independent.
    name: 'installed: runtime + rules/ carrying no rule this project uses, no skills-catalog',
    layout: 'installed',
    skipped: 'resolved-content-empty',
    rulesResolve: 'none',
    build: (dir) => {
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scripts', 'hook-runtime.cjs'), '// stub\n', 'utf8');
      fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'rules', 'unrelated.md'), '# not a Traffic One rule\n', 'utf8');
    },
  },
  {
    // Half-resolvable: every rule resolves, every skill does not. Losing all
    // skills is the same permanent capability loss as losing all rules, so the
    // guard is per-kind and this must refuse too.
    name: 'installed: complete rules/, EMPTY skills-catalog/ (an in-flight rsync)',
    layout: 'installed',
    skipped: 'resolved-content-empty',
    rulesResolve: 'some',
    build: (dir, plugin) => {
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scripts', 'hook-runtime.cjs'), '// stub\n', 'utf8');
      fs.cpSync(path.join(plugin, 'rules'), path.join(dir, 'rules'), { recursive: true });
      fs.cpSync(path.join(plugin, 'agents'), path.join(dir, 'agents'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'skills-catalog'), { recursive: true });
    },
  },
];

test('materializeProjectAssets: for EVERY plugin-root layout, a resolved-empty content set preserves the project byte-for-byte', () => {
  for (const row of REFUSAL_ROOTS) {
    withPluginAndProject((project, plugin) => {
      // The use-plugin write fence (shared/state/plugin-use.ts) governs
      // `.traffic-one/**`, so consent is part of the setup: without it there is
      // no materialized content for the guard to protect.
      recordPluginUseChoice(project, true, 'test');
      const first = materializeProjectAssets(project, { ...REFUSAL_STATE });
      assert.equal(first.skipped, undefined, `${row.name}: setup must materialize against the good root`);
      assert.ok(first.rules >= 2 && first.skills >= 1, `${row.name}: setup resolved ${first.rules} rules / ${first.skills} skills`);

      const treeBefore = trafficOneTree(project);
      const bytesBefore = fileBytes(project, treeBefore);
      const agentsBefore = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
      assert.ok(treeBefore.includes('rules/common/auth-gate.md'), `${row.name}: setup wrote the rule`);
      assert.ok(treeBefore.includes('skills/project-memory/SKILL.md'), `${row.name}: setup wrote the skill`);
      assert.ok(treeBefore.includes('manifest.json'));

      const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-matwriter-refuse-'));
      row.build(brokenRoot, plugin);
      const prevPlugin = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
      process.env.TRAFFIC_ONE_PLUGIN_ROOT = brokenRoot;
      let layout;
      let second;
      try {
        layout = pluginRootInfo().layout;
        second = materializeProjectAssets(project, { ...REFUSAL_STATE });
      } finally {
        if (prevPlugin === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = prevPlugin;
        fs.rmSync(brokenRoot, { recursive: true, force: true });
      }

      assert.equal(layout, row.layout, `${row.name}: fixture must actually classify ${row.layout}`);
      assert.equal(second.skipped, row.skipped, row.name);
      assert.equal(second.skills, 0, `${row.name}: no skill resolved`);
      if (row.rulesResolve === 'none') assert.equal(second.rules, 0, `${row.name}: no rule resolved`);
      else assert.ok(second.rules > 0, `${row.name}: rules resolved, only skills did not`);
      assert.equal(second.written, 0, `${row.name}: a refused run writes nothing`);
      assert.equal(second.removed, 0, `${row.name}: a refused run deletes nothing`);

      assert.deepEqual(trafficOneTree(project), treeBefore, `${row.name}: the on-disk tree is identical`);
      for (const [rel, body] of bytesBefore) {
        assert.equal(fs.readFileSync(path.join(project, '.traffic-one', rel), 'utf8'), body, `${row.name}: ${rel} is byte-identical`);
      }
      assert.equal(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), agentsBefore, `${row.name}: AGENTS.md (rule index included) is byte-identical`);
    });
  }
});

// The reported incident, asserted as its own regression rather than as one row
// of a table: a project materialized from a healthy install, then a hook run
// whose *_PLUGIN_ROOT resolved the Traffic One SOURCE checkout. Two of the four
// env vars that can supply that root (CLAUDE_PLUGIN_ROOT, CODEX_PLUGIN_ROOT) are
// set by the HOST, so this is reachable without Traffic One doing anything.
// Before the fix: rules 0, skills 0, removed 3 — auth-gate.md, core.md and
// project-memory/SKILL.md deleted, AGENTS.md rewritten with an empty rule index.
test("materializeProjectAssets: the 'source'-root incident — all three materialized files survive, through every *_PLUGIN_ROOT var", () => {
  for (const key of ['TRAFFIC_ONE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CURSOR_PLUGIN_ROOT'] as const) {
    withPluginAndProject((project, plugin) => {
      recordPluginUseChoice(project, true, 'test');
      const first = materializeProjectAssets(project, { ...REFUSAL_STATE });
      assert.equal(first.skipped, undefined);
      const survivors = ['rules/common/auth-gate.md', 'rules/core.md', 'skills/project-memory/SKILL.md'];
      const bytesBefore = fileBytes(project, survivors);
      const ruleIndexBefore = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')
        .split('\n').filter((line) => /\.traffic-one\/rules\/\S+\.md/.test(line)).length;
      assert.ok(ruleIndexBefore >= 2, 'setup: AGENTS.md indexes the materialized rules');

      const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-matwriter-source-'));
      buildSourceCheckout(sourceRoot, plugin);
      const savedTraffic = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
      const savedKey = process.env[key];
      let second;
      try {
        // The pinned TRAFFIC_ONE_PLUGIN_ROOT wins over the other three, so it
        // has to be out of the way for a host-supplied var to be exercised.
        delete process.env.TRAFFIC_ONE_PLUGIN_ROOT;
        process.env[key] = sourceRoot;
        second = materializeProjectAssets(project, { ...REFUSAL_STATE });
      } finally {
        if (savedKey === undefined) delete process.env[key]; else process.env[key] = savedKey;
        if (savedTraffic === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = savedTraffic;
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }

      assert.equal(second.skipped, 'plugin-root-source-checkout', `${key}: a source checkout is not a content root`);
      assert.deepEqual(
        { rules: second.rules, skills: second.skills, written: second.written, removed: second.removed },
        { rules: 0, skills: 0, written: 0, removed: 0 },
        `${key}: nothing resolved, nothing written, nothing removed`,
      );
      for (const [rel, body] of bytesBefore) {
        assert.equal(fs.existsSync(path.join(project, '.traffic-one', rel)), true, `${key}: ${rel} survives`);
        assert.equal(fs.readFileSync(path.join(project, '.traffic-one', rel), 'utf8'), body, `${key}: ${rel} is byte-identical`);
      }
      const ruleIndexAfter = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')
        .split('\n').filter((line) => /\.traffic-one\/rules\/\S+\.md/.test(line)).length;
      assert.equal(ruleIndexAfter, ruleIndexBefore, `${key}: the AGENTS.md rule index is not emptied`);
    });
  }
});

// The same broken roots reaching a project that has nothing to lose YET. There
// is no deletion to prevent here — what must not happen is a manifest claiming
// `rules: []`, an AGENTS.md with an empty rule index, and a caller stamping the
// project "materialized" over nothing (the half of the incident that never
// self-heals).
test('materializeProjectAssets: a first run against a content-less root writes nothing at all', () => {
  withPluginAndProject((project) => {
    recordPluginUseChoice(project, true, 'test');
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-matwriter-firstrun-'));
    fs.mkdirSync(path.join(brokenRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(brokenRoot, 'scripts', 'hook-runtime.cjs'), '// stub\n', 'utf8');
    fs.mkdirSync(path.join(brokenRoot, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(brokenRoot, 'rules', 'unrelated.md'), '# not a rule\n', 'utf8');
    const prevPlugin = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = brokenRoot;
    let result;
    let layout;
    try {
      layout = pluginRootInfo().layout;
      result = materializeProjectAssets(project, { ...REFUSAL_STATE });
    } finally {
      if (prevPlugin === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = prevPlugin;
      fs.rmSync(brokenRoot, { recursive: true, force: true });
    }

    assert.equal(layout, 'installed', 'the fixture is structurally a valid install');
    assert.equal(result.skipped, 'resolved-content-empty');
    assert.deepEqual(
      { rules: result.rules, skills: result.skills, written: result.written, removed: result.removed },
      { rules: 0, skills: 0, written: 0, removed: 0 },
    );
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'manifest.json')), false, 'no manifest claiming an empty materialization');
    assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), false, 'no AGENTS.md with an empty rule index');
    assert.equal(hasMaterializedProjectAssets(project, { ...REFUSAL_STATE }), false);
  });
});

// Behaviour-neutrality for the healthy case: the guards above must cost a real
// installed root exactly nothing.
//
// This is the assertion the refusals make load-bearing. Every test in this file
// gets easier to pass by REFUSING — a refused run writes nothing, deletes
// nothing and preserves every byte — so at least one case has to prove the
// positive: a complete root still materializes the WHOLE declared set. The
// expected sets are recomputed from the same config the writer resolves from
// (that is the contract: everything declared reaches disk, not merely something
// did), and the floors underneath them are what stops the comparison from
// passing vacuously if that config ever collapsed to a handful of entries.
test('materializeProjectAssets: a healthy installed root materializes the FULL declared set, and a repeat run is a byte no-op', () => {
  withPluginAndProject((project) => {
    recordPluginUseChoice(project, true, 'test');
    const first = materializeProjectAssets(project, { ...REFUSAL_STATE });
    assert.equal(first.skipped, undefined);
    assert.equal(first.removed, 0);
    assert.ok(first.written > 50, `expected a full materialization, got ${first.written} writes`);

    const expectedSkills = [...activeSkillsForProject(project, { ...REFUSAL_STATE }, 'codex')]
      .filter((name) => !BOOTSTRAP_SKILLS.has(name) && !PROJECT_UNAVAILABLE_SKILLS.has(name))
      .sort();
    const mandatory = stackSpecForState(capabilityStateForRun(project, { ...REFUSAL_STATE })).mandatory;
    assert.ok(expectedSkills.length > 20, `fixture sanity: ${expectedSkills.length} declared skills`);
    assert.ok(mandatory.length > 15, `fixture sanity: ${mandatory.length} mandatory rules`);

    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.skills, expectedSkills, 'every declared skill is tracked');
    assert.equal(first.skills, expectedSkills.length);
    assert.ok(first.rules >= mandatory.length, `${first.rules} rules resolved, spine is ${mandatory.length}`);
    for (const relPath of mandatory) {
      assert.ok(manifest.rules.includes(relPath), `${relPath} is tracked`);
      assert.equal(fs.existsSync(path.join(project, '.traffic-one', relPath)), true, `${relPath} is on disk`);
    }
    const tree = trafficOneTree(project);
    for (const name of expectedSkills) {
      assert.ok(tree.includes(`skills/${name}/SKILL.md`), `skills/${name}/SKILL.md written`);
    }
    assert.ok(tree.includes('rules/common/auth-gate.md') && tree.includes('rules/core.md'));
    assert.ok(tree.includes('manifest.json'));
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'skills', 'model-tier-sync')), false);

    const second = materializeProjectAssets(project, { ...REFUSAL_STATE });
    assert.equal(second.skipped, undefined, 'a healthy repeat run is never refused');
    assert.deepEqual(
      { rules: second.rules, skills: second.skills, written: second.written, removed: second.removed },
      { rules: first.rules, skills: first.skills, written: 0, removed: 0 },
    );
    assert.deepEqual(trafficOneTree(project), tree);
  });
});

test('a repeat materializeProjectAssets run is a no-op: written 0, stable skill mtimes and manifest bytes', () => {
  withPluginAndProject((project) => {
    const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, mode: 'new-project' };
    const first = materializeProjectAssets(project, state);
    assert.ok(first.written > 0);
    const skillPath = path.join(project, '.traffic-one', 'skills', 'project-memory', 'SKILL.md');
    const manifestPath = path.join(project, '.traffic-one', 'manifest.json');
    const skillMtime = fs.statSync(skillPath).mtimeMs;
    const manifestText = fs.readFileSync(manifestPath, 'utf8');

    const second = materializeProjectAssets(project, state);
    assert.equal(second.written, 0, 'repeat run must not rewrite anything');
    assert.equal(second.removed, 0);
    assert.equal(fs.statSync(skillPath).mtimeMs, skillMtime, 'skill files keep their mtime');
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestText, 'manifest bytes (incl. generatedAt) are stable');

    // A real content change (different backend → different rules) still writes.
    const third = materializeProjectAssets(project, { ...state, backend: 'none' });
    assert.ok(third.written > 0);
    assert.notEqual(fs.readFileSync(manifestPath, 'utf8'), manifestText);
  });
});

test('cleanupPrevious removes a stale generated rule no longer in the next set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cleanup-'));
  try {
    const stale = path.join(dir, '.traffic-one', 'rules', 'old.md');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, `${GENERATED_MARKER}\nstale`, 'utf8');
    const removed = cleanupPrevious(dir, { rules: ['rules/old.md'], skills: [] }, new Set(['rules/common/auth-gate.md']), new Set());
    assert.ok(removed >= 1);
    assert.equal(fs.existsSync(stale), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// These two asserted the root file was GONE and that the migration counted as a
// removal. That was the defect, not the contract: `api.md`, `database.md`,
// `deployment.md`, `environment-setup.md` and `security.md` are ordinary
// filenames, nothing on disk proves Traffic One wrote the one at this project's
// root, and the move deleted all five from a documentation repository it had
// never written a byte into. The canonical copy under `.traffic-one/` — the only
// half anything reads — is still asserted, in full.
test('cleanupPrevious copies legacy root docs into .traffic-one and leaves the root file alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cleanup-docs-'));
  try {
    fs.writeFileSync(path.join(dir, 'api.md'), '# API\n\nRoot API notes.\n', 'utf8');

    const removed = cleanupPrevious(dir, { rules: [], skills: [] }, new Set(), new Set());

    assert.equal(removed, 0, 'a copy is not a removal');
    assert.equal(fs.readFileSync(path.join(dir, 'api.md'), 'utf8'), '# API\n\nRoot API notes.\n');
    assert.equal(
      fs.readFileSync(path.join(dir, '.traffic-one', 'api.md'), 'utf8'),
      '# API\n\nRoot API notes.\n',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupPrevious compacts duplicate root security docs into .traffic-one/security.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cleanup-security-'));
  try {
    const trafficOne = path.join(dir, '.traffic-one');
    fs.mkdirSync(trafficOne, { recursive: true });
    fs.writeFileSync(path.join(trafficOne, 'security.md'), '# Security Memory\n\n- No secrets.\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'security.md'), '# Security\n\n- RLS must be default-deny.\n', 'utf8');

    const removed = cleanupPrevious(dir, { rules: [], skills: [] }, new Set(), new Set());

    assert.equal(removed, 0, 'a copy is not a removal');
    assert.equal(fs.existsSync(path.join(dir, 'security.md')), true, 'the root file stays where its owner put it');
    const security = fs.readFileSync(path.join(trafficOne, 'security.md'), 'utf8');
    assert.ok(security.includes('# Security Memory'));
    assert.ok(security.includes('## Migrated From Root `security.md`'));
    assert.ok(security.includes('RLS must be default-deny.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider-adopted skills are indexed in AGENTS.md but stay out of the manifest', () => {
  withPluginAndProject((project) => {
    // A provider skill relocated into .traffic-one/skills (not manifest-tracked).
    fs.mkdirSync(path.join(project, '.traffic-one', 'skills', 'gitnexus-guide'), { recursive: true });
    fs.writeFileSync(path.join(project, '.traffic-one', 'skills', 'gitnexus-guide', 'SKILL.md'), '# guide\n', 'utf8');

    const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, mode: 'new-project' };
    materializeProjectAssets(project, state);

    const agents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    assert.ok(agents.includes('gitnexus-guide'), 'adopted skill listed in the Active Skills index');
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.ok(!manifest.skills.includes('gitnexus-guide'), 'manifest tracks only materialized skills');

    // Re-materialization must never sweep the adopted skill.
    materializeProjectAssets(project, state);
    assert.ok(fs.existsSync(path.join(project, '.traffic-one', 'skills', 'gitnexus-guide', 'SKILL.md')));
  });
});

test('materialized project artifacts contain no bundled model ids or plugin-maintenance model sync skill', () => {
  withPluginAndProject((project, plugin) => {
    // Exercise the real authoring catalogs through read-only symlinks so this is
    // an artifact-tree scan, not only a fixture of the two previously offending files.
    fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
    fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
    const state = {
      stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' },
      onboardingComplete: true, mode: 'new-project',
    };
    assert.equal(activeSkillsFor(state).has('model-tier-sync'), false, 'model-tier-sync is unavailable to end-user projects');

    materializeProjectAssets(project, state);

    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.ok(manifest.skills.includes('task-triage'), 'runtime-aware maintenance rubric remains project-visible');
    assert.ok(!manifest.skills.includes('model-tier-sync'), 'plugin-maintenance skill is never copied to a project');
    assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'skills', 'model-tier-sync')), false);

    const bundledModels = new Set<string>();
    for (const host of HOST_IDS) {
      for (const plan of HOST_PLAN_IDS[host]) {
        for (const models of Object.values(modelTierSnapshot(host, plan))) {
          for (const model of models) bundledModels.add(model);
        }
      }
    }
    const text = generatedProjectText(project);
    for (const model of bundledModels) {
      // Copilot Free's `auto` is a routing mode, not a concrete bundled model
      // id. Treating that ordinary English word as a leak makes legitimate
      // project guidance ("auto", "never auto-pick", etc.) fail this test.
      if (model === 'auto') continue;
      assert.doesNotMatch(text, modelTokenPattern(model), `project artifact leaked bundled model id ${model}`);
    }
  });
});

test('materialization respects host-only and unavailable skill scopes across every host and UI/API profiles', () => {
  withPluginAndProject((project, plugin) => {
    fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
    fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');

    const profiles = [
      {
        name: 'web',
        state: {
          stack: 'default',
          frontend: 'react-vite',
          backend: 'supabase',
          mobile: { framework: 'none' },
          onboardingComplete: true,
          mode: 'new-project',
        },
      },
      {
        name: 'api',
        state: {
          stack: 'custom-backend',
          frontend: 'none',
          backend: 'go',
          mobile: { framework: 'none' },
          onboardingComplete: true,
          mode: 'existing-codebase',
        },
      },
    ] as const;

    for (const host of HOST_IDS) {
      process.env.TRAFFIC_ONE_HOST = host;
      for (const profile of profiles) {
        const target = path.join(project, `${host}-${profile.name}`);
        fs.mkdirSync(target, { recursive: true });
        if (profile.name === 'api') {
          fs.writeFileSync(path.join(target, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
        }
        materializeProjectAssets(target, profile.state);
        const manifest = JSON.parse(
          fs.readFileSync(path.join(target, '.traffic-one', 'manifest.json'), 'utf8'),
        );
        assert.equal(
          manifest.skills.includes('security-scan'),
          host === 'claude',
          `${host}/${profile.name}: Claude-only scanner scope`,
        );
        assert.equal(
          fs.existsSync(path.join(target, '.traffic-one', 'skills', 'security-scan', 'SKILL.md')),
          host === 'claude',
          `${host}/${profile.name}: Claude-only scanner artifact`,
        );
        assert.equal(
          manifest.skills.includes('model-tier-sync'),
          false,
          `${host}/${profile.name}: maintainer-only skill`,
        );
        assert.equal(
          fs.existsSync(path.join(target, '.traffic-one', 'skills', 'model-tier-sync')),
          false,
          `${host}/${profile.name}: maintainer-only artifact`,
        );
      }
    }
  });
});

test('runtime capability materialization keeps Laravel API-only free of UI rules and skills', () => {
  withPluginAndProject((project, plugin) => {
    fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
    fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
    fs.writeFileSync(path.join(project, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
    }));
    fs.mkdirSync(path.join(project, 'resources/views'), { recursive: true });
    fs.writeFileSync(path.join(project, 'resources/views/welcome.blade.php'), '<h1>Laravel</h1>\n');
    const state = {
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'other',
      mobile: { framework: 'none' },
      onboardingComplete: true,
      mode: 'existing-codebase',
    };

    materializeProjectAssets(project, state);
    const apiManifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.equal(apiManifest.frontend, 'none');
    assert.equal(apiManifest.backend, 'laravel');
    assert.ok(apiManifest.rules.every((rule: string) => !rule.startsWith('rules/frontend/')));
    for (const uiSkill of ['browser-qa', 'design-system', 'i18n-text', 'create-page']) {
      assert.ok(!apiManifest.skills.includes(uiSkill), uiSkill);
    }
    assert.ok(apiManifest.skills.includes('laravel-patterns'));

    fs.writeFileSync(path.join(project, 'resources/views/dashboard.blade.php'), '<h1>Dashboard</h1>\n');
    materializeProjectAssets(project, state);
    const uiManifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.equal(uiManifest.frontend, 'laravel-ui');
    assert.ok(uiManifest.rules.includes('rules/frontend/ui-quality.md'));
    assert.ok(uiManifest.skills.includes('browser-qa'));
  });
});

test('runtime capability materialization discovers workspace Next without React/Vite leakage', () => {
  withPluginAndProject((project, plugin) => {
    fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
    fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
    fs.mkdirSync(path.join(project, 'apps/web/app'), { recursive: true });
    fs.writeFileSync(path.join(project, 'apps/web/package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    const state = {
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { framework: 'none' },
      onboardingComplete: true,
      mode: 'existing-codebase',
    };

    materializeProjectAssets(project, state);
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.equal(manifest.frontend, 'nextjs');
    assert.ok(manifest.skills.includes('nextjs-turbopack'));
    assert.ok(manifest.skills.includes('browser-qa'));
    assert.ok(!manifest.skills.includes('vite-patterns'));
    assert.ok(!manifest.rules.includes('rules/frontend/react/core.md'));
  });
});

test('materialized backend-only, frontend, and native profiles exclude unrelated Postgres rules and skills', () => {
  const fixtures = [
    {
      name: 'Go API',
      state: {
        stack: 'custom-backend', frontend: 'none', backend: 'go',
        mobile: { framework: 'none' }, onboardingComplete: true, mode: 'existing-codebase',
      },
      prepare(project: string): void {
        fs.writeFileSync(path.join(project, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
      },
      expectedSkill: 'golang-patterns',
      expectedRule: 'rules/backend/golang.md',
    },
    {
      name: 'Python CLI',
      state: {
        stack: 'custom-backend', frontend: 'none', backend: 'other',
        mobile: { framework: 'none' }, onboardingComplete: true, mode: 'existing-codebase',
      },
      prepare(project: string): void {
        fs.writeFileSync(path.join(project, 'sync.py'), 'print("ok")\n');
      },
      expectedSkill: 'python-patterns',
      expectedRule: 'rules/backend/python.md',
    },
    {
      name: 'Next frontend-only',
      state: {
        stack: 'custom-frontend', frontend: 'nextjs', backend: 'none',
        mobile: { framework: 'none' }, onboardingComplete: true, mode: 'existing-codebase',
      },
      prepare(project: string): void {
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
          dependencies: { next: '16.0.0', react: '19.0.0' },
        }));
        fs.mkdirSync(path.join(project, 'app'), { recursive: true });
      },
      expectedSkill: 'nextjs-turbopack',
      expectedRule: 'rules/frontend/ui-quality.md',
    },
    {
      name: 'Swift native',
      state: {
        stack: 'custom-stack', frontend: 'none', backend: 'none',
        mobile: { framework: 'swift-native' }, onboardingComplete: true, mode: 'existing-codebase',
      },
      prepare(project: string): void {
        fs.writeFileSync(path.join(project, 'Package.swift'), '// swift-tools-version: 6.2\n');
      },
      expectedSkill: 'swiftui-patterns',
      expectedRule: null,
    },
  ] as const;

  for (const fixture of fixtures) {
    withPluginAndProject((project, plugin) => {
      fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
      fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
      fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
      fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
      fixture.prepare(project);
      materializeProjectAssets(project, fixture.state);
      const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
      assert.ok(manifest.skills.includes(fixture.expectedSkill), `${fixture.name}: language/profile skill`);
      if (fixture.expectedRule) assert.ok(manifest.rules.includes(fixture.expectedRule), `${fixture.name}: stack rule`);
      assert.ok(!manifest.rules.includes('rules/backend/postgres.md'), `${fixture.name}: no Postgres rule`);
      for (const postgresSkill of ['postgres-patterns', 'postgres-review', 'database-migrations']) {
        assert.ok(!manifest.skills.includes(postgresSkill), `${fixture.name}: no ${postgresSkill}`);
      }
    });
  }
});

test('materialized data evidence opts a Go backend into Postgres guidance', () => {
  withPluginAndProject((project, plugin) => {
    fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
    fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
    fs.writeFileSync(path.join(project, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
    fs.mkdirSync(path.join(project, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(project, 'migrations', '001.sql'), 'create table items(id bigint primary key);\n');
    materializeProjectAssets(project, {
      stack: 'custom-backend', frontend: 'none', backend: 'go',
      mobile: { framework: 'none' }, onboardingComplete: true, mode: 'existing-codebase',
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.ok(manifest.rules.includes('rules/backend/postgres.md'));
    assert.ok(manifest.skills.includes('postgres-patterns'));
    assert.ok(manifest.skills.includes('database-migrations'));
  });
});

test('new-project mode routes the default Vite playbook only to the compiled default vite-react profile', () => {
  withPluginAndProject((project, plugin) => {
    fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
    fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');

    const state = {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { framework: 'none' },
      onboardingComplete: true,
    };
    materializeProjectAssets(project, state);

    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    for (const relPath of [
      'rules/modes/new-project.md',
      'rules/modes/new-project-vite-react.md',
      'rules/modes/new-project-architecture.md',
      'rules/modes/new-project-setup.md',
    ]) {
      assert.ok(manifest.rules.includes(relPath), `default vite-react materializes ${relPath}`);
    }
    const agents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    const gatewayAt = agents.indexOf('.traffic-one/rules/modes/new-project-vite-react.md');
    const referenceHeadingAt = agents.indexOf('### Reference On Demand');
    const setupAt = agents.indexOf('.traffic-one/rules/modes/new-project-setup.md');
    assert.ok(gatewayAt > 0 && gatewayAt < referenceHeadingAt, 'profile gateway is mandatory');
    assert.ok(setupAt > referenceHeadingAt, 'full setup remains read-on-demand');

    materializeProjectAssets(project, { ...state, stack: 'react-realtime-monorepo' });
    const legacyManifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.ok(legacyManifest.rules.includes('rules/modes/new-project-vite-react.md'),
      'legacy default-stack alias preserves the same compiled vite-react playbook');
  });
});

test('backend-only, native, Next, and Nuxt new projects never materialize the default Vite playbook', () => {
  const fixtures = [
    {
      name: 'Go API',
      profileRule: 'rules/modes/new-project-backend-only.md',
      state: {
        mode: 'new-project', stack: 'custom-backend', frontend: 'none', backend: 'go',
        mobile: { framework: 'none' }, onboardingComplete: true,
      },
      prepare(project: string): void {
        fs.writeFileSync(path.join(project, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
      },
    },
    {
      name: 'Swift native',
      profileRule: 'rules/modes/new-project-swift-native.md',
      state: {
        mode: 'new-project', stack: 'custom-stack', frontend: 'none', backend: 'none',
        mobile: { framework: 'swift-native' }, onboardingComplete: true,
      },
      prepare(project: string): void {
        fs.writeFileSync(path.join(project, 'Package.swift'), '// swift-tools-version: 6.0\n');
      },
    },
    {
      name: 'Next.js',
      profileRule: 'rules/modes/new-project-next-app.md',
      state: {
        mode: 'new-project', stack: 'custom-frontend', frontend: 'nextjs', backend: 'none',
        mobile: { framework: 'none' }, onboardingComplete: true,
      },
      prepare(project: string): void {
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }));
        fs.mkdirSync(path.join(project, 'app'), { recursive: true });
      },
    },
    {
      name: 'Nuxt',
      profileRule: 'rules/modes/new-project-nuxt.md',
      state: {
        mode: 'new-project', stack: 'custom-frontend', frontend: 'nuxt', backend: 'none',
        mobile: { framework: 'none' }, onboardingComplete: true,
      },
      prepare(project: string): void {
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ dependencies: { nuxt: '4.0.0' } }));
        fs.writeFileSync(path.join(project, 'nuxt.config.ts'), 'export default defineNuxtConfig({})\n');
      },
    },
  ] as const;

  for (const fixture of fixtures) {
    withPluginAndProject((project, plugin) => {
      fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
      fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
      fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
      fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
      fixture.prepare(project);

      materializeProjectAssets(project, fixture.state);
      const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
      assert.ok(manifest.rules.includes('rules/modes/new-project.md'), `${fixture.name}: universal spine`);
      assert.ok(manifest.rules.includes(fixture.profileRule), `${fixture.name}: selected profile rule`);
      assert.ok(manifest.rules.includes('rules/modes/new-project-architecture.md'),
        `${fixture.name}: universal architecture reference`);
      for (const relPath of [
        'rules/modes/new-project-vite-react.md',
        'rules/modes/new-project-setup.md',
      ]) {
        assert.ok(!manifest.rules.includes(relPath), `${fixture.name}: excludes ${relPath}`);
        assert.equal(fs.existsSync(path.join(project, '.traffic-one', relPath)), false);
      }
      assert.ok(fs.existsSync(path.join(project, '.traffic-one', fixture.profileRule)));
      assert.ok(fs.existsSync(path.join(
        project,
        '.traffic-one',
        'rules/modes/new-project-architecture.md',
      )));

      const spine = fs.readFileSync(
        path.join(project, '.traffic-one', 'rules', 'modes', 'new-project.md'),
        'utf8',
      );
      assert.doesNotMatch(spine, /\b(?:React|Vite|Turborepo|Supabase|Playwright)\b|apps\/web/i,
        `${fixture.name}: universal active rule has no default-web mandate`);
      const agents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
      const profileAt = agents.indexOf(`.traffic-one/${fixture.profileRule}`);
      const referenceHeadingAt = agents.indexOf('### Reference On Demand');
      const architectureAt = agents.indexOf('.traffic-one/rules/modes/new-project-architecture.md');
      assert.ok(profileAt > 0 && profileAt < referenceHeadingAt,
        `${fixture.name}: profile rule is mandatory`);
      assert.ok(architectureAt > referenceHeadingAt,
        `${fixture.name}: architecture index is read on demand`);
    });
  }
});

test('unresolved web/native new projects materialize only the fail-closed hybrid profile rule', () => {
  withPluginAndProject((project, plugin) => {
    fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
    fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');

    materializeProjectAssets(project, {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'react-vite',
      backend: 'none',
      mobile: { framework: 'react-native-expo' },
      onboardingComplete: true,
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.ok(manifest.rules.includes('rules/modes/new-project.md'));
    assert.ok(manifest.rules.includes('rules/modes/new-project-unsupported-hybrid.md'));
    assert.ok(manifest.rules.includes('rules/modes/new-project-architecture.md'));
    assert.ok(!manifest.rules.includes('rules/modes/new-project-vite-react.md'));
    assert.ok(!manifest.rules.includes('rules/modes/new-project-react-native.md'));
    assert.ok(!manifest.rules.includes('rules/modes/new-project-setup.md'));
  });
});

test('Ionic materialization composes with Vite, Vue, and Angular profile rules', () => {
  for (const fixture of [
    { frontend: 'react-vite', profileId: 'vite-react', reactRules: true },
    { frontend: 'vue', profileId: 'vue', reactRules: false },
    { frontend: 'angular', profileId: 'angular', reactRules: false },
  ] as const) {
    withPluginAndProject((project, plugin) => {
      fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
      fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
      fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
      fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');

      materializeProjectAssets(project, {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: fixture.frontend,
        backend: 'external-api',
        mobile: { framework: 'ionic-capacitor' },
        onboardingComplete: true,
      });

      const manifest = JSON.parse(fs.readFileSync(
        path.join(project, '.traffic-one', 'manifest.json'),
        'utf8',
      ));
      assert.ok(manifest.rules.includes(
        `rules/modes/new-project-${fixture.profileId}.md`,
      ));
      assert.ok(manifest.rules.includes('rules/modes/new-project-architecture.md'));
      assert.ok(manifest.rules.includes('rules/frontend/ionic/core.md'));
      assert.ok(manifest.rules.includes('rules/frontend/ionic/capacitor.md'));
      assert.equal(
        manifest.rules.includes('rules/frontend/react/core.md'),
        fixture.reactRules,
        `${fixture.frontend} keeps its own base framework`,
      );
    });
  }
});

test('new-project profile transitions remove stale profile/setup rules but retain the architecture index', () => {
  withPluginAndProject((project, plugin) => {
    fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
    fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');

    materializeProjectAssets(project, {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { framework: 'none' },
      onboardingComplete: true,
    });
    fs.writeFileSync(path.join(project, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
    materializeProjectAssets(project, {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
      onboardingComplete: true,
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', 'manifest.json'), 'utf8'));
    assert.ok(manifest.rules.includes('rules/modes/new-project-backend-only.md'));
    assert.ok(manifest.rules.includes('rules/modes/new-project-architecture.md'));
    for (const stale of [
      'rules/modes/new-project-vite-react.md',
      'rules/modes/new-project-setup.md',
    ]) {
      assert.ok(!manifest.rules.includes(stale), `manifest removes ${stale}`);
      assert.equal(fs.existsSync(path.join(project, '.traffic-one', stale)), false, `disk removes ${stale}`);
    }
  });
});

const GAP_RULES = [
  'rules/common/git.md',
  'rules/common/onboarding.md',
  'rules/common/stack-recommendations.md',
] as const;

test('envelope-referenced rules outside the manifest stay materialized in maintenance phase', () => {
  withPluginAndProject((project, plugin) => {
    fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
    fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
    // Maintenance phase: the manifest index drops the setup-era pair and never
    // lists the shipper's git.md, but hash-only envelopes still reference all
    // three — the bodies must survive on disk.
    const state = {
      stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { framework: 'none' }, onboardingComplete: true, mode: 'existing-codebase',
    };
    materializeProjectAssets(project, state);
    for (const rel of GAP_RULES) {
      assert.ok(fs.existsSync(path.join(project, '.traffic-one', rel)), `${rel} materialized`);
    }
    // A second run must not sweep them (cleanup idempotence).
    materializeProjectAssets(project, state);
    for (const rel of GAP_RULES) {
      assert.ok(fs.existsSync(path.join(project, '.traffic-one', rel)), `${rel} survives re-run`);
    }
  });
});

test('every envelope-eligible role rule id resolves under .traffic-one after materialization', () => {
  const states = [
    {
      name: 'web',
      state: {
        stack: 'default', frontend: 'react-vite', backend: 'supabase',
        mobile: { framework: 'none' }, onboardingComplete: true, mode: 'existing-codebase',
      },
      prepare(): void { /* default web project */ },
    },
    {
      name: 'api',
      state: {
        stack: 'custom-backend', frontend: 'none', backend: 'go',
        mobile: { framework: 'none' }, onboardingComplete: true, mode: 'existing-codebase',
      },
      prepare(project: string): void {
        fs.writeFileSync(path.join(project, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
      },
    },
  ] as const;
  for (const fixture of states) {
    withPluginAndProject((project, plugin) => {
      fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
      fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
      fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
      fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
      fixture.prepare(project);
      materializeProjectAssets(project, fixture.state);
      const profile = capabilityProfileForRun(project, fixture.state);
      const frozen = runtimeCapabilityStateFromProfile(profile, {});
      for (const role of [...eligibleRolesForProfile(profile), 'quick-fix']) {
        for (const rel of roleScopedRules(role, frozen) || []) {
          assert.ok(
            fs.existsSync(path.join(project, '.traffic-one', rel)),
            `${fixture.name}/${role}: ${rel} readable in project`,
          );
        }
      }
    });
  }
});

test('a frozen run snapshot profile keeps its envelope rules materialized when live state diverges', () => {
  withPluginAndProject((project, plugin) => {
    fs.rmSync(path.join(plugin, 'rules'), { recursive: true, force: true });
    fs.rmSync(path.join(plugin, 'skills-catalog'), { recursive: true, force: true });
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
    fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
    // Freeze a web-ui snapshot for the in-flight run, then materialize with a
    // live backend-only state carrying that currentRunId: the frozen profile's
    // frontend rules must still be on disk for the run's live children.
    const webState = {
      stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { framework: 'none' }, onboardingComplete: true, mode: 'new-project',
    };
    ensureArchitectureRunSnapshot(project, 'RUN1', webState);
    const liveApiState = {
      stack: 'custom-backend', frontend: 'none', backend: 'go',
      mobile: { framework: 'none' }, onboardingComplete: true, mode: 'existing-codebase',
      currentRunId: 'RUN1',
    };
    fs.writeFileSync(path.join(project, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
    materializeProjectAssets(project, liveApiState);
    for (const rel of ['rules/frontend/ui-quality.md', 'rules/frontend/typography.md']) {
      assert.ok(
        fs.existsSync(path.join(project, '.traffic-one', rel)),
        `${rel} kept for the frozen run profile`,
      );
    }
  });
});

test('non-OpenCode materialization cleans generated legacy OpenCode assets without writing global profiles', () => {
  withPluginAndProject((project) => {
    const projectAgents = path.join(project, '.opencode', 'agents');
    fs.mkdirSync(projectAgents, { recursive: true });
    const generated = path.join(projectAgents, 'senior-architect.md');
    const custom = path.join(projectAgents, 'my-agent.md');
    fs.writeFileSync(generated, `${GENERATED_MARKER}\nlegacy profile\n`, 'utf8');
    fs.writeFileSync(custom, 'user-authored profile\n', 'utf8');

    const state = {
      stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' },
      onboardingComplete: true, mode: 'new-project',
      team: { mode: 'subagents', approved: true }, performance: { level: 'balanced' },
    };
    materializeProjectAssets(project, state);

    assert.equal(fs.existsSync(generated), false, 'generated legacy profile is removed on every host');
    assert.equal(fs.readFileSync(custom, 'utf8'), 'user-authored profile\n');
    assert.equal(fs.existsSync(openCodeGlobalAgentPath(project, 'senior-architect')), false, 'Codex does not write OpenCode globals');
  });
});

// The compiler's own `.gitignore` scaffold only ever fires on `isNewProject`
// (compile.ts ~322/337 → scaffold.ts REPOSITORY_SCAFFOLD_OUTPUTS), so an
// existing-codebase project never got Traffic One's ignore rules. This is the
// precondition for the decision-log work item (`.traffic-one/debug/`,
// `.traffic-one/runs/<id>/debug/`): materializeProjectAssets is the one writer
// every mode's onboarding routes through, so it is the trigger point.
//
// Authority split (code review): an existing-codebase project must get ONLY
// Traffic One's own paths, never the SKIP_DIRS-derived build-output opinions
// (`node_modules/`, `dist/`, `vendor/`, `target/`, ...) — imposing those on a
// repo we did not create is out of scope; git ignore semantics never untrack
// what is already committed, so getting it wrong fails silently on the next
// new file under one of those directories.
test('materializeProjectAssets converges .gitignore for existing-codebase mode with ONLY Traffic One\'s own paths, never the build-output opinions', () => {
  withPluginAndProject((project) => {
    // Ask-first is on by default (config/onboarding.ts ASK_USE_PLUGIN_FIRST) —
    // explicit consent is required before this write may fire at all.
    recordPluginUseChoice(project, true, 'test');
    fs.writeFileSync(path.join(project, '.gitignore'), 'my-build-output/\n', 'utf8');
    const state = {
      stack: 'default', frontend: 'react-vite', backend: 'none',
      mobile: { framework: 'none' }, onboardingComplete: true, mode: 'existing-codebase',
    };
    materializeProjectAssets(project, state);
    const body = fs.readFileSync(path.join(project, '.gitignore'), 'utf8');
    assert.ok(body.startsWith('my-build-output/'), 'the project owner\'s own line is preserved byte-for-byte above the block');
    assert.ok(body.includes('.traffic-one/runs/'), 'run state is ignored');
    assert.ok(body.includes('.traffic-one/debug/'), 'the debug work item\'s precondition is covered');
    assert.ok(!body.includes('.traffic-one/digests/'), 'digests stay committed');
    for (const opinion of ['node_modules/', 'dist/', 'build/', 'vendor/', 'target/', '.env']) {
      assert.ok(!body.includes(opinion), `${opinion} is Traffic One's scaffold opinion, not ours to impose on an existing repo`);
    }

    // Idempotent through the ACTUAL call site every hook uses: a converged
    // file must be a true byte-level no-op on the second AND third call, not
    // merely on a direct call to ensureProjectGitignore — a .gitignore that
    // rewrites itself on every tool call would show up as permanent git dirt.
    const afterFirst = fs.readFileSync(path.join(project, '.gitignore'));
    materializeProjectAssets(project, state);
    const afterSecond = fs.readFileSync(path.join(project, '.gitignore'));
    assert.ok(afterFirst.equals(afterSecond), 'byte-identical on the second call');
    materializeProjectAssets(project, state);
    const afterThird = fs.readFileSync(path.join(project, '.gitignore'));
    assert.ok(afterFirst.equals(afterThird), 'byte-identical on the third call too');
  });
});

// The complementary case: a genuinely greenfield project (mode: 'new-project')
// still gets the full, informed seed through this same call site — the split
// above narrows what EXISTING projects get, it must not narrow what a project
// Traffic One itself is scaffolding gets.
test('materializeProjectAssets converges .gitignore for new-project mode with the full seed, and stays a no-op on repeat', () => {
  withPluginAndProject((project) => {
    recordPluginUseChoice(project, true, 'test');
    const state = {
      stack: 'default', frontend: 'react-vite', backend: 'none',
      mobile: { framework: 'none' }, onboardingComplete: true, mode: 'new-project',
    };
    materializeProjectAssets(project, state);
    const body = fs.readFileSync(path.join(project, '.gitignore'), 'utf8');
    assert.match(body, /node_modules\//, 'a genuinely greenfield project still gets the full informed opinion');
    assert.ok(body.includes('.traffic-one/debug/'));

    const afterFirst = fs.readFileSync(path.join(project, '.gitignore'));
    materializeProjectAssets(project, state);
    materializeProjectAssets(project, state);
    assert.ok(afterFirst.equals(fs.readFileSync(path.join(project, '.gitignore'))), 'byte-identical through the third call');
  });
});

// Non-negotiable per the product contract in shared/state/plugin-use.ts: a
// declined project stays byte-identical. Writing a .gitignore into a repo
// that said no would be a regression this test exists to catch.
//
// These two cases carry the whole weight of this writer's consent check, and
// that is a property of `.gitignore` rather than of the tests: every OTHER file
// materialization writes lands under `.traffic-one/`, where the path fence in
// shared/fsjson.ts refuses it a second time, so removing the check below leaves
// those cases green. `.gitignore` and the root context files are outside the
// path fence's vocabulary — here the caller-side check is the ONLY fence, which
// is why these assert the returned refusal and the whole tree, not just one
// absent file. (Measured: deleting materialize.ts's `projectWritesPermitted`
// stand-down fails these two and two in state/__tests__/consent-write-fence.ts,
// and nothing else in the suite.)
test('materializeProjectAssets never writes .gitignore into a declined project', () => {
  withPluginAndProject((project) => {
    recordPluginUseChoice(project, false, 'test');
    assert.equal(pluginUseDeclined(project), true);
    const before = projectSnapshot(project);
    const state = {
      stack: 'default', frontend: 'react-vite', backend: 'none',
      mobile: { framework: 'none' }, onboardingComplete: true, mode: 'existing-codebase',
    };
    const result = materializeProjectAssets(project, state);
    assert.equal(fs.existsSync(path.join(project, '.gitignore')), false, 'a declined project gets no .gitignore at all');
    // The named refusal, not merely a quiet zero: converge.ts branches on this
    // exact value to stay silent (SILENT_MATERIALIZE_REFUSALS), so a refusal
    // that reported anything else would surface a decline as an error to a user
    // who already answered the question.
    assert.equal(result.skipped, 'plugin-use-not-permitted');
    assert.deepEqual(
      { rules: result.rules, skills: result.skills, written: result.written, removed: result.removed },
      { rules: 0, skills: 0, written: 0, removed: 0 },
      'a refusal counts nothing — `written` in particular is unconditional once the writer starts',
    );
    assert.deepEqual(projectSnapshot(project), before, 'byte-identical tree, not just an absent .gitignore');
  });
});

// The ask-first chat question (ASK_USE_PLUGIN_FIRST) being merely PENDING —
// no choice recorded yet, neither yes nor no — must block the write exactly
// like a decline. This is the default state of every fresh project in
// production (config/onboarding.ts sets the feature on), and every other
// materialize entry point (session-start.ts, prompt-submit.ts, plan-write)
// already stands down on it before reaching this writer.
test('materializeProjectAssets never writes .gitignore while the use-plugin question is still pending', () => {
  withPluginAndProject((project) => {
    const prevAsk = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
    try {
      const before = projectSnapshot(project);
      const state = {
        stack: 'default', frontend: 'react-vite', backend: 'none',
        mobile: { framework: 'none' }, onboardingComplete: true, mode: 'existing-codebase',
      };
      const result = materializeProjectAssets(project, state);
      assert.equal(fs.existsSync(path.join(project, '.gitignore')), false, 'no choice recorded yet — nothing may be written');
      assert.equal(result.skipped, 'plugin-use-not-permitted', 'pending reports the same refusal as a decline');
      assert.deepEqual(
        { rules: result.rules, skills: result.skills, written: result.written, removed: result.removed },
        { rules: 0, skills: 0, written: 0, removed: 0 },
      );
      assert.deepEqual(projectSnapshot(project), before, 'byte-identical tree while the question is open');
    } finally {
      if (prevAsk === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
      else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = prevAsk;
    }
  });
});
