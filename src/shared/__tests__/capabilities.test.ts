import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  HOST_SKILL_FILTERS,
  PROJECT_UNAVAILABLE_SKILLS,
  SKILL_FILTERS,
} from '../../config/skill-filters';
import {
  capabilityProfileForProject,
  defaultStateForStack,
  runtimeCapabilityState,
} from '../capabilities';
import { activeSkillsFor, activeSkillsForProject } from '../skill-filters';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-capabilities-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

test('custom-backend defaults to no frontend and materializes no UI skills', () => {
  assert.equal(defaultStateForStack('custom-backend').frontend, 'none');
  withProject((cwd) => {
    const state = { stack: 'custom-backend', frontend: 'none', backend: 'go', mobile: { framework: 'none' } };
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
    fs.mkdirSync(path.join(cwd, 'app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app', 'server.go'), 'package app\n');
    const profile = capabilityProfileForProject(cwd, state);
    assert.equal(profile.profileId, 'backend-only');
    assert.deepEqual(profile.qaAdapters, []);
    assert.ok(profile.surfaces.includes('api'));
    assert.ok(!profile.roles.includes('senior-frontend'));
    const skills = activeSkillsFor({ ...state, onboardingComplete: true });
    for (const uiSkill of [
      'browser-qa', 'design-system', 'i18n-text', 'frontend-patterns',
      'create-page', 'create-feature', 'create-service',
    ]) {
      assert.equal(skills.has(uiSkill), false, uiSkill);
    }
    assert.equal(skills.has('golang-patterns'), true);
  });
});

test('blank default new projects freeze the registry-owned apps/web Vite root', () => {
  withProject((cwd) => {
    const profile = capabilityProfileForProject(cwd, {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { framework: 'none' },
    });
    assert.equal(profile.profileId, 'vite-react');
    assert.deepEqual(profile.sourceRoots, ['apps/web/src']);
    assert.ok(profile.entrypoints.includes('apps/web/src/main.tsx'));
  });
});

test('Next custom roots and Nuxt are web-ui profiles with local Playwright QA', () => {
  for (const fixture of [
    { deps: { next: '16.0.0', react: '19.0.0' }, root: 'src/app', id: 'next-app' },
    { deps: { nuxt: '4.0.0', vue: '3.0.0' }, root: 'pages', id: 'nuxt' },
  ]) {
    withProject((cwd) => {
      fs.mkdirSync(path.join(cwd, fixture.root), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: fixture.deps }));
      const profile = capabilityProfileForProject(cwd, {
        stack: 'custom-frontend',
        frontend: 'none',
        backend: 'none',
        mobile: { framework: 'none' },
      });
      assert.equal(profile.profileId, fixture.id);
      assert.ok(profile.surfaces.includes('web-ui'));
      assert.deepEqual(profile.qaAdapters, ['playwright']);
      assert.ok(profile.roles.includes('senior-frontend'));
      assert.ok(profile.skillBuckets.includes('web-ui'));
    });
  }
});

test('workspace-local package manifests select Next and Nuxt custom source roots', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'apps/web/app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      private: true,
      workspaces: ['apps/*'],
    }));
    fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    const profile = capabilityProfileForProject(cwd, {
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { framework: 'none' },
    });
    assert.equal(profile.profileId, 'next-app');
    assert.ok(profile.sourceRoots.includes('apps/web/app'));
    assert.ok(profile.entrypoints.includes('apps/web/app/layout.tsx'));
    const skills = activeSkillsForProject(cwd, { stack: 'custom-frontend', frontend: 'none', backend: 'none' });
    assert.equal(skills.has('nextjs-turbopack'), true);
    assert.equal(skills.has('browser-qa'), true);
    assert.equal(skills.has('create-feature'), true);
    assert.equal(skills.has('create-service'), true);
  });

  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'apps/web/ui/app/pages'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
      dependencies: { nuxt: '4.0.0', vue: '3.0.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'apps/web/nuxt.config.ts'), "export default defineNuxtConfig({ srcDir: './ui' });\n");
    const profile = capabilityProfileForProject(cwd, {
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { framework: 'none' },
    });
    assert.equal(profile.profileId, 'nuxt');
    assert.ok(profile.sourceRoots.includes('apps/web/ui/app'));
    assert.ok(profile.layerRoots.pages.includes('apps/web/ui/app/pages'));
    const state = runtimeCapabilityState(cwd, { stack: 'custom-frontend', frontend: 'none', backend: 'none' });
    assert.equal(state.frontend, 'nuxt');
  });
});

test('bounded workspace roots identify framework-native custom web profiles', () => {
  const fixtures = [
    {
      root: 'packages/dashboard',
      deps: { next: '16.0.0', react: '19.0.0' },
      marker: 'app',
      profileId: 'next-app',
      router: 'next-app-router',
      sourceRoot: 'packages/dashboard/app',
    },
    {
      root: 'packages/portal',
      deps: { vue: '3.5.0', vite: '7.0.0' },
      marker: 'src/pages',
      profileId: 'vue',
      router: 'vue-router',
      sourceRoot: 'packages/portal/src',
    },
    {
      root: 'apps/site',
      deps: { '@sveltejs/kit': '2.0.0', svelte: '5.0.0' },
      marker: 'src/routes',
      profileId: 'sveltekit',
      router: 'sveltekit-file-router',
      sourceRoot: 'apps/site/src',
    },
    {
      root: 'frontend',
      deps: { svelte: '5.0.0', vite: '7.0.0' },
      marker: 'src/pages',
      profileId: 'svelte',
      router: 'svelte-router',
      sourceRoot: 'frontend/src',
    },
    {
      root: 'packages/marketing',
      deps: { astro: '5.0.0' },
      marker: 'src/pages',
      profileId: 'astro',
      router: 'astro-file-router',
      sourceRoot: 'packages/marketing/src',
    },
    {
      root: 'client',
      deps: { '@angular/core': '20.0.0', '@angular/cli': '20.0.0' },
      marker: 'src/app/pages',
      profileId: 'angular',
      router: 'angular-router',
      sourceRoot: 'client/src/app',
    },
  ] as const;

  for (const fixture of fixtures) {
    withProject((cwd) => {
      fs.mkdirSync(path.join(cwd, fixture.root, fixture.marker), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, fixture.root, 'package.json'),
        JSON.stringify({ dependencies: fixture.deps }),
      );
      const profile = capabilityProfileForProject(cwd, {
        mode: 'existing-codebase',
        stack: 'custom-frontend',
        frontend: 'none',
        backend: 'none',
        mobile: { framework: 'none' },
      });
      assert.equal(profile.profileId, fixture.profileId, fixture.root);
      assert.equal(profile.router, fixture.router, fixture.root);
      assert.ok(profile.sourceRoots.includes(fixture.sourceRoot), fixture.root);
      assert.deepEqual(profile.qaAdapters, ['playwright'], fixture.root);
      assert.ok(profile.skillBuckets.includes('custom-web')
        || ['next-app', 'nuxt'].includes(fixture.profileId), fixture.root);
    });
  }
});

test('simultaneous web and native UI is explicit and fail-closed until a target is selected', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'packages/dashboard/app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'packages/dashboard/package.json'), JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { expo: '55.0.0', react: '19.0.0', 'react-native': '0.83.0' },
    }));
    const state = {
      mode: 'existing-codebase',
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { framework: 'react-native-expo' },
    };

    const ambiguous = capabilityProfileForProject(cwd, state);
    assert.equal(ambiguous.profileId, 'unsupported-hybrid');
    assert.deepEqual(ambiguous.surfaces, ['web-ui', 'native-ui']);
    assert.deepEqual(ambiguous.uiFrameworks, {
      web: 'nextjs',
      native: 'react-native-expo',
    });
    assert.equal(ambiguous.blockingIssues?.[0]?.code, 'CAPABILITY_HYBRID_UI_TARGET_REQUIRED');
    assert.ok(ambiguous.qaAdapters.includes('playwright'));
    assert.ok(ambiguous.qaAdapters.includes('maestro'));

    const web = capabilityProfileForProject(cwd, {
      ...state,
      architectureTarget: 'web-ui',
    });
    assert.equal(web.profileId, 'next-app');
    assert.equal(web.architectureTarget, 'web-ui');
    assert.deepEqual(web.surfaces, ['web-ui', 'native-ui']);
    assert.deepEqual(web.qaAdapters, ['playwright']);

    const native = capabilityProfileForProject(cwd, {
      ...state,
      architectureTarget: 'native-ui',
    });
    assert.equal(native.profileId, 'react-native');
    assert.equal(native.architectureTarget, 'native-ui');
    assert.deepEqual(native.qaAdapters, ['maestro']);
  });
});

test('Laravel Blade/Inertia is UI, while Laravel API-only never receives browser QA', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
    }));
    fs.mkdirSync(path.join(cwd, 'app/Http/Controllers'), { recursive: true });
    const state = { stack: 'custom-backend', frontend: 'none', backend: 'laravel', mobile: { framework: 'none' } };
    const apiOnly = capabilityProfileForProject(cwd, state);
    assert.equal(apiOnly.profileId, 'backend-only');
    assert.deepEqual(apiOnly.qaAdapters, []);
    assert.ok(!apiOnly.roles.includes('senior-frontend'));

    fs.mkdirSync(path.join(cwd, 'resources/views'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'resources/views/welcome.blade.php'), '<h1>Laravel</h1>\n');
    fs.mkdirSync(path.join(cwd, 'resources/js'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'resources/js/app.js'), "import './bootstrap';\n");
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      devDependencies: { vite: '^7.0.0', 'laravel-vite-plugin': '^2.0.0' },
    }));
    const defaultWelcome = capabilityProfileForProject(cwd, state);
    assert.equal(defaultWelcome.profileId, 'backend-only');
    assert.equal(activeSkillsForProject(cwd, state).has('browser-qa'), false);
    const legacyDefaultWelcome = capabilityProfileForProject(cwd, {
      ...state,
      frontend: 'react-vite',
    });
    assert.equal(legacyDefaultWelcome.profileId, 'backend-only');
    assert.ok(!legacyDefaultWelcome.roles.includes('senior-frontend'));

    fs.writeFileSync(path.join(cwd, 'resources/views/dashboard.blade.php'), '<h1>Dashboard</h1>\n');
    const blade = capabilityProfileForProject(cwd, state);
    assert.equal(blade.profileId, 'server-rendered');
    assert.equal(blade.router, 'laravel-router');
    assert.ok(blade.surfaces.includes('web-ui'));
    assert.deepEqual(blade.qaAdapters, ['playwright']);
    assert.ok(blade.roles.includes('senior-frontend'));
  });

  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: {
        'laravel/framework': '^12.0',
        'inertiajs/inertia-laravel': '^2.0',
      },
    }));
    fs.mkdirSync(path.join(cwd, 'resources/js/Pages'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { '@inertiajs/react': '^2.0', react: '^19.0' },
    }));
    const inertia = capabilityProfileForProject(cwd, {
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'laravel',
      mobile: { framework: 'none' },
    });
    assert.equal(inertia.profileId, 'server-rendered');
    assert.equal(inertia.router, 'inertia-react-router');
    assert.equal(inertia.layerRoots.pages[0], 'resources/js/Pages');
  });
});

test('Python script/CLI is backend-only and native Swift/Kotlin use emulator adapters', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'sync.py'), 'print("ok")\n');
    const python = capabilityProfileForProject(cwd, {
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'other',
      mobile: { framework: 'none' },
    });
    assert.equal(python.profileId, 'backend-only');
    assert.ok(python.surfaces.includes('cli'));
    assert.equal(python.surfaces.includes('api'), false);
    assert.equal(python.surfaces.includes('worker'), false);
    assert.equal(python.surfaces.includes('data'), false);
    assert.deepEqual(python.qaAdapters, []);
    assert.ok(!python.roles.includes('senior-frontend'));
    const skills = activeSkillsForProject(cwd, {
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'other',
      mobile: { framework: 'none' },
    });
    assert.equal(skills.has('python-patterns'), true);
    assert.equal(skills.has('browser-qa'), false);
    assert.equal(skills.has('api-design'), false);
    assert.equal(skills.has('app-launch-checklist'), false);
    assert.equal(skills.has('postgres-patterns'), false);
    assert.equal(skills.has('postgres-review'), false);
    assert.equal(skills.has('database-migrations'), false);
  });

  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'Package.swift'), '// swift-tools-version: 6.2\n');
    const swift = capabilityProfileForProject(cwd, {
      stack: 'custom-frontend', frontend: 'none', backend: 'none', mobile: { framework: 'swift-native' },
    });
    assert.equal(swift.profileId, 'swift-native');
    assert.deepEqual(swift.qaAdapters, ['xcode-simulator']);
    assert.ok(!swift.qaAdapters.includes('playwright'));
    const skills = activeSkillsForProject(cwd, {
      stack: 'custom-frontend', frontend: 'none', backend: 'none', mobile: { framework: 'swift-native' },
    });
    assert.equal(skills.has('app-launch-checklist'), true);
    assert.equal(skills.has('i18n-text'), true);
    assert.equal(skills.has('browser-qa'), false);
  });

  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'settings.gradle.kts'), 'rootProject.name = "App"\n');
    const kotlin = capabilityProfileForProject(cwd, {
      stack: 'custom-frontend', frontend: 'none', backend: 'none', mobile: { framework: 'kotlin-android' },
    });
    assert.equal(kotlin.profileId, 'kotlin-native');
    assert.deepEqual(kotlin.qaAdapters, ['android-emulator']);
    assert.equal(activeSkillsForProject(cwd, {
      stack: 'custom-frontend', frontend: 'none', backend: 'none', mobile: { framework: 'kotlin-android' },
    }).has('i18n-text'), true);
  });
});

test('React Native uses native QA skills and never receives browser-only Playwright E2E', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { expo: '55.0.0', react: '19.0.0', 'react-native': '0.83.0' },
    }));
    const state = {
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { framework: 'react-native-expo' },
    };
    const profile = capabilityProfileForProject(cwd, state);
    assert.equal(profile.profileId, 'react-native');
    assert.deepEqual(profile.qaAdapters, ['maestro']);
    const skills = activeSkillsForProject(cwd, state);
    assert.equal(skills.has('create-native-screen'), true);
    assert.equal(skills.has('i18n-text'), true);
    assert.equal(skills.has('e2e-testing'), false);
    assert.equal(skills.has('browser-qa'), false);
  });
});

test('Python API/worker/data surfaces require evidence and data enables Postgres tooling', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'pyproject.toml'), [
      '[project]',
      'name = "service"',
      'dependencies = ["fastapi>=0.116", "uvicorn>=0.35"]',
      '',
    ].join('\n'));
    const state = {
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'other',
      mobile: { framework: 'none' },
    };
    const api = capabilityProfileForProject(cwd, state);
    assert.ok(api.surfaces.includes('api'));
    assert.equal(api.surfaces.includes('cli'), false);
    assert.equal(api.surfaces.includes('worker'), false);
    assert.equal(api.surfaces.includes('data'), false);
    assert.equal(activeSkillsForProject(cwd, state).has('api-design'), true);
    assert.equal(activeSkillsForProject(cwd, state).has('postgres-patterns'), false);

    fs.mkdirSync(path.join(cwd, 'workers'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'workers', 'emails.py'), 'def run(): pass\n');
    fs.mkdirSync(path.join(cwd, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'migrations', '001.sql'), 'create table jobs(id bigint primary key);\n');
    const withEvidence = capabilityProfileForProject(cwd, state);
    assert.ok(withEvidence.surfaces.includes('worker'));
    assert.ok(withEvidence.surfaces.includes('data'));
    const skills = activeSkillsForProject(cwd, state);
    assert.equal(skills.has('postgres-patterns'), true);
    assert.equal(skills.has('postgres-review'), true);
    assert.equal(skills.has('database-migrations'), true);
  });
});

test('stateless Go stays free of Postgres skills until provider/data evidence exists', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.test/service\n\ngo 1.24\n');
    const state = {
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
    };
    const stateless = capabilityProfileForProject(cwd, state);
    assert.ok(stateless.surfaces.includes('api'));
    assert.equal(stateless.surfaces.includes('data'), false);
    let skills = activeSkillsForProject(cwd, state);
    for (const postgresSkill of ['postgres-patterns', 'postgres-review', 'database-migrations']) {
      assert.equal(skills.has(postgresSkill), false, postgresSkill);
    }

    fs.writeFileSync(path.join(cwd, 'go.mod'), [
      'module example.test/service',
      '',
      'go 1.24',
      '',
      'require github.com/jackc/pgx/v5 v5.7.5',
      '',
    ].join('\n'));
    const provider = capabilityProfileForProject(cwd, state);
    assert.ok(provider.skillBuckets.includes('postgres'));
    skills = activeSkillsForProject(cwd, state);
    assert.equal(skills.has('postgres-patterns'), true);
  });
});

test('_common is universal-only and every catalog skill belongs to an explicit profile', () => {
  for (const scoped of [
    'browser-qa',
    'design-system',
    'design-audit',
    'i18n-text',
    'security-scan',
    'model-tier-sync',
  ]) {
    assert.equal(SKILL_FILTERS._common!.has(scoped), false, scoped);
  }
  const catalogRoot = path.resolve(__dirname, '../../modules/skills/skills-catalog');
  const catalog = fs.readdirSync(catalogRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(catalogRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  const assigned = new Set([
    ...Object.values(SKILL_FILTERS).flatMap((set) => [...set]),
    ...Object.values(HOST_SKILL_FILTERS).flatMap((set) => [...(set || [])]),
    ...PROJECT_UNAVAILABLE_SKILLS,
  ]);
  const orphans = catalog.filter((skill) => !assigned.has(skill));
  assert.deepEqual(orphans, []);
});
