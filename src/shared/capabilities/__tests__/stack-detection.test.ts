// Stack detection across ALL supported stacks (8cl class of failure).
//
// 8cl root cause chain: `\bvue\b` never matches "vuejs" (no word boundary
// before a word character), so "use laravel with vuejs" derived frontend
// `other`; then the laravel branch of detectFrontendFramework returned early
// with `none` on the empty new project — the configured-state fallback that
// every other backend reaches was unreachable — and the capability profile
// compiled backend-only. The requested Vue UI vanished before the architect
// ever ran. These tests pin both fixes and add an anti-drop matrix so no
// OTHER backend can ever silently discard a configured frontend on a new
// project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { classifyPromptForStack, detectBackendFromText, detectFrontendFromText } from '../../detection';
import { capabilityProfileForProject } from '../index';
import { FRONTEND_IDS, BACKEND_IDS } from '../../../config/state';

function withTempDir<T>(body: (cwd: string) => T): T {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-stack-detect-'));
  try {
    return body(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('frontend text detection accepts glued and dotted js spellings', () => {
  const cases: Array<[string, string]> = [
    ['build it with vuejs', 'vue'],
    ['build it with vue.js', 'vue'],
    ['build it with vue', 'vue'],
    ['a reactjs dashboard', 'react-vite'],
    ['a react.js dashboard', 'react-vite'],
    ['use sveltejs for the ui', 'svelte'],
    ['use sveltekit for the ui', 'svelte'],
    ['an angularjs admin', 'angular'],
    ['an angular admin', 'angular'],
    ['try solidjs here', 'solid'],
    ['try remixjs here', 'remix'],
    ['nextjs site', 'nextjs'],
    ['next.js site', 'nextjs'],
    ['nuxtjs site', 'nuxt'],
  ];
  for (const [prompt, expected] of cases) {
    assert.equal(detectFrontendFromText(prompt), expected, prompt);
  }
});

test('backend text detection accepts glued spellings (expressjs, springboot)', () => {
  assert.equal(detectBackendFromText('an expressjs api'), 'node');
  assert.equal(detectBackendFromText('an express.js api'), 'node');
  assert.equal(detectBackendFromText('a springboot service'), 'java');
  assert.equal(detectBackendFromText('a spring boot service'), 'java');
});

test('the exact 8cl prompt derives vue + laravel, never other/backend-only', () => {
  const prompt = 'create a modern learning platform with courses for web development. use laravel with vuejs.';
  assert.equal(detectFrontendFromText(prompt.toLowerCase()), 'vue');
  assert.equal(detectBackendFromText(prompt.toLowerCase()), 'laravel');
  const cls = classifyPromptForStack(prompt);
  assert.equal(cls.frontend, 'vue');
  assert.equal(cls.backend, 'laravel');
  assert.equal(cls.stack, 'custom-stack');
});

test('new laravel project honors the configured frontend: laravel-ui + inertia-vue', () => {
  withTempDir((cwd) => {
    const profile = capabilityProfileForProject(cwd, {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'vue',
      backend: 'laravel',
    });
    assert.equal(profile.profileId, 'server-rendered');
    assert.equal(profile.router, 'inertia-vue-router');
    assert.ok(profile.sourceRoots.includes('apps/web/resources/js'));
    assert.equal(profile.uiSystem?.adapter, 'shadcn-vue');
    assert.equal(profile.uiSystem?.sharedRoot, 'packages/ui');
    assert.ok(profile.surfaces.includes('web-ui'));
    assert.ok(profile.roles.includes('senior-frontend'));
  });
});

test('new laravel project with react frontend seeds inertia-react', () => {
  withTempDir((cwd) => {
    const profile = capabilityProfileForProject(cwd, {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'react-vite',
      backend: 'laravel',
    });
    assert.equal(profile.profileId, 'server-rendered');
    assert.equal(profile.router, 'inertia-react-router');
    assert.ok(profile.sourceRoots.includes('apps/web/resources/js'));
    assert.equal(profile.uiSystem?.adapter, 'shadcn');
    assert.ok(profile.roles.includes('senior-frontend'));
  });
});

test('new laravel project with unspecified web UI (`other`) plans blade, not backend-only', () => {
  withTempDir((cwd) => {
    const profile = capabilityProfileForProject(cwd, {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'other',
      backend: 'laravel',
    });
    assert.equal(profile.profileId, 'server-rendered');
    assert.equal(profile.router, 'laravel-router');
    assert.ok(profile.sourceRoots.includes('resources/views'));
    assert.equal(profile.uiSystem?.family, 'framework-native');
    assert.equal(profile.uiSystem?.adapter, null);
    assert.ok(profile.surfaces.includes('web-ui'));
    assert.ok(profile.roles.includes('senior-frontend'));
  });
});

test('existing laravel API repo (composer, no UI evidence) stays backend-only', () => {
  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^11.0' },
    }));
    const profile = capabilityProfileForProject(cwd, {
      mode: 'existing',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'laravel',
    });
    assert.equal(profile.profileId, 'backend-only');
    assert.ok(!profile.surfaces.includes('web-ui'));
  });
});

test('on-disk inertia evidence beats the configured frontend', () => {
  withTempDir((cwd) => {
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^11.0', 'inertiajs/inertia-laravel': '^1.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { '@inertiajs/react': '^1.0', react: '^18.0.0' },
    }));
    const profile = capabilityProfileForProject(cwd, {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'vue',
      backend: 'laravel',
    });
    // Dependency evidence wins: this repo is Inertia+React regardless of state.
    assert.equal(profile.router, 'inertia-react-router');
  });
});

// The anti-drop matrix: EVERY configured frontend × EVERY backend on an empty
// new project must produce a web-ui surface and a senior-frontend role. This
// proves laravel was the only early-return hole and pins every future one.
test('no backend drops a configured frontend on an empty new project', () => {
  const frontends = [...FRONTEND_IDS].filter((id) => id !== 'none');
  const backends = [...BACKEND_IDS].filter((id) => id !== 'other');
  for (const frontend of frontends) {
    for (const backend of backends) {
      withTempDir((cwd) => {
        const profile = capabilityProfileForProject(cwd, {
          mode: 'new-project',
          stack: backend === 'none' ? 'custom-frontend' : 'custom-stack',
          frontend,
          backend,
        });
        const label = `${frontend} × ${backend}`;
        assert.ok(profile.surfaces.includes('web-ui'), `${label}: web-ui surface dropped`);
        assert.ok(
          profile.roles.includes('senior-frontend'),
          `${label}: senior-frontend role dropped`,
        );
      });
    }
  }
});
