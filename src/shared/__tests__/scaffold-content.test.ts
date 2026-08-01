// Scaffold content seeding (1.0.37, 8co): .prettierignore ships its canonical
// skip list and .env.example ships the VITE_SITE_URL contract — content is
// runtime knowledge, seeded only when the file is missing or blank. Compliant
// module skeletons ride the same call on greenfield runs: models edit, they
// don't author (the 13co deny classes all began with de-novo authoring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  compileArchitecture,
  ensureScaffoldContent,
  scaffoldFileContent,
  type ArchitectureInputV1,
} from '../architecture-contract';

function withTempDir<T>(body: (cwd: string) => T): T {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-scaffold-content-'));
  try {
    return body(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('canonical bodies exist for .prettierignore and .env.example only', () => {
  assert.match(String(scaffoldFileContent('.prettierignore')), /\.traffic-one\//);
  assert.match(String(scaffoldFileContent('.prettierignore')), /pnpm-lock\.yaml/);
  assert.match(String(scaffoldFileContent('.prettierignore')), /\.turbo\//);
  assert.equal(scaffoldFileContent('package.json'), null);
  assert.equal(scaffoldFileContent('apps/web/src/App.tsx'), null);
});

// `.env.example` is owned by senior-backend on EVERY profile that has one, so an
// unconditional Vite body seeded `VITE_SITE_URL=` into API-only projects (15cl:
// the Go backend replaced it by hand). A caller with no profile cannot be assumed
// to be building a web surface.
test('.env.example is web-shaped only where a web surface exists', () => {
  withTempDir((cwd) => {
    const service = compileArchitecture(cwd, 'R', {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
    }, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'store', name: 'Store', kind: 'store' }],
    } as ArchitectureInputV1);
    const goBody = String(scaffoldFileContent('.env.example', service.profile));
    assert.doesNotMatch(goBody, /VITE_/, 'a Go API must not be handed Vite crawl-origin variables');
    assert.match(goBody, /^PORT=$/m);
    assert.doesNotMatch(String(scaffoldFileContent('.env.example')), /VITE_/, 'no profile must not imply a web surface');
  });
});

// One authority, two encodings: `lint:css` globs `**/*.css` across the repo, so a
// stylelint config without ignoreFiles lints the build output it just produced
// (249 errors in 14co, 182 in 15co). Iterating the prettier list is what keeps
// the two from drifting apart again.
test('the stylelint ignore list covers everything .prettierignore skips', () => {
  const stylelint = JSON.parse(String(scaffoldFileContent('.stylelintrc.json'))) as { ignoreFiles?: string[] };
  const ignoreFiles = stylelint.ignoreFiles || [];
  assert.ok(ignoreFiles.length > 0, 'a repo-wide lint:css glob needs an ignore list');
  const skipped = String(scaffoldFileContent('.prettierignore'))
    .split('\n')
    .filter((line) => line.endsWith('/') && !line.startsWith('#'))
    .map((line) => line.slice(0, -1));
  for (const dir of skipped) {
    assert.ok(
      ignoreFiles.includes(`**/${dir}/**`),
      `stylelint must skip ${dir}/ — the formatter already does`,
    );
  }
});

test('seeds missing and blank files; never overwrites agent content', () => {
  withTempDir((cwd) => {
    const outputs = [
      { path: '.prettierignore' },
      { path: '.env.example' },
      { path: 'apps/web/package.json' },
    ];
    // Blank .prettierignore (the exact 8co shape) + no .env.example.
    fs.writeFileSync(path.join(cwd, '.prettierignore'), '\n');
    const written = ensureScaffoldContent(cwd, outputs);
    assert.deepEqual(written.sort(), ['.env.example', '.prettierignore']);
    assert.match(fs.readFileSync(path.join(cwd, '.prettierignore'), 'utf8'), /\.traffic-one\//);
    // No profile passed here, so the framework-neutral service body is correct;
    // the web/service split has its own test above.
    assert.match(fs.readFileSync(path.join(cwd, '.env.example'), 'utf8'), /^PORT=$/m);

    // A second pass changes nothing, and agent-authored content is preserved.
    fs.writeFileSync(path.join(cwd, '.prettierignore'), 'custom-entry\n');
    const second = ensureScaffoldContent(cwd, outputs);
    assert.deepEqual(second, []);
    assert.equal(fs.readFileSync(path.join(cwd, '.prettierignore'), 'utf8'), 'custom-entry\n');
  });
});

// --- module skeletons (Part 6): models edit, they don't author --------------

const SKELETON_INPUT: ArchitectureInputV1 = {
  schemaVersion: 1,
  routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' },
    { id: 'home', name: 'Home', kind: 'page' },
    { id: 'nav-bar', name: 'Nav Bar', kind: 'component' },
    { id: 'sync-service', name: 'Sync Service', kind: 'service' },
  ],
  // Two locales on purpose: catalog seeds must appear in EVERY declared locale,
  // the source locale with the declared copy and the others clearly marked TODO.
  i18n: { sourceLocale: 'en', locales: ['en', 'ro'] },
};

const REACT_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

function moduleOutput(compiled: { modules: Array<{ id: string; output: string }> }, id: string): string {
  const module = compiled.modules.find((candidate) => candidate.id === id);
  assert.ok(module, `compiled contract must hold module ${id}`);
  return module!.output;
}

test('greenfield materialization emits compliant module skeletons with catalog seeds in all locales', () => {
  withTempDir((cwd) => {
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const written = ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });

    // The page skeleton at its DEFAULT compiled path: named component, correct
    // framework form, i18n wired through <Trans ns i18nKey> with the declared
    // source copy as visible fallback.
    const page = moduleOutput(compiled, 'home');
    assert.ok(written.includes(page));
    const pageBody = fs.readFileSync(path.join(cwd, page), 'utf8');
    assert.match(pageBody, /export default function Home\(\)/);
    assert.match(pageBody, /<Trans ns="home-route" i18nKey="title">Home<\/Trans>/);

    // The app shell wires every compiled route to its compiled page module.
    const shellBody = fs.readFileSync(path.join(cwd, moduleOutput(compiled, 'app-shell')), 'utf8');
    assert.match(shellBody, /import Home from '\.\/pages\/Home';/);
    assert.match(shellBody, /<Route path="\/" element=\{<Home \/>\} \/>/);

    // Components export the compiled Pascal name; services get a typed empty
    // export under it, so planned consumers keep resolving.
    assert.match(
      fs.readFileSync(path.join(cwd, moduleOutput(compiled, 'nav-bar')), 'utf8'),
      /export function NavBar\(/,
    );
    assert.match(
      fs.readFileSync(path.join(cwd, moduleOutput(compiled, 'sync-service')), 'utf8'),
      /export const SyncService: SyncServiceContract = \{\};/,
    );

    // Catalog seeds in EVERY declared locale: source copy in `en`, a marked
    // TODO in `ro` — the exact i18n-seed contract.
    const catalogFor = (locale: string): string => {
      const catalog = (compiled.i18n?.catalogs || []).find((candidate) => (
        candidate.locales.includes(locale) && candidate.namespaces.includes('home-route')
      ));
      assert.ok(catalog, `compiled i18n must declare a ${locale}/home-route catalog`);
      return catalog!.path;
    };
    const en = JSON.parse(fs.readFileSync(path.join(cwd, catalogFor('en')), 'utf8')) as Record<string, string>;
    assert.equal(en.title, 'Home');
    const ro = JSON.parse(fs.readFileSync(path.join(cwd, catalogFor('ro')), 'utf8')) as Record<string, string>;
    assert.equal(ro.title, 'TODO(en copy): Home');
  });
});

test('a non-empty existing module file is never overwritten, and existing-codebase runs emit no skeletons', () => {
  withTempDir((cwd) => {
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const page = moduleOutput(compiled, 'home');
    fs.mkdirSync(path.dirname(path.join(cwd, page)), { recursive: true });
    fs.writeFileSync(path.join(cwd, page), 'export default function Custom() {}\n');
    const written = ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });
    assert.ok(!written.includes(page), 'agent content must never be reseeded');
    assert.equal(
      fs.readFileSync(path.join(cwd, page), 'utf8'),
      'export default function Custom() {}\n',
    );
  });

  withTempDir((cwd) => {
    // Same guard the scaffold table uses: skeletons are greenfield-only.
    const compiled = compileArchitecture(cwd, 'R', REACT_STATE, SKELETON_INPUT);
    const written = ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: false,
    });
    for (const module of compiled.modules) {
      assert.ok(!written.includes(module.output));
      assert.ok(!fs.existsSync(path.join(cwd, module.output)), `${module.output} must not exist`);
    }
  });
});

test('vue greenfield materialization emits SFC skeletons and nests catalog seeds by namespace', () => {
  withTempDir((cwd) => {
    const compiled = compileArchitecture(cwd, 'R', {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'vue',
      backend: 'none',
      mobile: { framework: 'none' },
    }, SKELETON_INPUT);
    assert.equal(compiled.profile.profileId, 'vue');
    ensureScaffoldContent(cwd, compiled.scaffoldOutputs || [], compiled.profile, {
      compiled,
      newProject: true,
    });

    // A Vue page is an SFC whose visible text is an interpolation — the form
    // the markup scanner accepts — never a `.ts`-shaped module in a .vue path.
    const page = moduleOutput(compiled, 'home');
    assert.match(page, /\.vue$/);
    const pageBody = fs.readFileSync(path.join(cwd, page), 'utf8');
    assert.match(pageBody, /<script setup lang="ts">/);
    assert.match(pageBody, /\{\{ t\("title"\) \}\}/);
    const shellBody = fs.readFileSync(path.join(cwd, moduleOutput(compiled, 'app-shell')), 'utf8');
    assert.match(shellBody, /<router-view \/>/);

    // Per-locale multi-namespace catalogs nest the seeded key by namespace.
    const catalogFor = (locale: string): string => {
      const catalog = (compiled.i18n?.catalogs || []).find((candidate) => (
        candidate.locales.includes(locale)
      ));
      assert.ok(catalog, `compiled i18n must declare a ${locale} catalog`);
      return catalog!.path;
    };
    const en = JSON.parse(fs.readFileSync(path.join(cwd, catalogFor('en')), 'utf8')) as Record<string, Record<string, string>>;
    assert.equal(en['home-route']?.title, 'Home');
    const ro = JSON.parse(fs.readFileSync(path.join(cwd, catalogFor('ro')), 'utf8')) as Record<string, Record<string, string>>;
    assert.equal(ro['home-route']?.title, 'TODO(en copy): Home');
  });
});
