import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'node:perf_hooks';

import {
  compileArchitecture,
  validateArchitectureInput,
  type ArchitectureInputV1,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import {
  analyzeProjectStructure,
  analyzeStructureText,
  analyzeStructureTextAgainstContract,
} from '../react-structure';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-structure-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

const STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { framework: 'none' },
};

const INPUT: ArchitectureInputV1 = {
  schemaVersion: 1,
  routes: [
    { id: 'home-route', path: '/', moduleId: 'home' },
    { id: 'news-route', path: '/news', moduleId: 'news' },
  ],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' },
    { id: 'home', name: 'Home', kind: 'page' },
    { id: 'news', name: 'News', kind: 'page' },
  ],
};

function prepare(cwd: string, input: ArchitectureInputV1 = INPUT): CompiledArchitectureV1 {
  for (const dir of [
    'apps/web/src/pages',
    'apps/web/src/components',
    'apps/web/src/features',
    'apps/web/src/lib',
    'packages/ui/src',
  ]) fs.mkdirSync(path.join(cwd, dir), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    dependencies: { react: '19.0.0', vite: '7.0.0', 'react-router-dom': '7.0.0' },
  }));
  return compileArchitecture(cwd, 'R', STATE, input);
}

function ids(report: ReturnType<typeof analyzeProjectStructure>): string[] {
  return [...new Set(report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.id))].sort();
}

function prepareLaravel(
  cwd: string,
  inertia = false,
  input: ArchitectureInputV1 = INPUT,
): CompiledArchitectureV1 {
  fs.mkdirSync(path.join(cwd, 'routes'), { recursive: true });
  if (inertia) {
    fs.mkdirSync(path.join(cwd, 'resources/js/Pages'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'resources/js/app.tsx'), 'export {};\n');
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: {
        'laravel/framework': '^12.0',
        'inertiajs/inertia-laravel': '^2.0',
      },
    }));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { '@inertiajs/react': '^2.0', react: '^19.0' },
    }));
  } else {
    fs.mkdirSync(path.join(cwd, 'resources/views'), { recursive: true });
    // A non-default Blade view is deliberate UI evidence; welcome.blade.php
    // alone remains Laravel's API/default-scaffold profile.
    fs.writeFileSync(path.join(cwd, 'resources/views/dashboard.blade.php'), '<h1>Dashboard</h1>\n');
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^12.0' },
    }));
  }
  return compileArchitecture(cwd, 'R', {
    mode: 'existing-codebase',
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'laravel',
    mobile: { framework: 'none' },
  }, input);
}

function writeLaravelModules(cwd: string, contract: CompiledArchitectureV1): void {
  for (const module of contract.modules) {
    fs.mkdirSync(path.dirname(path.join(cwd, module.output)), { recursive: true });
    const content = module.output.endsWith('.blade.php')
      ? `<main>${module.name}</main>\n`
      : module.output.endsWith('.vue')
        ? `<template><main>${module.name}</main></template>\n`
        : module.kind === 'app-shell'
          ? 'export {};\n'
          : `export default function ${module.name}(){return <main>${module.name}</main>}\n`;
    fs.writeFileSync(path.join(cwd, module.output), content);
  }
}

test('minifying a 600-line entrypoint monolith hides no blocking ID and adds the collapse one', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const functions = [
      'function Home(){return <main>Home</main>}',
      'function News(){return <main>News</main>}',
      'function Catalog(){return <main>Catalog</main>}',
      'function Learning(){return <main>Learning</main>}',
    ];
    const router = 'const router=createBrowserRouter([{path:"/",element:<Home/>},{path:"/news",element:<News/>},{path:"/catalog",element:<Catalog/>},{path:"/learning",element:<Learning/>}]);';
    const minified = `${functions.join('')}${router}createRoot(document.getElementById("root")).render(<RouterProvider router={router}/>);`;
    const pretty = `${functions.map((fn) => fn.replace(/\{/g, '{\n').replace(/\}/g, '\n}')).join('\n')}\n${router
      .replace(/\},/g, '},\n')
      .replace(/\];/g, '\n];')}\n${'// filler\n'.repeat(610)}`;
    fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'), minified);
    const minifiedIds = ids(analyzeProjectStructure(cwd, contract));
    fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'), pretty);
    const prettyIds = ids(analyzeProjectStructure(cwd, contract));
    // The invariant this test exists for: minifying must not let a monolith
    // escape a single structural finding. It is now a SUPERSET rather than an
    // equality, because STRUCT_COLLAPSED_LINE is precisely the signal that
    // distinguishes the two forms — the minified variant earns one extra ID and
    // never loses one.
    for (const id of prettyIds) {
      assert.ok(minifiedIds.includes(id), `minifying hid ${id}`);
    }
    assert.ok(prettyIds.includes('STRUCT_ENTRYPOINT_COMPONENT'));
    assert.equal(prettyIds.includes('STRUCT_COLLAPSED_LINE'), false);
    assert.equal(minifiedIds.includes('STRUCT_COLLAPSED_LINE'), true);
    assert.deepEqual(
      minifiedIds.filter((id) => !prettyIds.includes(id)),
      ['STRUCT_COLLAPSED_LINE'],
      'collapse is the only difference minification may introduce',
    );
  });
});

test('pretty and minified direct or anonymous entrypoint JSX is blocking', () => {
  withProject((cwd) => {
    const contract = prepare(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'app-shell', name: 'App', kind: 'app-shell' }],
    });
    const variants = [
      [
        'import { createRoot } from "react-dom/client";',
        'createRoot(document.body).render(',
        '  <main>',
        '    <h1>Inline application</h1>',
        '  </main>,',
        ');',
      ].join('\n'),
      'import{createRoot}from"react-dom/client";createRoot(document.body).render(<main><h1>Inline application</h1></main>);',
      [
        'export default () => (',
        '  <main>',
        '    <h1>Anonymous application</h1>',
        '  </main>',
        ');',
      ].join('\n'),
      'export default()=><main><h1>Anonymous application</h1></main>;',
      'React.createElement("main", null, "Inline application");',
    ];
    for (const source of variants) {
      const blocking = analyzeStructureText(
        'apps/web/src/main.tsx',
        source,
        contract.profile,
      ).filter((finding) => finding.severity === 'error');
      assert.deepEqual(
        blocking.map((finding) => finding.id),
        ['STRUCT_ENTRYPOINT_COMPONENT'],
        source,
      );
    }
  });
});

test('a declared catch-all route is satisfied by the path="*" routers actually write', () => {
  // 2cu: the contract could only hold `/*` while every router writes `*`, so a
  // 404 route was permanently unsatisfiable and the app shipped without one.
  withProject((cwd) => {
    const contract = prepare(cwd, {
      schemaVersion: 1,
      routes: [
        { id: 'home-route', path: '/', moduleId: 'home' },
        { id: 'not-found-route', path: '*', moduleId: 'not-found' },
      ],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
        { id: 'not-found', name: 'NotFound', kind: 'page' },
      ],
    });
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Home.tsx'),
      'export function Home(){return <main>Home</main>}\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/NotFound.tsx'),
      'export function NotFound(){return <main>404</main>}\n');
    const routes = [
      'import { Route, Routes } from "react-router-dom";',
      'import { Home } from "../pages/Home";',
      'import { NotFound } from "../pages/NotFound";',
      'export function AppRoutes() { return <Routes>',
      '  <Route path="/" element={<Home />} />',
      '  <Route path="*" element={<NotFound />} />',
      '</Routes>; }',
    ].join('\n');

    const findings = analyzeStructureTextAgainstContract(
      'apps/web/src/components/AppRoutes.tsx',
      routes,
      contract,
    ).filter((finding) => finding.severity === 'error');
    assert.deepEqual(findings.map((finding) => finding.id), []);

    // pointing the catch-all at the wrong module is still a mismatch
    const wrong = analyzeStructureTextAgainstContract(
      'apps/web/src/components/AppRoutes.tsx',
      routes.replace('element={<NotFound />} />', 'element={<Home />} />'),
      contract,
    ).filter((finding) => finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH');
    assert.equal(wrong.length, 1);
  });
});

test('route-module matching is route-specific and ignores unused imports in the same or another module', () => {
  const mismatchMessages: string[][] = [];
  for (const minified of [false, true]) {
    withProject((cwd) => {
      const contract = prepare(cwd);
      fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'), [
        'import { createRoot } from "react-dom/client";',
        'import { App } from "./App";',
        'createRoot(document.body).render(<App />);',
      ].join(minified ? '' : '\n'));
      const appLines = [
        'import { createBrowserRouter, RouterProvider } from "react-router-dom";',
        'import { Home } from "./pages/Home";',
        'import { WrongHome } from "./components/WrongHome";',
        'import { News } from "./pages/News";',
        'const router = createBrowserRouter([{ path: "/", element: <WrongHome /> }, { path: "/news", element: <News /> }]);',
        'export function App() { return <RouterProvider router={router} />; }',
      ];
      fs.writeFileSync(path.join(cwd, 'apps/web/src/App.tsx'), appLines.join(minified ? '' : '\n'));
      fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Home.tsx'),
        'export function Home(){return <main>Home</main>}\n');
      fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/News.tsx'),
        'export function News(){return <main>News</main>}\n');
      fs.writeFileSync(path.join(cwd, 'apps/web/src/components/WrongHome.tsx'),
        'export function WrongHome(){return <main>Wrong home</main>}\n');
      fs.writeFileSync(path.join(cwd, 'apps/web/src/lib/Decoy.ts'),
        'import { Home } from "../pages/Home"; export const decoy = Home;\n');

      const mismatches = analyzeProjectStructure(cwd, contract).findings
        .filter((finding) => finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH')
        .map((finding) => finding.message)
        .sort();
      mismatchMessages.push(mismatches);
      assert.deepEqual(mismatches, [
        'Route / does not demonstrably use its compiled module apps/web/src/pages/Home.tsx.',
      ]);
    });
  }
  assert.deepEqual(mismatchMessages[0], mismatchMessages[1]);
});

test('hot contract analysis blocks an unplanned route and a route wired to the wrong module', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const findings = analyzeStructureTextAgainstContract(
      'apps/web/src/App.tsx',
      [
        'import { createBrowserRouter } from "react-router-dom";',
        'import { WrongHome } from "./components/WrongHome";',
        'import { News } from "./pages/News";',
        'export const router = createBrowserRouter([',
        '  { path: "/", element: <WrongHome /> },',
        '  { path: "/news", element: <News /> },',
        '  { path: "/admin", element: <News /> },',
        ']);',
      ].join('\n'),
      contract,
      { allowlist: contract.allowedOutputs },
    );
    const mismatches = findings.filter((finding) => (
      finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH'
    ));
    assert.equal(mismatches.length, 2);
    assert.ok(mismatches.some((finding) => finding.message.includes('compiled module')));
    assert.ok(mismatches.some((finding) => finding.message.includes('not present')));
    assert.equal(findings.some((finding) => (
      finding.id === 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP'
    )), false);
  });
});

test('hot contract analysis fails when the work-unit allowlist cannot create planned outputs', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const findings = analyzeStructureTextAgainstContract(
      'apps/web/src/main.tsx',
      'import { App } from "./App";\ncreateRoot(document.body).render(<App />);\n',
      contract,
      { allowlist: ['apps/web/src/main.tsx'] },
    );
    assert.ok(findings.some((finding) => (
      finding.id === 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP'
      && finding.file === 'apps/web/src/pages/Home.tsx'
    )));
  });
});

test('thin entrypoint with separate App/pages/components/features passes', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'),
      'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/App.tsx'), [
      'import { createBrowserRouter, RouterProvider } from "react-router-dom";',
      'import { Home } from "./pages/Home";',
      'import { News } from "./pages/News";',
      'const router = createBrowserRouter([{ path: "/", element: <Home /> }, { path: "/news", element: <News /> }]);',
      'export function App() { return <RouterProvider router={router} />; }',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Home.tsx'), 'export function Home(){return <main>Home</main>}\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/News.tsx'), 'export function News(){return <main>News</main>}\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/components/SiteNav.tsx'),
      'export function SiteNav(){return <nav>Site navigation</nav>}\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/features/Search.tsx'),
      'export function SearchFeature(){return <section>Search</section>}\n');
    const report = analyzeProjectStructure(cwd, contract, {
      allowlist: [...contract.allowedOutputs, 'apps/web/**'],
    });
    assert.equal(report.complete, true);
    assert.equal(report.filesScanned, 6);
    assert.deepEqual(report.findings.filter((finding) => finding.severity === 'error'), []);
  });
});

test('comments, JSX strings, config, tests, and stories do not create structural false positives', () => {
  withProject((cwd) => {
    const contract = prepare(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'app-shell', name: 'App', kind: 'app-shell' }],
    });
    fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'),
      'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\nconst fake="<Route element={<Fake/>}><main>not code</main>";\n// function Fake(){return <div/>}\ncreateRoot(document.body).render(<App/>);\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/App.tsx'), 'export function App(){return <main/>}\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/App.test.tsx'),
      'function Home(){return <div/>} function News(){return <div/>}\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/App.stories.tsx'),
      'function Home(){return <div/>} function News(){return <div/>}\n');
    assert.deepEqual(
      analyzeProjectStructure(cwd, contract).findings.filter((finding) => finding.severity === 'error'),
      [],
    );
  });
});

test('scanner limit is fail-closed and planned output gaps are blocking', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'), 'export {};\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/extra.ts'), 'export {};\n');
    const report = analyzeProjectStructure(cwd, contract, {
      maxFiles: 1,
      allowlist: ['apps/web/src/main.tsx'],
    });
    assert.equal(report.complete, false);
    const findingIds = ids(report);
    assert.ok(findingIds.includes('STRUCT_SCAN_INCOMPLETE'));
    assert.ok(findingIds.includes('STRUCT_ASSIGNMENT_ALLOWLIST_GAP'));
  });
});

test('source-tree symbolic links make the structural scan incomplete', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.mkdirSync(path.join(cwd, 'external-source'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'external-source/Evil.tsx'), [
      'function Home(){return <main>Home</main>}',
      'function News(){return <main>News</main>}',
      'createBrowserRouter([{path:"/",element:<Home/>},{path:"/news",element:<News/>}]);',
    ].join('\n'));
    fs.symlinkSync(
      path.join(cwd, 'external-source'),
      path.join(cwd, 'apps/web/src/linked'),
      'dir',
    );

    const report = analyzeProjectStructure(cwd, contract);
    assert.equal(report.complete, false);
    assert.ok(ids(report).includes('STRUCT_SCAN_INCOMPLETE'));
    assert.match(
      report.findings.find((finding) => finding.id === 'STRUCT_SCAN_INCOMPLETE')?.message || '',
      /symbolic link.*apps\/web\/src\/linked/i,
    );
  });
});

test('missing or escaped compiled source roots fail closed instead of producing a partial pass', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const missing = analyzeProjectStructure(cwd, {
      ...contract,
      sourceRoots: ['missing-src'],
    });
    assert.equal(missing.complete, false);
    assert.ok(ids(missing).includes('STRUCT_SCAN_INCOMPLETE'));
    assert.match(
      missing.findings.find((finding) => finding.id === 'STRUCT_SCAN_INCOMPLETE')?.message || '',
      /cannot resolve source root missing-src/,
    );

    const escaped = analyzeProjectStructure(cwd, {
      ...contract,
      sourceRoots: ['../outside'],
    });
    assert.equal(escaped.complete, false);
    assert.ok(ids(escaped).includes('STRUCT_SCAN_INCOMPLETE'));
    assert.match(
      escaped.findings.find((finding) => finding.id === 'STRUCT_SCAN_INCOMPLETE')?.message || '',
      /source root escapes project boundary/,
    );
  });
});

test('Next App/Pages and Nuxt framework entrypoints pass when pages are separate', () => {
  const fixtures = [
    {
      prepare(cwd: string): void {
        fs.mkdirSync(path.join(cwd, 'apps/web/app'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
          dependencies: { next: '16.0.0', react: '19.0.0' },
        }));
      },
      profile: 'next-app',
    },
    {
      prepare(cwd: string): void {
        fs.mkdirSync(path.join(cwd, 'apps/web/pages'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
          dependencies: { next: '16.0.0', react: '19.0.0' },
        }));
      },
      profile: 'next-pages',
    },
    {
      prepare(cwd: string): void {
        fs.mkdirSync(path.join(cwd, 'apps/web/ui/app/pages'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
          dependencies: { nuxt: '4.0.0', vue: '3.0.0' },
        }));
        fs.writeFileSync(path.join(cwd, 'apps/web/nuxt.config.ts'),
          "export default defineNuxtConfig({ srcDir: './ui' });\n");
      },
      profile: 'nuxt',
    },
  ] as const;

  for (const fixture of fixtures) {
    withProject((cwd) => {
      fixture.prepare(cwd);
      const contract = compileArchitecture(cwd, 'R', {
        mode: 'new-project',
        stack: 'custom-frontend',
        frontend: 'none',
        backend: 'none',
        mobile: { framework: 'none' },
      }, INPUT);
      assert.equal(contract.profile.profileId, fixture.profile);
      for (const module of contract.modules) {
        fs.mkdirSync(path.dirname(path.join(cwd, module.output)), { recursive: true });
        const content = module.output.endsWith('.vue')
          ? `<template><main>${module.name}</main></template>\n`
          : module.kind === 'app-shell'
            ? `export default function RootLayout({children}:{children:React.ReactNode}){return <html><body>{children}</body></html>}\n`
            : `export default function ${module.name}(){return <main>${module.name}</main>}\n`;
        fs.writeFileSync(path.join(cwd, module.output), content);
      }
      const report = analyzeProjectStructure(cwd, contract);
      assert.equal(report.complete, true);
      assert.deepEqual(
        report.findings.filter((finding) => finding.severity === 'error'),
        [],
        `${fixture.profile}: ${JSON.stringify(report.findings)}`,
      );
    });
  }
});

test('Svelte custom roots pass without a false central-router mismatch', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'frontend/src/pages'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'frontend/src/components'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'frontend/package.json'), JSON.stringify({
      dependencies: { svelte: '5.0.0', vite: '7.0.0' },
    }));
    const contract = compileArchitecture(cwd, 'R', {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { framework: 'none' },
    }, INPUT);
    assert.equal(contract.profile.profileId, 'svelte');
    for (const module of contract.modules) {
      fs.mkdirSync(path.dirname(path.join(cwd, module.output)), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, module.output),
        module.kind === 'app-shell'
          ? '<main><slot /></main>\n'
          : `<main>${module.name}</main>\n`,
      );
    }
    const report = analyzeProjectStructure(cwd, contract);
    assert.equal(report.complete, true);
    assert.deepEqual(
      report.findings.filter((finding) => finding.severity === 'error'),
      [],
      JSON.stringify(report.findings),
    );
  });
});

test('Laravel Blade routes use framework-native Route::view and view() evidence', () => {
  const routeFiles = [
    [
      '<?php',
      "Route::view('/', 'home');",
      "Route::get('/news', fn () => view('news'));",
    ].join('\n'),
    [
      '<?php',
      "Route::get('/', function () {",
      "    return view('home');",
      '});',
      "Route::view('news', 'news');",
    ].join('\n'),
    [
      '<?php',
      "Route::view(uri: '/', view: 'home');",
      "Route::get(uri: '/news', action: fn () => view(view: 'news'));",
    ].join('\n'),
  ];
  for (const routes of routeFiles) {
    withProject((cwd) => {
      const contract = prepareLaravel(cwd);
      assert.equal(contract.profile.router, 'laravel-router');
      assert.ok(contract.profile.sourceRoots.includes('resources/js'),
        'resources/js remains an alternative source root, not client-router evidence');
      writeLaravelModules(cwd, contract);
      fs.writeFileSync(path.join(cwd, 'routes/web.php'), `${routes}\n`);

      const report = analyzeProjectStructure(cwd, contract);
      assert.equal(report.complete, true);
      assert.deepEqual(
        report.findings.filter((finding) => finding.severity === 'error'),
        [],
        JSON.stringify(report.findings),
      );
    });
  }
});

test('Laravel direct render evidence fails closed when the route names the wrong Blade module', () => {
  withProject((cwd) => {
    const contract = prepareLaravel(cwd);
    writeLaravelModules(cwd, contract);
    fs.writeFileSync(path.join(cwd, 'routes/web.php'), [
      '<?php',
      "Route::view('/', 'home');",
      "Route::get('/news', fn () => view('home'));",
      '',
    ].join('\n'));

    const mismatches = analyzeProjectStructure(cwd, contract).findings
      .filter((finding) => finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH')
      .map((finding) => finding.message);
    assert.deepEqual(mismatches, [
      'Route /news does not demonstrably use its compiled module resources/views/news.blade.php.',
    ]);
  });
});

test('Laravel dot-notation views resolve to nested compiled Blade files', () => {
  withProject((cwd) => {
    const contract = prepareLaravel(cwd, false, {
      schemaVersion: 1,
      routes: [{ id: 'admin-news-route', path: '/admin/news', moduleId: 'admin-news' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'admin-news', name: 'Admin News', kind: 'page' },
      ],
    });
    const page = contract.modules.find((module) => module.id === 'admin-news');
    assert.equal(page?.output, 'resources/views/admin/news.blade.php');
    writeLaravelModules(cwd, contract);
    fs.writeFileSync(path.join(cwd, 'routes/web.php'), [
      '<?php',
      "Route::view('/admin/news', 'admin.news');",
      '',
    ].join('\n'));
    assert.deepEqual(
      analyzeProjectStructure(cwd, contract).findings
        .filter((finding) => finding.severity === 'error'),
      [],
    );
  });
});

test('Laravel Inertia routes recognize Route::inertia, Inertia::render, and inertia()', () => {
  const routeFiles = [
    [
      '<?php',
      "Route::get('/', fn () => Inertia::render('Home'));",
      "Route::inertia('/news', 'News');",
    ].join('\n'),
    [
      '<?php',
      "Route::get('/', fn () => inertia('Home'));",
      "Route::get('/news', function () {",
      "    return Inertia::render('News');",
      '});',
    ].join('\n'),
    [
      '<?php',
      "Route::inertia(uri: '/', component: 'Home');",
      "Route::get(uri: '/news', action: fn () => Inertia::render(component: 'News'));",
    ].join('\n'),
  ];
  for (const routes of routeFiles) {
    withProject((cwd) => {
      const contract = prepareLaravel(cwd, true);
      assert.equal(contract.profile.router, 'inertia-react-router');
      writeLaravelModules(cwd, contract);
      fs.writeFileSync(path.join(cwd, 'routes/web.php'), `${routes}\n`);
      assert.deepEqual(
        analyzeProjectStructure(cwd, contract).findings
          .filter((finding) => finding.severity === 'error'),
        [],
      );
    });
  }
});

test('Laravel controller routes defer target resolution to compiled page existence', () => {
  withProject((cwd) => {
    const contract = prepareLaravel(cwd);
    writeLaravelModules(cwd, contract);
    fs.writeFileSync(path.join(cwd, 'routes/web.php'), [
      '<?php',
      "Route::get('/', [HomeController::class, 'index']);",
      'Route::controller(NewsController::class)->group(function () {',
      "    Route::get('/news', 'index');",
      '});',
      '',
    ].join('\n'));

    const complete = analyzeProjectStructure(cwd, contract);
    assert.deepEqual(
      complete.findings.filter((finding) => finding.severity === 'error'),
      [],
    );

    const news = contract.modules.find((module) => module.id === 'news');
    assert.ok(news);
    fs.rmSync(path.join(cwd, news.output));
    const missing = analyzeProjectStructure(cwd, contract);
    assert.ok(missing.findings.some((finding) => (
      finding.id === 'STRUCT_MISSING_PLANNED_MODULE'
      && finding.file === news.output
    )));
    assert.equal(missing.findings.some((finding) => (
      finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH'
      && finding.file === news.output
    )), false, 'missing module has one canonical blocking finding');
  });
});

test('hot single-file structural analysis remains below the 150 ms p95 budget', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const source = [
      'import { Card } from "./components/Card";',
      'export function Dashboard() {',
      '  return <main><Card /></main>;',
      '}',
      '',
    ].join('\n');
    for (let warmup = 0; warmup < 20; warmup += 1) {
      analyzeStructureText('apps/web/src/pages/Dashboard.tsx', source, contract.profile);
    }
    const durations: number[] = [];
    for (let sample = 0; sample < 250; sample += 1) {
      const started = performance.now();
      analyzeStructureText('apps/web/src/pages/Dashboard.tsx', source, contract.profile);
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)]!;
    assert.ok(p95 < 150, `hot structural p95 ${p95.toFixed(2)} ms exceeds 150 ms`);
  });
});

test('collapsed lines are rejected at the write, with strings and types spared', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const collapsed = (file: string, source: string): boolean => (
      analyzeStructureText(file, source, contract.profile)
        .some((finding) => finding.id === 'STRUCT_COLLAPSED_LINE' && finding.severity === 'error')
    );

    // Verbatim shapes from 7co, where the whole implementation phase ran with
    // components packed onto one line and only the completion digest would have
    // caught it.
    assert.equal(collapsed('apps/web/src/components/LearnerNavigation.tsx', [
      "import { useState } from 'react'",
      'export function LearnerNavigation() { const [open,setOpen]=useState(false); const {t}=useTranslation();'
        + ' return <header className="app-header"><div className="shell nav"><NavLink className="brand" to="/">Atlas'
        + ' <span>Learn</span></NavLink><button onClick={()=>setOpen(!open)}>{t(open?\'nav.close\':\'nav.menu\')}</button>'
        + '</div></header> }',
    ].join('\n')), true);

    // A whole component on one line, closed only by self-closing elements.
    assert.equal(collapsed('apps/web/src/pages/CourseDetail.tsx',
      'export default function CourseDetail(){const course=getCourse(useParams().courseSlug);'
      + 'return course?<CourseDetailFeature course={course}/>:<NotFound/>}'), true);

    // Packed JSX inside an otherwise formatted component: three element
    // boundaries on one line is collapse at a much lower width.
    assert.equal(collapsed('apps/web/src/components/CourseCard.tsx', [
      'export function CourseCard({ title, summary }: CourseCardProps) {',
      '  return (',
      '    <Link to="/courses">',
      '      <span className="course-mark">{title.charAt(0)}</span><h3>{title}</h3><p>{summary}</p><em>{summary}</em>',
      '    </Link>',
      '  )',
      '}',
    ].join('\n')), true);

    // Formatted source stays clean — one statement and one element per line.
    assert.equal(collapsed('apps/web/src/pages/Catalog.tsx', [
      'export function Catalog() {',
      '  const { t } = useTranslation()',
      "  const [status, setStatus] = useState<'loading' | 'success'>('loading')",
      '  return (',
      '    <section className="catalog">',
      '      <h1>{t(\'catalog.title\')}</h1>',
      '    </section>',
      '  )',
      '}',
    ].join('\n')), false);

    // A long className/data URI is string content, not code — masking it is the
    // only reason Tailwind-heavy markup is not a permanent false positive.
    assert.equal(collapsed('apps/web/src/components/Hero.tsx', [
      'export function Hero() {',
      '  return <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200'
        + ' bg-white px-4 py-3 shadow-sm hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-offset-2">Hi</div>',
      '}',
    ].join('\n')), false);

    // A one-line TS type body is legitimately `;`-dense and is not code.
    assert.equal(collapsed('apps/web/src/lib/types.ts',
      'export interface Unit { id?: string; role: string; task: string; action: string; status?: string;'
      + ' touched: string[]; model?: string; failureKind?: string | null; error?: string | null }'), false);

    // A nested template literal must not leak out of the mask and read as code.
    assert.equal(collapsed('apps/web/src/lib/report.ts',
      'export function line(points: string[]) { return `expects **${points.length}** across'
      + ' ${points.map((point) => `\\`${point}\\``).join(\', \')}; observed **none**`; }'), false);

    // Generated declaration modules and tests are out of scope.
    const packed = 'export default function X(){const a=1;return <A/><B/><C/>;}';
    assert.equal(collapsed('packages/api-client/src/database.types.ts', packed), false);
    assert.equal(collapsed('apps/web/src/pages/Catalog.test.tsx', packed), false);
  });
});

test('full scan: non-literal route paths surface the cause in mismatch messages plus a warning finding', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    writeLaravelModules(cwd, contract);
    const appShell = contract.modules.find((module) => module.kind === 'app-shell')!.output;
    // The 1co incident shape: every route path is a variable, so the extractor
    // sees zero routes and the mismatch deny used to point at the page module
    // with no cause.
    fs.writeFileSync(path.join(cwd, appShell), [
      "import Home from './pages/HomePage';",
      "import News from './pages/NewsPage';",
      "const homeRoute = '/';",
      "const newsRoute = '/news';",
      'export default function App() {',
      '  return <Routes><Route path={homeRoute} element={<Home />} /><Route path={newsRoute} element={<News />} /></Routes>;',
      '}',
      '',
    ].join('\n'));
    const report = analyzeProjectStructure(cwd, contract);
    const mismatches = report.findings.filter((finding) => finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH');
    assert.ok(mismatches.length >= 1, 'contract routes stay unproven');
    for (const finding of mismatches) {
      assert.match(finding.message, /non-literal route path value/);
      assert.match(finding.message, /plain string literal/);
      assert.match(finding.message, /App\.tsx:\d+/);
      assert.match(finding.message, /path=\{?homeRoute\}?|path=\{?newsRoute\}?/);
    }
    const warning = report.findings.find((finding) => finding.id === 'STRUCT_ROUTE_PATH_UNRESOLVED');
    assert.ok(warning, 'advisory finding is present in the report');
    assert.equal(warning!.severity, 'warning');
  });
});

test('hot contract gate appends the non-literal cause to a coexisting literal mismatch', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const text = [
      "import Wrong from './pages/WrongPage';",
      "const newsRoute = '/news';",
      'export default function App() {',
      '  return <Routes><Route path="/missing" element={<Wrong />} /><Route path={newsRoute} element={<Wrong />} /></Routes>;',
      '}',
      '',
    ].join('\n');
    const findings = analyzeStructureTextAgainstContract('apps/web/src/App.tsx', text, contract);
    const mismatch = findings.find((finding) => finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH');
    assert.ok(mismatch);
    assert.match(mismatch!.message, /is not present in the runtime-compiled architecture contract/);
    assert.match(mismatch!.message, /non-literal route path value/);
    assert.match(mismatch!.message, /path=\{newsRoute\}/);
  });
});

test('pathless index/layout routes stay silent; dynamic route arrays are warning-only', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const indexText = [
      "import Home from './pages/HomePage';",
      'export default function App() {',
      '  return <Routes><Route index element={<Home />} /><Route element={<Home />} /></Routes>;',
      '}',
      '',
    ].join('\n');
    const indexFindings = analyzeStructureTextAgainstContract('apps/web/src/App.tsx', indexText, contract);
    assert.ok(
      !indexFindings.some((finding) => finding.id === 'STRUCT_ROUTE_PATH_UNRESOLVED'),
      'a missing path attribute is legitimate react-router and records nothing',
    );

    const dynamicText = [
      "import { ROUTES } from './lib/routes';",
      "import Page from './pages/HomePage';",
      'export default function App() {',
      '  return <Routes>{ROUTES.map((route) => <Route path={route.path} element={<Page />} />)}</Routes>;',
      '}',
      '',
    ].join('\n');
    const dynamicFindings = analyzeStructureTextAgainstContract('apps/web/src/App.tsx', dynamicText, contract);
    const unresolved = dynamicFindings.find((finding) => finding.id === 'STRUCT_ROUTE_PATH_UNRESOLVED');
    assert.ok(unresolved, 'dynamic route arrays are recorded for visibility');
    assert.equal(unresolved!.severity, 'warning');
    assert.deepEqual(
      dynamicFindings.filter((finding) => finding.severity === 'error'),
      [],
      'a legitimate dynamic pattern never hard-blocks on its own',
    );
  });
});

test('a nested template literal cannot blind the collapse and module-size gates', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const collapsed = 'export function Card(p){return <div><h2>{p.t}</h2><p>{p.b}</p>'
      + '<span>{p.c}</span><em>{p.d}</em><b>{p.e}</b></div>;}';
    // `lexicalMask` used to leave template state out of phase here, end the file
    // inside an unterminated template, and return EVERY later line fully masked.
    // One such line above collapsed code disabled both gates for the remainder.
    const nested = 'const label = `${items.map((x) => `\\`${x}\\``)}`;';

    const alone = analyzeStructureText('apps/web/src/components/Card.tsx', collapsed, contract.profile)
      .map((finding) => finding.id);
    const shadowed = analyzeStructureText(
      'apps/web/src/components/Card.tsx',
      `${nested}\n${collapsed}`,
      contract.profile,
    ).map((finding) => finding.id);

    assert.ok(alone.includes('STRUCT_COLLAPSED_LINE'), 'baseline: collapse is detected');
    assert.ok(
      shadowed.includes('STRUCT_COLLAPSED_LINE'),
      'a preceding nested template must not hide collapsed source',
    );
  });
});

test('React.lazy route bindings are imports, not inline pages', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const pages = ['Home', 'News'];
    const routes = 'const router = createBrowserRouter([\n'
      + pages.map((p) => `  { path: "/${p.toLowerCase()}", element: <${p} /> },`).join('\n')
      + '\n]);\n';
    const shell = 'export default function App() {\n'
      + '  return <RouterProvider router={router} />;\n'
      + '}\n';

    const staticImports = `${pages.map((p) => `import ${p} from './pages/${p}';`).join('\n')}\n${routes}${shell}`;
    // The 9co repro: converting the SAME file to code splitting turned one
    // advisory warning into a blocking error.
    const lazyImports = "import { lazy } from 'react';\n"
      + `${pages.map((p) => `const ${p} = lazy(() => import('./pages/${p}'));`).join('\n')}\n${routes}${shell}`;

    const errorsFor = (source: string): string[] => (
      analyzeStructureText('apps/web/src/App.tsx', source, contract.profile)
        .filter((finding) => finding.severity === 'error')
        .map((finding) => finding.id)
        .sort()
    );

    assert.deepEqual(errorsFor(staticImports), [], 'baseline: static page imports are clean');
    assert.deepEqual(
      errorsFor(lazyImports),
      errorsFor(staticImports),
      'code splitting must not change the structural verdict',
    );
  });
});
