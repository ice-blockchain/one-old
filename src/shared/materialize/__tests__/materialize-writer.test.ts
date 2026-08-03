import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { HOST_IDS, HOST_PLAN_IDS } from '../../../config/model-tiers';
import { capabilityProfileForRun, ensureArchitectureRunSnapshot } from '../../architecture-contract';
import {
  eligibleRolesForProfile,
  runtimeCapabilityStateFromProfile,
} from '../../capabilities';
import { activeSkillsFor } from '../../skill-filters';
import { modelTierSnapshot } from '../../model-tiers';
import { roleScopedRules } from '../../stacks';
import { GENERATED_MARKER } from '../generated';
import { cleanupPrevious } from '../cleanup';
import { hasMaterializedProjectAssets } from '../has-assets';
import { materializeProjectAssets } from '../materialize';
import { openCodeGlobalAgentPath } from '../opencode-assets';

// Build a temp pluginRoot containing a small rules/ + skills-catalog/.
function withPluginAndProject(fn: (project: string, plugin: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-matwriter-'));
  const plugin = path.join(base, 'plugin');
  fs.mkdirSync(path.join(plugin, 'rules', 'common'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'rules', 'common', 'auth-gate.md'), '# Auth gate rule\nbody', 'utf8');
  fs.writeFileSync(path.join(plugin, 'rules', 'core.md'), '# Core rule\nbody', 'utf8');
  fs.mkdirSync(path.join(plugin, 'skills-catalog', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills-catalog', 'project-memory', 'SKILL.md'), '# project-memory\nbody', 'utf8');
  for (const name of ['task-triage', 'model-tier-sync']) {
    const source = path.resolve(__dirname, '..', '..', '..', 'modules', 'skills', 'skills-catalog', name, 'SKILL.md');
    const destination = path.join(plugin, 'skills-catalog', name, 'SKILL.md');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
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

test('cleanupPrevious moves legacy root docs into .traffic-one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cleanup-docs-'));
  try {
    fs.writeFileSync(path.join(dir, 'api.md'), '# API\n\nRoot API notes.\n', 'utf8');

    const removed = cleanupPrevious(dir, { rules: [], skills: [] }, new Set(), new Set());

    assert.ok(removed >= 1);
    assert.equal(fs.existsSync(path.join(dir, 'api.md')), false);
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

    assert.ok(removed >= 1);
    assert.equal(fs.existsSync(path.join(dir, 'security.md')), false);
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
