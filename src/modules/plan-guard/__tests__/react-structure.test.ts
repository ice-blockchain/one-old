import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assertLatencyBudget } from '../../../test-support/__tests__/latency-budget';
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

// Everything the scan REPORTED, at any severity. Scan integrity is reported in
// every mode and blocks in none (see the push site in scan.ts), so its
// assertions read this list and pin the severity separately.
function reportedIds(report: ReturnType<typeof analyzeProjectStructure>): string[] {
  return [...new Set(report.findings.map((finding) => finding.id))].sort();
}

function severityOf(
  report: ReturnType<typeof analyzeProjectStructure>,
  id: string,
): string | undefined {
  return report.findings.find((finding) => finding.id === id)?.severity;
}

function writeResolvedUiSystem(
  cwd: string,
  primitive: string,
  consumerSource: string,
): void {
  for (const dir of [
    'packages/ui/src/components/ui',
    'packages/ui/src/lib',
    'packages/tailwind-config/src',
    'apps/web/src/components',
  ]) fs.mkdirSync(path.join(cwd, dir), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'packages/ui/package.json'), JSON.stringify({
    name: '@app/ui',
    exports: { '.': './src/index.ts' },
  }));
  fs.writeFileSync(path.join(cwd, 'packages/ui/components.json'), JSON.stringify({
    $schema: 'https://ui.shadcn.com/schema.json',
    aliases: { ui: '@app/ui/components/ui' },
  }));
  fs.writeFileSync(path.join(cwd, 'packages/ui/src/lib/utils.ts'), 'export const cn = (...values: string[]) => values.join(" ");\n');
  fs.writeFileSync(
    path.join(cwd, 'packages/ui/src/index.ts'),
    `export * from "./components/ui/${primitive}";\n`,
  );
  const componentName = primitive
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
  fs.writeFileSync(
    path.join(cwd, `packages/ui/src/components/ui/${primitive}.tsx`),
    `export function ${componentName}(){return <div />}\n`,
  );
  fs.writeFileSync(path.join(cwd, 'packages/tailwind-config/package.json'), JSON.stringify({
    name: '@app/tailwind-config',
  }));
  fs.writeFileSync(path.join(cwd, 'packages/tailwind-config/src/globals.css'), '@import "tailwindcss";\n');
  fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), JSON.stringify({
    dependencies: {
      '@app/ui': 'workspace:*',
      react: '19.0.0',
      tailwindcss: '4.0.0',
      vite: '7.0.0',
    },
  }));
  fs.writeFileSync(
    path.join(cwd, `apps/web/src/components/${componentName}Demo.tsx`),
    `import "@app/tailwind-config/globals.css";\n${consumerSource}`,
  );
}

function writeCompiledModules(cwd: string, contract: CompiledArchitectureV1): void {
  for (const module of contract.modules) {
    fs.mkdirSync(path.dirname(path.join(cwd, module.output)), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, module.output),
      module.kind === 'app-shell'
        ? 'export function App(){return <main />}\n'
        : `export function ${module.name}(){return <main />}\n`,
    );
  }
  for (const entrypoint of contract.entrypoints) {
    fs.mkdirSync(path.dirname(path.join(cwd, entrypoint)), { recursive: true });
    fs.writeFileSync(path.join(cwd, entrypoint), 'export {};\n');
  }
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

// Installed + exported is a FACT and blocks. Whether every selected primitive is
// CONSUMED is a product judgment the role cannot resolve — the catalog is
// immutable after PLAN_READY, deleting the file just trades this finding for
// STRUCT_UI_SYSTEM_MISSING, and this very test's satisfying fixture is a
// `<Name>Demo.tsx`, i.e. the preview block the reviewer rejects. Enforced as an
// error it produced faked usage twice (14co previews, 15co inert wrappers) and
// the reviewer caught both, so it batches to the reviewer instead of blocking.
test('a catalog primitive must be installed and exported; being unconsumed only advises', () => {
  withProject((cwd) => {
    const contract = prepare(cwd, { ...INPUT, uiPrimitives: ['progress'] });
    writeCompiledModules(cwd, contract);
    const report = analyzeProjectStructure(cwd, contract, { greenfield: true });
    const missing = ids(report);
    assert.ok(missing.includes('STRUCT_UI_SYSTEM_MISSING'), 'a missing primitive is a fact and blocks');
    assert.ok(!missing.includes('STRUCT_UI_PRIMITIVE_NOT_SHARED'), 'unconsumed must not block');
    // It is still REPORTED — demoted, never dropped, or the reviewer loses it.
    const unconsumed = report.findings.find((finding) => finding.id === 'STRUCT_UI_PRIMITIVE_NOT_SHARED');
    assert.ok(unconsumed, 'the finding must still reach the quality ledger');
    assert.equal(unconsumed?.severity, 'warning');
    assert.match(unconsumed?.message || '', /do NOT add a preview\/demo block/);

    writeResolvedUiSystem(
      cwd,
      'progress',
      'import { Progress } from "@app/ui";\nexport function ProgressDemo(){return <Progress />}\n',
    );
    const resolved = analyzeProjectStructure(cwd, contract, { greenfield: true });
    assert.ok(!ids(resolved).includes('STRUCT_UI_SYSTEM_MISSING'));
    assert.ok(
      !resolved.findings.some((finding) => finding.id === 'STRUCT_UI_PRIMITIVE_NOT_SHARED'),
      'a real @app/ui consumer clears it entirely',
    );
  });
});

test('manual progress/dialog primitives and app-local CLI copies are rejected', () => {
  for (const primitive of ['progress', 'dialog']) {
    withProject((cwd) => {
      const componentName = primitive.charAt(0).toUpperCase() + primitive.slice(1);
      const contract = prepare(cwd, { ...INPUT, uiPrimitives: [primitive] });
      writeCompiledModules(cwd, contract);
      writeResolvedUiSystem(
        cwd,
        primitive,
        `export function ${componentName}(){return <div role="${primitive === 'dialog' ? 'dialog' : 'progressbar'}" />}\n`,
      );
      const handRolled = ids(analyzeProjectStructure(cwd, contract, { greenfield: true }));
      assert.ok(handRolled.includes('STRUCT_UI_PRIMITIVE_NOT_SHARED'), primitive);

      const duplicatePath = path.join(cwd, `apps/web/src/components/ui/${primitive}.tsx`);
      fs.mkdirSync(path.dirname(duplicatePath), { recursive: true });
      fs.writeFileSync(duplicatePath, `export function ${componentName}(){return <div />}\n`);
      const duplicated = ids(analyzeProjectStructure(cwd, contract, { greenfield: true }));
      assert.ok(duplicated.includes('STRUCT_UI_PRIMITIVE_DUPLICATE'), primitive);
    });
  }
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

// StructureScanOptions.existing (existing-* modes): the complete scan judges
// every pre-existing file, so every architectural finding it can raise is an
// OPINION about code Traffic One did not write and demotes to a warning — a
// maintenance run must not dead-end on the user's own entrypoint conventions,
// line width, routing, primitive sharing or catalog shape. The exclusion is
// stated rather than enumerated: ownership and plan delivery are the only two
// findings that are not conventions, so they are the only two that stay errors.
test('existing option demotes every architectural opinion, leaving only ownership and plan delivery', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'), [
      'import { createRoot } from "react-dom/client";',
      'import { App } from "./App";',
      'function HomeShell(){ return <main>shell</main>; }',
      'createRoot(document.getElementById("root")!).render(<App />);',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(cwd, 'apps/web/src/App.tsx'), [
      'import { createBrowserRouter, RouterProvider } from "react-router-dom";',
      'import { WrongHome } from "./components/WrongHome";',
      'import { News } from "./pages/News";',
      'const router = createBrowserRouter([{ path: "/", element: <WrongHome /> }, { path: "/news", element: <News /> }]);',
      'export function App() { return <RouterProvider router={router} />; }',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Home.tsx'),
      'export function Home(){return <main>Home</main>}\n');
    // A pre-existing collapsed page the repo owner wrote.
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/News.tsx'),
      'export function News(){const a=1;return <main><section><h1>News</h1><p>Text</p></section><footer><span>Foot</span></footer></main>;}\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/components/WrongHome.tsx'),
      'export function WrongHome(){return <main>Wrong</main>}\n');

    const DEMOTED = ['STRUCT_COLLAPSED_LINE', 'STRUCT_ENTRYPOINT_COMPONENT', 'STRUCT_ROUTE_MODULE_MISMATCH'];
    const strict = analyzeProjectStructure(cwd, contract);
    for (const id of DEMOTED) {
      assert.ok(ids(strict).includes(id), `${id} must be an error without the existing option`);
    }

    const relaxed = analyzeProjectStructure(cwd, contract, { notScaffolded: true });
    for (const id of DEMOTED) {
      assert.ok(!ids(relaxed).includes(id), `${id} must not be an error with notScaffolded: true`);
      assert.ok(
        relaxed.findings.some((finding) => finding.id === id && finding.severity === 'warning'),
        `${id} is still reported, as a warning`,
      );
    }
    assert.equal(relaxed.status, 'warnings');
    assert.deepEqual(ids(relaxed), [], 'an opinion about the user own code never blocks');

    // Ownership is not architecture: allowlist gaps stay errors in every mode.
    const scoped = analyzeProjectStructure(cwd, contract, {
      notScaffolded: true,
      allowlist: ['apps/web/src/main.tsx'],
    });
    assert.deepEqual(ids(scoped), ['STRUCT_ASSIGNMENT_ALLOWLIST_GAP']);
  });

  // Plan delivery is the other exclusion, and it is a fact about the compiled
  // contract rather than a convention: the module this run promised does not
  // exist on disk. Nothing about an existing codebase makes that legitimate.
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'), 'export {};\n');
    const report = analyzeProjectStructure(cwd, contract, { notScaffolded: true });
    assert.deepEqual(ids(report), ['STRUCT_MISSING_PLANNED_MODULE']);
  });
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

// The scanner limit is REPORTED rather than blocking: the bound it trips is a
// file count over a tree the writer usually cannot shrink, and the deny it used
// to raise named no remedy. What replaces the block lives in the verification
// contract — an incomplete diff pins `uiImpact` to the domain maximum, so a
// truncated run owes more browser evidence than a complete one. Truncation is
// one-directional as evidence besides: a walk that stopped early can only miss a
// finding, never fabricate one, so the allowlist gap it DID see still blocks.
test('scanner limit is reported as a warning and planned output gaps stay blocking', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'), 'export {};\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/extra.ts'), 'export {};\n');
    const report = analyzeProjectStructure(cwd, contract, {
      maxFiles: 1,
      allowlist: ['apps/web/src/main.tsx'],
    });
    assert.equal(report.complete, false);
    assert.ok(reportedIds(report).includes('STRUCT_SCAN_INCOMPLETE'));
    assert.equal(severityOf(report, 'STRUCT_SCAN_INCOMPLETE'), 'warning');
    assert.ok(ids(report).includes('STRUCT_ASSIGNMENT_ALLOWLIST_GAP'));
  });
});

// The scan's skip list and COLLAPSE_SKIP_DIR_RE must name the same build-output
// roots. A cache the framework wrote inside a source root is not just scan
// budget the walk spends for nothing — it is ANALYZED, and emitted bundles are
// collapsed, oversized and full of hardcoded copy, so the run is judged on
// output the user never authored and cannot fix. `target` is deliberately
// segment-anchored: a source file called `target.ts` is still scanned.
test('framework build caches inside a source root are skipped, not judged as authored code', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'), 'export {};\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/target.ts'), 'export const target = 1;\n');
    // One packed bundle per cache root: collapsed source is an error-severity
    // finding, so an unskipped root announces itself.
    const bundle = `${'function chunk(){return 1};'.repeat(40)}\n`;
    for (const cache of ['.svelte-kit/output', '.nuxt/dist', '.angular/cache', 'target/classes']) {
      fs.mkdirSync(path.join(cwd, 'apps/web/src', cache), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'apps/web/src', cache, 'bundle.js'), bundle);
    }
    const report = analyzeProjectStructure(cwd, contract, {
      allowlist: ['apps/web/src/**'],
    });
    assert.equal(report.complete, true);
    assert.deepEqual(
      report.findings.filter((finding) => /\.svelte-kit|\.nuxt|\.angular|(^|\/)target\//.test(finding.file)),
      [],
      JSON.stringify(report.findings),
    );
    assert.equal(report.filesScanned, 2,
      'main.tsx and target.ts only — a source file merely NAMED target is still scanned');
  });
});

test('a source-tree symbolic link is skipped and recorded, and the walk continues', () => {
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
    // Not followed — the linked tree is source the contract does not govern —
    // and not fatal either. The link is one entry; the rest of the tree is still
    // walked, so `complete` stays true. It is not FREE, though: nothing read the
    // subtree behind it, so the entry is counted and the caller turns that count
    // into the same `uiImpact` floor the file cap earns (B1).
    assert.equal(report.complete, true);
    assert.equal(report.truncationKind, undefined);
    assert.equal(report.skippedEntries, 1, 'counted, because the subtree behind it went unread');
    assert.ok(!reportedIds(report).includes('STRUCT_SCAN_INCOMPLETE'));
    assert.equal(severityOf(report, 'STRUCT_SCAN_SKIPPED'), 'warning');
    assert.match(
      report.findings.find((finding) => finding.id === 'STRUCT_SCAN_SKIPPED')?.message || '',
      /symbolic link.*apps\/web\/src\/linked/i,
    );
  });
});

test('one planted link cannot withdraw an error-grade finding from the rest of the tree', () => {
  // The B1 attack, verbatim: `walkSourceFiles` used to RETURN at the link, so
  // an entry sorting before the real source took every finding after it off
  // the report while `filesScanned` still read plausible. Measured before the
  // fix: STRUCT_ENTRYPOINT_COMPONENT present without the link, absent with it,
  // and the git diff complete throughout, so nothing pinned `uiImpact` either.
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'), [
      "import { createRoot } from 'react-dom/client';",
      'export function Inline() { return <div>inline</div>; }',
      "createRoot(document.getElementById('root')!).render(<Inline />);",
      '',
    ].join('\n'));
    const withoutLink = analyzeProjectStructure(cwd, contract, { greenfield: true });
    assert.ok(reportedIds(withoutLink).includes('STRUCT_ENTRYPOINT_COMPONENT'));

    // `aaa-` so the link is read before `main.tsx` in directory order.
    fs.symlinkSync(
      path.join(cwd, 'apps/web/src/pages'),
      path.join(cwd, 'apps/web/src/aaa-linked'),
      'dir',
    );
    const withLink = analyzeProjectStructure(cwd, contract, { greenfield: true });
    assert.ok(reportedIds(withLink).includes('STRUCT_ENTRYPOINT_COMPONENT'),
      'the defect must still be found with a link planted ahead of it');
    assert.equal(withLink.status, 'failed');
    assert.equal(withLink.filesScanned, withoutLink.filesScanned);
    // And this link costs nothing to COUNT either: it resolves to
    // `apps/web/src/pages`, which this same walk reads under its real path, so
    // there is no unread subtree behind it and no floor to owe. Counting it
    // would price a loop or an in-tree alias as lost coverage it never lost.
    assert.equal(withLink.skippedEntries, 0);
    assert.ok(!reportedIds(withLink).includes('STRUCT_SCAN_SKIPPED'));
  });
});

test('an unreadable source file costs that file and no other', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/main.tsx'), [
      "import { createRoot } from 'react-dom/client';",
      'export function Inline() { return <div>inline</div>; }',
      "createRoot(document.getElementById('root')!).render(<Inline />);",
      '',
    ].join('\n'));
    // Sorts before `main.tsx`, so the old `break` dropped the entrypoint with
    // it — measured as `filesScanned: 0` on a project with three source files.
    const blocked = path.join(cwd, 'apps/web/src/aaa-blocked.tsx');
    fs.writeFileSync(blocked, 'export const x = 1;\n');
    fs.chmodSync(blocked, 0o000);
    try {
      const report = analyzeProjectStructure(cwd, contract, { greenfield: true });
      assert.equal(report.complete, true);
      assert.ok(reportedIds(report).includes('STRUCT_ENTRYPOINT_COMPONENT'));
      assert.equal(report.skippedEntries, 1, 'costs that file — and the evidence floor for it');
      assert.match(
        report.findings.find((finding) => finding.id === 'STRUCT_SCAN_SKIPPED')?.message || '',
        /cannot read source file .*aaa-blocked\.tsx/,
      );
    } finally {
      fs.chmodSync(blocked, 0o644);
    }
  });
});

test('the file bound is the one truncation left, and it stays a warning', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/a.tsx'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/b.tsx'), 'export const b = 1;\n');
    const report = analyzeProjectStructure(cwd, contract, { maxFiles: 1 });
    assert.equal(report.complete, false);
    assert.equal(report.truncationKind, 'bound');
    assert.equal(severityOf(report, 'STRUCT_SCAN_INCOMPLETE'), 'warning');
    assert.match(
      report.findings.find((finding) => finding.id === 'STRUCT_SCAN_INCOMPLETE')?.message || '',
      /exceeds 1 files/,
    );
  });
});

test('an unresolvable source root blocks, because no floor compensates a report about nothing', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    // The coupling condition, literally: STRUCT_SCAN_INCOMPLETE is a warning
    // only where the verification contract raises `uiImpact` for it. The floor
    // is fed by the BOUND, so a walk that found no tree at all keeps the error
    // — otherwise a run whose source roots do not resolve clears the completion
    // gates on the strength of having judged no files.
    const missing = analyzeProjectStructure(cwd, {
      ...contract,
      sourceRoots: ['missing-src'],
    });
    assert.equal(missing.complete, false);
    assert.equal(missing.truncationKind, 'unresolvable');
    assert.equal(severityOf(missing, 'STRUCT_SCAN_INCOMPLETE'), 'error');
    assert.match(
      missing.findings.find((finding) => finding.id === 'STRUCT_SCAN_INCOMPLETE')?.message || '',
      /cannot resolve source root missing-src/,
    );

    const escaped = analyzeProjectStructure(cwd, {
      ...contract,
      sourceRoots: ['../outside'],
    });
    assert.equal(escaped.complete, false);
    assert.equal(escaped.truncationKind, 'unresolvable');
    assert.equal(severityOf(escaped, 'STRUCT_SCAN_INCOMPLETE'), 'error');
    assert.match(
      escaped.findings.find((finding) => finding.id === 'STRUCT_SCAN_INCOMPLETE')?.message || '',
      /source root escapes project boundary/,
    );
    // Scan integrity is not an opinion, so the not-scaffolded demotion does not
    // reach it — that demotion runs before this finding is pushed.
    const unowned = analyzeProjectStructure(cwd, {
      ...contract,
      sourceRoots: ['missing-src'],
    }, { notScaffolded: true });
    assert.equal(severityOf(unowned, 'STRUCT_SCAN_INCOMPLETE'), 'error');
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

// THROUGH THE THREE-VALUED INSTRUMENT, not a bare `assert.ok(p95 < 150)`.
// This was the same 150 ms threshold, the same 250 samples, the same 20 warmups
// and the same percentile index as the Write pre-tool budget the instrument was
// built for — written two-valued, so a contended machine could only report it as
// a code regression, which is the flake that instrument exists to remove. It also
// imported nothing, so the coverage check in
// src/test-support/__tests__/latency-budget-ci.test.ts could not see it, and it
// ran only inside the parallel suite, where an INCONCLUSIVE verdict is a warning
// by design. Un-enforced and flake-prone at once; both halves are closed by
// measuring it here and naming this file in the serial `latency-budget` job.
test('hot single-file structural analysis remains below the 150 ms p95 budget', (t) => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const source = [
      'import { Card } from "./components/Card";',
      'export function Dashboard() {',
      '  return <main><Card /></main>;',
      '}',
      '',
    ].join('\n');
    assertLatencyBudget(t, {
      label: 'hot single-file structural analysis',
      budgetMs: 150,
      samples: 250,
      warmup: 20,
      run: () => { analyzeStructureText('apps/web/src/pages/Dashboard.tsx', source, contract.profile); },
    });
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

test('a missing router table names the app shell and the exact Route to add', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    writeCompiledModules(cwd, contract);
    const report = analyzeProjectStructure(cwd, contract);
    const mismatches = report.findings.filter((finding) => finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH');
    assert.ok(mismatches.length >= 1, 'contract routes stay unproven');
    const shell = contract.modules.find((module) => module.kind === 'app-shell')!.output;
    for (const finding of mismatches) {
      assert.match(finding.message, /no `<Route path>` \/ `createBrowserRouter` `path:`/);
      assert.match(finding.message, new RegExp(shell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(finding.message, /<Route path="/);
    }
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

// The other half of the 13cl parity fix: demoting cross-locale parity at WRITE
// time must not weaken completion. A parity gap still on disk when the role
// reports done is a blocking error in the full structure scan, exactly as
// before.
test('full scan still blocks on cross-locale catalog parity left broken at completion', () => {
  withProject((cwd) => {
    const contract = prepare(cwd, {
      ...INPUT,
      i18n: { sourceLocale: 'en', locales: ['en', 'ro'], literalBrands: [] },
    });
    writeCompiledModules(cwd, contract);
    const catalogs = contract.i18n!.catalogs.filter((catalog) => catalog.namespaces.includes('common'));
    assert.ok(catalogs.length >= 2, 'contract compiles a catalog per locale');
    for (const catalog of catalogs) {
      fs.mkdirSync(path.dirname(path.join(cwd, catalog.path)), { recursive: true });
      fs.writeFileSync(path.join(cwd, catalog.path), JSON.stringify(
        catalog.locales.includes('en')
          ? { welcome: 'Welcome', installLabel: 'Install the app' }
          : { welcome: 'Bun venit' },
      ));
    }
    const report = analyzeProjectStructure(cwd, contract, { greenfield: true });
    assert.ok(
      report.findings.some((finding) => (
        finding.id === 'STRUCT_I18N_CATALOG'
        && finding.severity === 'error'
        && /installLabel/.test(finding.message)
      )),
      JSON.stringify(report.findings.filter((finding) => finding.id === 'STRUCT_I18N_CATALOG')),
    );
  });
});

// 14cl false positives: the object-route recognizer matched `path:` in a
// TypeScript interface (Seo.tsx:21 — "path: string; robots?: RobotsPolicy")
// and in a Zod validation path (SignUpForm.tsx:45 — "path: ['confirmPassword']");
// only Courses.tsx:42 ("path: CATALOG_PATH" inside a real route table) was a
// route. A type member, an array literal, or a routeless object is not an
// unverifiable route — it is not a route.
test('interface members and Zod issue paths are not unresolved routes; route-table shapes still are', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    const seo = [
      "import { useEffect } from 'react';",
      '',
      'export interface SeoProps {',
      '  title: string;',
      '  /** Absolute or root-relative canonical path for the page. */',
      '  path: string;',
      '  robots?: { index: boolean; follow: boolean };',
      '}',
      '',
      'export function Seo({ title, path }: SeoProps) {',
      '  useEffect(() => {',
      '    document.title = title;',
      '  }, [title, path]);',
      '  return null;',
      '}',
      '',
    ].join('\n');
    assert.ok(
      !analyzeStructureTextAgainstContract('apps/web/src/components/Seo.tsx', seo, contract)
        .some((finding) => finding.id === 'STRUCT_ROUTE_PATH_UNRESOLVED'),
      'an interface member `path: string;` is type syntax, not a route',
    );

    const zodForm = [
      "import { z } from 'zod';",
      '',
      'export const signUpSchema = z',
      '  .object({',
      '    password: z.string().min(8),',
      '    confirmPassword: z.string(),',
      '  })',
      '  .refine((data) => data.password === data.confirmPassword, {',
      "    message: 'auth:passwordsMustMatch',",
      "    path: ['confirmPassword'],",
      '  });',
      '',
    ].join('\n');
    assert.ok(
      !analyzeStructureTextAgainstContract('apps/web/src/features/auth/SignUpForm.tsx', zodForm, contract)
        .some((finding) => finding.id === 'STRUCT_ROUTE_PATH_UNRESOLVED'),
      'a Zod issue path array is never a route path',
    );

    // The 1co class stays visible: `path: CONSTANT` inside a recognized route
    // table (call context) …
    const routeTable = [
      "import { createBrowserRouter } from 'react-router-dom';",
      '',
      "import News from './pages/NewsPage';",
      '',
      "const NEWS_PATH = '/news';",
      '',
      'export const router = createBrowserRouter([',
      '  { path: NEWS_PATH, element: <News /> },',
      ']);',
      '',
    ].join('\n');
    const tableUnresolved = analyzeStructureTextAgainstContract('apps/web/src/router.tsx', routeTable, contract)
      .find((finding) => finding.id === 'STRUCT_ROUTE_PATH_UNRESOLVED');
    assert.ok(tableUnresolved, 'path: CONSTANT inside a route table stays reported');
    assert.equal(tableUnresolved!.severity, 'warning');

    // … and a route-signal sibling key alone (a `children` nested-route parent
    // with no table call in the same file) is also enough.
    const objectRoutes = [
      "const HOME = '/';",
      'export const routes = [',
      '  { path: HOME, children: [] },',
      '];',
      '',
    ].join('\n');
    assert.ok(
      analyzeStructureTextAgainstContract('apps/web/src/routes.tsx', objectRoutes, contract)
        .some((finding) => finding.id === 'STRUCT_ROUTE_PATH_UNRESOLVED'),
      'a route-shaped object outside a table call still records the advisory',
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

test('a directory import of a feature barrel is a reference, not an orphan', () => {
  // Observed: `lazy(() => import('./features/event-search-feature'))` did not
  // match the compiled `.../event-search-feature/index.tsx`, STRUCT_ORPHAN_MODULE
  // fired, and the agent offered `--unblock` as a lazy-loading false positive.
  withProject((cwd) => {
    const contract = prepare(cwd, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
        { id: 'event-search-feature', name: 'Event Search Feature', kind: 'feature' },
      ],
    });
    writeCompiledModules(cwd, contract);
    const feature = contract.modules.find((module) => module.id === 'event-search-feature')!;
    assert.match(feature.output, /\/event-search-feature\/index\.tsx$/);
    const shell = contract.modules.find((module) => module.kind === 'app-shell')!;
    const home = contract.modules.find((module) => module.id === 'home')!;

    const orphaned = ids(analyzeProjectStructure(cwd, contract, { greenfield: true }));
    assert.ok(orphaned.includes('STRUCT_ORPHAN_MODULE'), 'baseline: unwired feature is an orphan');

    fs.writeFileSync(path.join(cwd, shell.output), [
      "import { lazy } from 'react';",
      `const Home = lazy(() => import('./pages/${path.posix.basename(home.output, '.tsx')}'));`,
      "const EventSearch = lazy(() => import('./features/event-search-feature'));",
      'export default function App() {',
      '  return <Routes><Route path="/" element={<Home />} /><Route path="/search" element={<EventSearch />} /></Routes>;',
      '}',
      '',
    ].join('\n'));
    const wired = analyzeProjectStructure(cwd, contract, { greenfield: true });
    assert.ok(
      !wired.findings.some((finding) => (
        finding.id === 'STRUCT_ORPHAN_MODULE' && finding.file === feature.output
      )),
      `directory import must count as a reference, got: ${
        wired.findings.filter((finding) => finding.id === 'STRUCT_ORPHAN_MODULE').map((finding) => finding.file).join(',')
      }`,
    );

    fs.writeFileSync(path.join(cwd, shell.output), [
      'const router = createBrowserRouter([',
      `  { path: '/', lazy: () => import('./pages/${path.posix.basename(home.output, '.tsx')}') },`,
      "  { path: '/search', lazy: () => import('./features/event-search-feature') },",
      ']);',
      'export default function App() { return <RouterProvider router={router} />; }',
      '',
    ].join('\n'));
    const objectLazy = analyzeProjectStructure(cwd, contract, { greenfield: true });
    assert.ok(
      !objectLazy.findings.some((finding) => (
        finding.id === 'STRUCT_ORPHAN_MODULE' && finding.file === feature.output
      )),
      'route-object lazy import() without a const binding must also count',
    );
  });
});

// Regression: the source scan treated ANY symbolic link as a fatal incomplete
// scan. Traffic One's own materialization writes root `CLAUDE.md -> AGENTS.md`,
// so every profile whose source root is the project root (Nuxt, and any
// `.`-rooted profile) reported STRUCT_SCAN_INCOMPLETE and could never emit
// IMPLEMENTED — a dead end the implementer cannot clear, because the file is
// generated. A link resolving inside the project is a duplicate or an alias of
// something the walk already covers; a link ESCAPING the project still makes
// the scan incomplete, which is the case the guard exists for.
// Found by the run-sim tier's Nuxt shape.
test('an in-project symlink does not make the source scan incomplete', () => {
  withProject((cwd) => {
    const contract = prepare(cwd, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
      ],
    });
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Home.tsx'),
      'export function Home(){return <main>Home</main>}\n');
    // Exactly what materializeProjectAssets writes at the project root.
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# generated\n');
    fs.symlinkSync('AGENTS.md', path.join(cwd, 'CLAUDE.md'));

    const report = analyzeProjectStructure(cwd, contract);
    assert.ok(
      !report.findings.some((finding) => finding.id === 'STRUCT_SCAN_INCOMPLETE'),
      `in-project symlink must not truncate the scan: ${JSON.stringify(report.findings)}`,
    );
  });
});

test('a directory symlink out of the project is skipped, not followed, and not fatal', () => {
  withProject((cwd) => {
    const contract = prepare(cwd, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
      ],
    });
    fs.writeFileSync(path.join(cwd, 'apps/web/src/pages/Home.tsx'),
      'export function Home(){return <main>Home</main>}\n');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 't1-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'Elsewhere.tsx'), 'export const x = 1;\n');
      fs.symlinkSync(outside, path.join(cwd, 'apps/web/src/linked'));
      const report = analyzeProjectStructure(cwd, contract);
      assert.ok(
        report.findings.some((finding) => (
          finding.id === 'STRUCT_SCAN_SKIPPED' && /linked/.test(finding.message)
        )),
        'a directory link can graft source the contract does not govern, so it is not followed',
      );
      assert.ok(
        !report.findings.some((finding) => finding.file.includes('linked')),
        'and nothing under it is judged',
      );
      assert.equal(report.complete, true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('a headless .ts feature entry satisfies its compiled module and stays wired (extension freedom)', () => {
  // The class this kills (12co): the compiled table said `.tsx`, the section
  // held no JSX, and the single-path existence gate forced a rewrite. The
  // contract pins the BASE PATH; any allowed extension delivered there
  // settles, and the orphan/import checks match by stem, extension-blind.
  withProject((cwd) => {
    const contract = prepare(cwd, {
      ...INPUT,
      modules: [
        ...INPUT.modules,
        { id: 'auth', name: 'Auth', kind: 'feature' },
      ],
    });
    writeCompiledModules(cwd, contract);
    const feature = contract.modules.find((module) => module.id === 'auth')!;
    assert.deepEqual(feature.allowedExtensions, ['.tsx', '.ts']);
    fs.rmSync(path.join(cwd, feature.output));
    const variant = feature.output.replace(/\.tsx$/, '.ts');
    fs.writeFileSync(
      path.join(cwd, variant),
      'export async function signOut(): Promise<void> {\n  return;\n}\n',
    );
    const home = contract.modules.find((module) => module.id === 'home')!;
    fs.writeFileSync(
      path.join(cwd, home.output),
      'import { signOut } from "../features/auth/index";\n'
      + 'export function Home(){return <main onClick={() => void signOut()}>Home</main>}\n',
    );
    const settled = ids(analyzeProjectStructure(cwd, contract, { greenfield: true }));
    assert.ok(!settled.includes('STRUCT_MISSING_PLANNED_MODULE'), settled.join(','));
    assert.ok(!settled.includes('STRUCT_ORPHAN_MODULE'), settled.join(','));

    // With NO variant on disk the missing-module gate still fires.
    fs.rmSync(path.join(cwd, variant));
    const missing = ids(analyzeProjectStructure(cwd, contract, { greenfield: true }));
    assert.ok(missing.includes('STRUCT_MISSING_PLANNED_MODULE'));
  });
});

// B1, the walk-notions table as a test. One collapsed source file planted in a
// compiled source root, then hidden from the walk four different ways. Measured
// before the fix, every hidden row read `status: warnings`, `complete: true`,
// `truncationKind: null`, the defect ABSENT, and no floor owed — while the file
// cap, the one route that was compensated, read `failed`/`bound`/floor raised.
// Both halves matter: a report that cannot say the defect is there must at least
// say it did not look, and pay for the looking it skipped.
test('every way of not reading a subtree is counted, and none of them hides a defect silently', () => {
  const COLLAPSED = 'export function Widget(){ const a=1; const b=2; const c=3; return <div>'
    + '<span>{a}</span><span>{b}</span><span>{c}</span></div>; }\n';
  const rows: Array<{
    label: string;
    plant: (cwd: string) => void;
    restore?: (cwd: string) => void;
  }> = [
    {
      label: 'directory symlink over the subtree',
      plant: (cwd) => {
        fs.mkdirSync(path.join(cwd, 'outside/widgets'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'outside/widgets/Widget.tsx'), COLLAPSED);
        fs.symlinkSync(path.join(cwd, 'outside/widgets'),
          path.join(cwd, 'apps/web/src/features/widgets'), 'dir');
      },
    },
    {
      label: 'unreadable directory',
      plant: (cwd) => {
        fs.mkdirSync(path.join(cwd, 'apps/web/src/features/widgets'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'apps/web/src/features/widgets/Widget.tsx'), COLLAPSED);
        fs.chmodSync(path.join(cwd, 'apps/web/src/features/widgets'), 0o000);
      },
      restore: (cwd) => fs.chmodSync(path.join(cwd, 'apps/web/src/features/widgets'), 0o755),
    },
    {
      label: 'unreadable file',
      plant: (cwd) => {
        fs.writeFileSync(path.join(cwd, 'apps/web/src/features/Widget.tsx'), COLLAPSED);
        fs.chmodSync(path.join(cwd, 'apps/web/src/features/Widget.tsx'), 0o000);
      },
      restore: (cwd) => fs.chmodSync(path.join(cwd, 'apps/web/src/features/Widget.tsx'), 0o644),
    },
    {
      label: 'symlinked source file',
      plant: (cwd) => {
        fs.mkdirSync(path.join(cwd, 'outside'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'outside/Widget.tsx'), COLLAPSED);
        fs.symlinkSync(path.join(cwd, 'outside/Widget.tsx'),
          path.join(cwd, 'apps/web/src/features/Widget.tsx'));
      },
    },
  ];

  // The control: read normally, the defect is an ERROR finding, and nothing is
  // owed because nothing went unread.
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.writeFileSync(path.join(cwd, 'apps/web/src/features/Widget.tsx'), COLLAPSED);
    const control = analyzeProjectStructure(cwd, contract, { greenfield: true });
    assert.equal(control.status, 'failed');
    assert.ok(reportedIds(control).includes('STRUCT_COLLAPSED_LINE'));
    assert.equal(control.skippedEntries, 0);
    assert.equal(control.complete, true);
  });

  for (const row of rows) {
    withProject((cwd) => {
      const contract = prepare(cwd);
      row.plant(cwd);
      try {
        const report = analyzeProjectStructure(cwd, contract, { greenfield: true });
        // Still not a truncation, and deliberately so: `complete: false` is
        // terminal at settlement, and a run whose only sin is an unreadable
        // vendor link must not become an unexplained QA rejection after the
        // work is paid for.
        assert.equal(report.complete, true, row.label);
        assert.equal(report.truncationKind, undefined, row.label);
        // But the count is nonzero, which is what the verification contract
        // reads to raise the truncated-scan floor — so the run owes MORE
        // browser evidence for the code this report could not judge.
        assert.ok(report.skippedEntries >= 1, `${row.label} must be counted`);
        assert.equal(severityOf(report, 'STRUCT_SCAN_SKIPPED'), 'warning', row.label);
      } finally {
        row.restore?.(cwd);
      }
    });
  }
});

// A link into a build output the project DECLARED. The peer's measurement was
// exact and the cost is real: `apps/web/src/features/widgets ->
// apps/web/dist/widgets` sits inside a compiled source root, its own name is
// not excluded, and nothing else reads its target, so the walk records an
// unfollowed link and the run owes the truncated-scan floor for a directory of
// build output. Eight such links produce eight findings, and a reviewer reads
// eight of those as eight problems — the "it is only one bit" defence was wrong.
//
// The two narrowings previously considered were both rejected for good reason:
// re-admitting the SKIP_RE clause forgives a laundered source tree, and reading
// the target to see whether it looks derived is a guess the walk cannot make.
// This is the third option. The contract ANSWERS. A declaration is the run's own
// frozen input, hashed into `contractHash`, refused at compile time if it would
// swallow a source root, and it costs zero filesystem reads.
test('a link into a DECLARED build output is a no-loss; the same link undeclared is not', () => {
  const COLLAPSED = 'export function W(){ const a=1; const b=2; const c=3; return <div>'
    + '<span>{a}</span><span>{b}</span><span>{c}</span></div>; }\n';
  const plantLinks = (cwd: string, count: number): void => {
    for (let index = 0; index < count; index += 1) {
      fs.mkdirSync(path.join(cwd, `apps/web/dist/widgets${index}`), { recursive: true });
      fs.writeFileSync(path.join(cwd, `apps/web/dist/widgets${index}/W.tsx`), COLLAPSED);
      fs.symlinkSync(
        path.join(cwd, `apps/web/dist/widgets${index}`),
        path.join(cwd, `apps/web/src/features/widgets${index}`),
        'dir',
      );
    }
  };

  // Undeclared, one link: the disclosed cost, restated as a measurement.
  withProject((cwd) => {
    const contract = prepare(cwd);
    plantLinks(cwd, 1);
    const report = analyzeProjectStructure(cwd, contract, { greenfield: true });
    assert.equal(report.skippedEntries, 1);
    assert.equal(severityOf(report, 'STRUCT_SCAN_SKIPPED'), 'warning');
  });

  // Undeclared, eight links: eight findings, which is the correction.
  withProject((cwd) => {
    const contract = prepare(cwd);
    plantLinks(cwd, 8);
    const report = analyzeProjectStructure(cwd, contract, { greenfield: true });
    assert.equal(report.skippedEntries, 8);
    assert.equal(
      report.findings.filter((finding) => finding.id === 'STRUCT_SCAN_SKIPPED').length,
      8,
      'eight links are eight findings, not one bit',
    );
  });

  // Declared: free, on both counts, with no filesystem read of the target.
  withProject((cwd) => {
    const contract = prepare(cwd, { ...INPUT, buildOutputs: ['apps/web/dist'] });
    assert.deepEqual(contract.buildOutputs, ['apps/web/dist']);
    plantLinks(cwd, 8);
    const report = analyzeProjectStructure(cwd, contract, { greenfield: true });
    assert.equal(report.skippedEntries, 0, JSON.stringify(report.findings));
    assert.ok(!reportedIds(report).includes('STRUCT_SCAN_SKIPPED'));
    assert.equal(report.complete, true);
  });

  // A declaration that names a directory nothing resolves under forgives
  // nothing. The clause is about where the TARGET lands, not about the word.
  withProject((cwd) => {
    const contract = prepare(cwd, { ...INPUT, buildOutputs: ['apps/web/elsewhere'] });
    plantLinks(cwd, 1);
    const report = analyzeProjectStructure(cwd, contract, { greenfield: true });
    assert.equal(report.skippedEntries, 1);
  });
});

// The declaration's one abuse, refused where it is made rather than where it is
// read: `buildOutputs: ["apps/web/src"]` would tell the scan that this project's
// own compiled source is derived, and every link into it would go free.
test('a declared build output may not swallow a compiled source root or output', () => {
  withProject((cwd) => {
    for (const swallowing of ['apps/web/src', 'apps/web', 'apps/web/src/pages']) {
      assert.throws(
        () => prepare(cwd, { ...INPUT, buildOutputs: [swallowing] }),
        /declared build output .* contains compiled source or a compiled output/,
        swallowing,
      );
    }
    // And the shapes a path validator has to refuse before the compiler sees them.
    for (const malformed of ['/etc', '../escape', 'dist/*', '', '.']) {
      assert.throws(
        () => prepare(cwd, { ...INPUT, buildOutputs: [malformed] }),
        /buildOutputs\[0\] is invalid/,
        malformed,
      );
    }
  });
});
