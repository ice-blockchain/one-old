// Integration findings (1.0.37, 8co): a planned module that exists but is
// wired to nothing, a planned API package no UI imports, and Tailwind
// utilities without a Tailwind toolchain are delivery defects — green
// build/typecheck must not hide them. Calibration: every negative case here
// mirrors a green-run shape and must stay finding-free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  compileArchitecture,
  type ArchitectureInputV1,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import {
  analyzeProjectStructure,
} from '../react-structure';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-integration-'));
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
  ],
};

function prepare(cwd: string, input: ArchitectureInputV1 = INPUT): CompiledArchitectureV1 {
  for (const dir of [
    'apps/web/src/pages',
    'apps/web/src/components',
    'apps/web/src/features',
    'apps/web/src/lib',
  ]) fs.mkdirSync(path.join(cwd, dir), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    dependencies: { react: '19.0.0', vite: '7.0.0', 'react-router-dom': '7.0.0' },
  }));
  return compileArchitecture(cwd, 'R', STATE, input);
}

function moduleOutput(contract: CompiledArchitectureV1, id: string): string {
  const module = contract.modules.find((entry) => entry.id === id);
  assert.ok(module, `module ${id} compiled`);
  return module!.output;
}

function writeAppShell(cwd: string, contract: CompiledArchitectureV1, extraImport = ''): void {
  const home = moduleOutput(contract, 'home');
  const homeStem = `./${path.posix.relative('apps/web/src', home).replace(/\.tsx?$/, '')}`;
  const shell = contract.modules.find((entry) => entry.kind === 'app-shell')!;
  fs.mkdirSync(path.dirname(path.join(cwd, shell.output)), { recursive: true });
  fs.writeFileSync(path.join(cwd, shell.output), [
    "import { Route, Routes } from 'react-router-dom'",
    `import Home from '${homeStem}'`,
    extraImport,
    'export default function App() {',
    '  return (',
    '    <Routes>',
    '      <Route path="/" element={<Home />} />',
    '    </Routes>',
    '  )',
    '}',
    '',
  ].filter(Boolean).join('\n'));
}

function writeHome(cwd: string, contract: CompiledArchitectureV1, body: string): void {
  const home = moduleOutput(contract, 'home');
  fs.mkdirSync(path.dirname(path.join(cwd, home)), { recursive: true });
  fs.writeFileSync(path.join(cwd, home), body);
}

function writeCourseCard(cwd: string, contract: CompiledArchitectureV1, body?: string): void {
  const card = moduleOutput(contract, 'course-card');
  fs.mkdirSync(path.dirname(path.join(cwd, card)), { recursive: true });
  fs.writeFileSync(path.join(cwd, card), body ?? [
    'export function CourseCard() {',
    '  return (',
    '    <article className="card">',
    '      <h2>Course</h2>',
    '    </article>',
    '  )',
    '}',
    '',
  ].join('\n'));
}

function errorIds(cwd: string, contract: CompiledArchitectureV1): string[] {
  return [...new Set(
    analyzeProjectStructure(cwd, contract, { greenfield: true }).findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => finding.id),
  )].sort();
}

test('a planned component with zero call sites is an orphan (8co CourseCard shape)', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    writeAppShell(cwd, contract);
    writeHome(cwd, contract, [
      'export default function Home() {',
      '  return (',
      '    <main>',
      '      <h1>Home</h1>',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n'));
    writeCourseCard(cwd, contract);
    assert.ok(errorIds(cwd, contract).includes('STRUCT_ORPHAN_MODULE'));
  });
});

test('a component imported by a page is not an orphan', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    writeAppShell(cwd, contract);
    const card = moduleOutput(contract, 'course-card');
    const home = moduleOutput(contract, 'home');
    const relImport = `./${path.posix.relative(path.posix.dirname(home), card).replace(/\.tsx?$/, '')}`;
    writeHome(cwd, contract, [
      `import { CourseCard } from '${relImport}'`,
      'export default function Home() {',
      '  return (',
      '    <main>',
      '      <CourseCard />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n'));
    writeCourseCard(cwd, contract);
    assert.ok(!errorIds(cwd, contract).includes('STRUCT_ORPHAN_MODULE'));
  });
});

test('a component reached only through a barrel re-export is not an orphan', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    writeAppShell(cwd, contract);
    const card = moduleOutput(contract, 'course-card');
    const cardDir = path.posix.dirname(card);
    const cardName = path.posix.basename(card).replace(/\.tsx?$/, '');
    fs.mkdirSync(path.join(cwd, cardDir), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, cardDir, 'index.ts'),
      `export { CourseCard } from './${cardName}'\n`,
    );
    const home = moduleOutput(contract, 'home');
    const relBarrel = `./${path.posix.relative(path.posix.dirname(home), cardDir)}`;
    writeHome(cwd, contract, [
      `import { CourseCard } from '${relBarrel}'`,
      'export default function Home() {',
      '  return (',
      '    <main>',
      '      <CourseCard />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n'));
    writeCourseCard(cwd, contract);
    assert.ok(!errorIds(cwd, contract).includes('STRUCT_ORPHAN_MODULE'));
  });
});

test('a planned API package no source imports is flagged; importing it clears the finding', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    fs.mkdirSync(path.join(cwd, 'packages/api-client/src'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'packages/api-client/package.json'),
      JSON.stringify({ name: '@test/api-client' }),
    );
    contract.allowedOutputs.push('packages/api-client/src/index.ts');
    writeAppShell(cwd, contract);
    const cardImport = (() => {
      const card = moduleOutput(contract, 'course-card');
      const home = moduleOutput(contract, 'home');
      return `./${path.posix.relative(path.posix.dirname(home), card).replace(/\.tsx?$/, '')}`;
    })();
    writeHome(cwd, contract, [
      `import { CourseCard } from '${cardImport}'`,
      'export default function Home() {',
      '  return (',
      '    <main>',
      '      <CourseCard />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n'));
    writeCourseCard(cwd, contract);
    assert.ok(errorIds(cwd, contract).includes('STRUCT_API_CLIENT_UNUSED'));

    // Wire the package: the finding must clear.
    writeHome(cwd, contract, [
      `import { listCourses } from '@test/api-client'`,
      `import { CourseCard } from '${cardImport}'`,
      'export default function Home() {',
      '  void listCourses',
      '  return (',
      '    <main>',
      '      <CourseCard />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n'));
    assert.ok(!errorIds(cwd, contract).includes('STRUCT_API_CLIENT_UNUSED'));
  });
});

test('tailwind utilities without a toolchain are flagged; a tailwindcss dep clears it', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    writeAppShell(cwd, contract);
    const card = moduleOutput(contract, 'course-card');
    const home = moduleOutput(contract, 'home');
    const relImport = `./${path.posix.relative(path.posix.dirname(home), card).replace(/\.tsx?$/, '')}`;
    writeHome(cwd, contract, [
      `import { CourseCard } from '${relImport}'`,
      'export default function Home() {',
      '  return (',
      '    <main>',
      '      <CourseCard />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n'));
    writeCourseCard(cwd, contract, [
      'export function CourseCard() {',
      '  return (',
      '    <article className="flex flex-col gap-3 rounded-xl bg-white p-6 text-slate-700">',
      '      <h2 className="text-lg font-semibold">Course</h2>',
      '    </article>',
      '  )',
      '}',
      '',
    ].join('\n'));
    assert.ok(errorIds(cwd, contract).includes('STRUCT_TAILWIND_NO_TOOLCHAIN'));

    // Declaring tailwindcss makes the same markup legitimate.
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0', 'react-router-dom': '7.0.0' },
      devDependencies: { tailwindcss: '4.0.0' },
    }));
    assert.ok(!errorIds(cwd, contract).includes('STRUCT_TAILWIND_NO_TOOLCHAIN'));
  });
});

test('plain hand-written class names never trip the tailwind gate', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    writeAppShell(cwd, contract);
    const card = moduleOutput(contract, 'course-card');
    const home = moduleOutput(contract, 'home');
    const relImport = `./${path.posix.relative(path.posix.dirname(home), card).replace(/\.tsx?$/, '')}`;
    writeHome(cwd, contract, [
      `import { CourseCard } from '${relImport}'`,
      'export default function Home() {',
      '  return (',
      '    <main className="page page-home">',
      '      <CourseCard />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n'));
    writeCourseCard(cwd, contract, [
      'export function CourseCard() {',
      '  return (',
      '    <article className="card card-elevated hero-actions">',
      '      <h2 className="card-title">Course</h2>',
      '    </article>',
      '  )',
      '}',
      '',
    ].join('\n'));
    assert.ok(!errorIds(cwd, contract).includes('STRUCT_TAILWIND_NO_TOOLCHAIN'));
  });
});

test('hardcoded copy blocks new UI and only advises changed legacy UI with an i18n runtime', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    writeAppShell(cwd, contract);
    const card = moduleOutput(contract, 'course-card');
    const home = moduleOutput(contract, 'home');
    const relImport = `./${path.posix.relative(path.posix.dirname(home), card).replace(/\.tsx?$/, '')}`;
    const copyHeavy = [
      `import { CourseCard } from '${relImport}'`,
      'export default function Home() {',
      '  return (',
      '    <main>',
      '      <h1>Welcome to the learning platform</h1>',
      '      <p>Start your journey with curated courses</p>',
      '      <p>Track your progress across every lesson</p>',
      '      <p>Sign in to save your learning progress</p>',
      '      <p>Explore the full course catalog today</p>',
      '      <CourseCard />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n');
    writeHome(cwd, contract, copyHeavy);
    writeCourseCard(cwd, contract);

    const greenfield = analyzeProjectStructure(cwd, contract, { greenfield: true }).findings
      .filter((finding) => finding.id === 'STRUCT_HARDCODED_COPY');
    assert.ok(greenfield.length >= 5);
    assert.ok(greenfield.every((finding) => finding.severity === 'error'));

    // Existing project with no i18n evidence: no forced migration.
    const existingContract = { ...contract, i18n: undefined };
    const withoutI18n = analyzeProjectStructure(cwd, existingContract).findings
      .filter((finding) => finding.id === 'STRUCT_HARDCODED_COPY');
    assert.equal(withoutI18n.length, 0);

    // Existing localized project: untouched backlog remains advisory.
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: {
        react: '19.0.0', vite: '7.0.0', 'react-router-dom': '7.0.0', 'react-i18next': '15.0.0',
      },
    }));
    const withI18n = analyzeProjectStructure(cwd, existingContract).findings
      .filter((finding) => finding.id === 'STRUCT_HARDCODED_COPY');
    assert.ok(withI18n.length > 0);
    assert.ok(withI18n.every((finding) => finding.severity === 'warning'));
  });
});

test('integration findings block on a new project and only advise on an existing codebase', () => {
  withProject((cwd) => {
    const contract = prepare(cwd);
    writeAppShell(cwd, contract);
    writeHome(cwd, contract, 'export default function Home() {\n  return <main>Home</main>;\n}\n');
    writeCourseCard(cwd, contract);

    // The regression this guards: `greenfield` was added as a parameter and left
    // unwired at both production call sites, so it defaulted to false and these
    // three findings were advisory EVERYWHERE — including projects Traffic One
    // scaffolded itself and therefore owns.
    const greenfield = analyzeProjectStructure(cwd, contract, { greenfield: true }).findings
      .filter((finding) => finding.id === 'STRUCT_ORPHAN_MODULE');
    assert.equal(greenfield.length, 1);
    assert.equal(greenfield[0]!.severity, 'error', 'a scaffolded project blocks');

    const existing = analyzeProjectStructure(cwd, contract).findings
      .filter((finding) => finding.id === 'STRUCT_ORPHAN_MODULE');
    assert.equal(existing.length, 1);
    assert.equal(existing[0]!.severity, 'warning', 'a pre-existing repo is only advised');
  });
});
