// Compiled integration wiring: the seeded App shell must import every
// feature/component (STRUCT_ORPHAN_MODULE) and register every route
// (STRUCT_ROUTE_MODULE_MISMATCH). OpenCode units will not add those
// cross-imports, so IMPLEMENTED restores them rather than looping the digest.
// Claude/Cursor/Codex must not call this — a hook rewrite of App.tsx is
// what Claude Code wraps in "user or linter; do not mention this".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  compileArchitecture,
  ensureScaffoldContent,
  type ArchitectureInputV1,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import {
  analyzeProjectStructure,
  repairCompiledIntegrationWiring,
} from '../react-structure';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-integration-wiring-'));
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
  ],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' },
    { id: 'home', name: 'Home', kind: 'page' },
    { id: 'course-card', name: 'CourseCard', kind: 'component' },
    { id: 'event-search-feature', name: 'Event Search Feature', kind: 'feature' },
  ],
};

function prepare(cwd: string): CompiledArchitectureV1 {
  for (const dir of [
    'apps/web/src/pages',
    'apps/web/src/components',
    'apps/web/src/features',
    'apps/web/src/lib',
  ]) fs.mkdirSync(path.join(cwd, dir), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    dependencies: { react: '19.0.0', vite: '7.0.0', 'react-router-dom': '7.0.0' },
  }));
  return compileArchitecture(cwd, 'R', STATE, INPUT);
}

function moduleOutput(contract: CompiledArchitectureV1, id: string): string {
  const module = contract.modules.find((entry) => entry.id === id);
  assert.ok(module, `module ${id} compiled`);
  return module!.output;
}

function wiringErrorIds(cwd: string, contract: CompiledArchitectureV1): string[] {
  return [...new Set(
    analyzeProjectStructure(cwd, contract, { greenfield: true }).findings
      .filter((finding) => (
        finding.severity === 'error'
        && (finding.id === 'STRUCT_ORPHAN_MODULE' || finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH')
      ))
      .map((finding) => `${finding.id}:${finding.file}`),
  )].sort();
}

test('a seeded skeleton with page + feature + component has no orphan or route mismatch', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    ensureScaffoldContent(cwd, contract.scaffoldOutputs || [], contract.profile, {
      compiled: contract,
      newProject: true,
    });
    assert.deepEqual(wiringErrorIds(cwd, contract), []);
  });
});

test('repair restores a shell that lost its router table and wires orphan modules', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    ensureScaffoldContent(cwd, contract.scaffoldOutputs || [], contract.profile, {
      compiled: contract,
      newProject: true,
    });
    const shell = moduleOutput(contract, 'app-shell');
    fs.writeFileSync(path.join(cwd, shell), [
      'export default function App() {',
      '  return <main>placeholder</main>;',
      '}',
      '',
    ].join('\n'));
    assert.ok(wiringErrorIds(cwd, contract).some((id) => id.startsWith('STRUCT_ROUTE_MODULE_MISMATCH:')));
    assert.ok(wiringErrorIds(cwd, contract).some((id) => id.startsWith('STRUCT_ORPHAN_MODULE:')));

    const written = repairCompiledIntegrationWiring(cwd, contract);
    assert.deepEqual(written, [shell]);
    const body = fs.readFileSync(path.join(cwd, shell), 'utf8');
    assert.match(body, /<Route path="\/" element=\{<Home \/>\} \/>/);
    assert.match(body, /import \* as EventSearchFeatureModule from '/);
    assert.match(body, /import \* as CourseCardModule from '/);
    assert.deepEqual(wiringErrorIds(cwd, contract), []);
  });
});

test('repair injects orphan imports into a shell that already proves its routes', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    ensureScaffoldContent(cwd, contract.scaffoldOutputs || [], contract.profile, {
      compiled: contract,
      newProject: true,
    });
    const shell = moduleOutput(contract, 'app-shell');
    const home = moduleOutput(contract, 'home');
    const homeStem = `./${path.posix.relative(path.posix.dirname(shell), home).replace(/\.tsx?$/, '')}`;
    fs.writeFileSync(path.join(cwd, shell), [
      "import { Route, Routes } from 'react-router-dom';",
      `import Home from '${homeStem}';`,
      '// KEEP',
      'export default function App() {',
      '  return (',
      '    <Routes>',
      '      <Route path="/" element={<Home />} />',
      '    </Routes>',
      '  );',
      '}',
      '',
    ].join('\n'));
    assert.ok(wiringErrorIds(cwd, contract).some((id) => id.startsWith('STRUCT_ORPHAN_MODULE:')));
    assert.ok(!wiringErrorIds(cwd, contract).some((id) => id.startsWith('STRUCT_ROUTE_MODULE_MISMATCH:')));

    const written = repairCompiledIntegrationWiring(cwd, contract);
    assert.deepEqual(written, [shell]);
    const body = fs.readFileSync(path.join(cwd, shell), 'utf8');
    assert.match(body, /\/\/ KEEP/);
    assert.match(body, /<Route path="\/" element=\{<Home \/>\} \/>/);
    assert.match(body, /import \* as EventSearchFeatureModule from '/);
    assert.match(body, /import \* as CourseCardModule from '/);
    assert.deepEqual(wiringErrorIds(cwd, contract), []);
  });
});

test('repair does not overwrite a shell that already proves routes and has no orphans', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    ensureScaffoldContent(cwd, contract.scaffoldOutputs || [], contract.profile, {
      compiled: contract,
      newProject: true,
    });
    const shell = moduleOutput(contract, 'app-shell');
    const before = fs.readFileSync(path.join(cwd, shell), 'utf8');
    assert.deepEqual(wiringErrorIds(cwd, contract), []);
    assert.deepEqual(repairCompiledIntegrationWiring(cwd, contract), []);
    assert.equal(fs.readFileSync(path.join(cwd, shell), 'utf8'), before);
  });
});

test('a component compiled under packages/ui is imported by workspace name, not a deep relative', () => {
  withProject((cwd) => {
    for (const rel of [
      'apps/web/src',
      'packages/ui/src',
      'packages/tailwind-config/src',
    ]) fs.mkdirSync(path.join(cwd, rel), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      private: true,
      workspaces: ['apps/*', 'packages/*'],
      dependencies: { react: '19.0.0', vite: '7.0.0', 'react-router-dom': '7.0.0' },
    }));
    fs.writeFileSync(path.join(cwd, 'apps/web/package.json'), '{"name":"web","private":true}');
    fs.writeFileSync(path.join(cwd, 'packages/ui/package.json'), '{"name":"@app/ui","private":true}');
    fs.writeFileSync(path.join(cwd, 'packages/ui/src/index.ts'), '');
    fs.writeFileSync(path.join(cwd, 'packages/tailwind-config/package.json'), '{"name":"@app/tailwind-config","private":true}');
    fs.writeFileSync(path.join(cwd, 'packages/tailwind-config/src/globals.css'), '@import "tailwindcss";\n');
    const contract = compileArchitecture(cwd, 'R', STATE, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [
        { id: 'app-shell', name: 'App', kind: 'app-shell' },
        { id: 'home', name: 'Home', kind: 'page' },
        { id: 'ticket-status-badge', name: 'Ticket Status Badge', kind: 'component' },
      ],
    });
    const badge = moduleOutput(contract, 'ticket-status-badge');
    assert.match(badge, /^packages\/ui\//);
    ensureScaffoldContent(cwd, contract.scaffoldOutputs || [], contract.profile, {
      compiled: contract,
      newProject: true,
    });
    const shellBody = fs.readFileSync(path.join(cwd, moduleOutput(contract, 'app-shell')), 'utf8');
    assert.doesNotMatch(shellBody, /\.\.\/\.\.\/\.\.\/packages\//);
    assert.match(shellBody, /from '@app\/ui\//);
    assert.deepEqual(wiringErrorIds(cwd, contract), []);
  });
});
