// Parts 4+5 of the write-time enforcement redesign: deterministic auto-fix
// (collapse → the project's own formatter; missing referenced catalog keys →
// seeded from the in-change <Trans> fallback) and batched quality feedback
// (non-blocking findings accumulate per role in the run ledger and surface
// exactly once, consolidated, at the completion digest).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { planReadinessViolations } from '../plan-readiness';
import { collapsedProductSourceFile } from '../plan-readiness/checks';
import {
  appendQualityFindings,
  consolidateQualityFindings,
  readQualityFindings,
} from '../../../shared/state/quality-findings';

const names = (name: string): string => name;

const DEFAULT_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

function withProject(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-quality-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), 'plan', 'utf8');
    fn(dir);
  } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A stand-in for the project's own prettier binary. `clean` is what it
// produces — both `--write <file>` and stdin mode — regardless of input.
function installFakePrettier(dir: string, clean: string | null): void {
  const binDir = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const body = clean === null
    // Echo mode: a formatter that cannot fix the collapse.
    ? [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      'const args = process.argv.slice(2);',
      "const writeAt = args.indexOf('--write');",
      "if (writeAt < 0) process.stdout.write(fs.readFileSync(0, 'utf8'));",
      '',
    ]
    : [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `const clean = ${JSON.stringify(clean)};`,
      'const args = process.argv.slice(2);',
      "const writeAt = args.indexOf('--write');",
      'if (writeAt >= 0) fs.writeFileSync(args[writeAt + 1], clean);',
      'else process.stdout.write(clean);',
      '',
    ];
  fs.writeFileSync(path.join(binDir, 'prettier'), body.join('\n'), { mode: 0o755 });
}

const COLLAPSED_TSX =
  'export function Home(){const a=1;return <main><section><h1>Home</h1><p>Text</p></section><footer><span>Foot</span></footer></main>;}\n';

const CLEAN_TSX = [
  'export function Home() {',
  '  return <main>ok</main>;',
  '}',
  '',
].join('\n');

function hotWriteArgs(dir: string, content: string): Parameters<typeof planReadinessViolations>[0] {
  return {
    filePath: 'apps/web/src/pages/Home.tsx',
    content,
    projectRoot: dir,
    state: { ...DEFAULT_STATE, currentRunId: 'R' },
    writingFeatureSource: true,
    block: names,
  };
}

// A reachable formatter used to turn this deny into an allow. It could not: the
// gate has no channel to substitute the formatted text (`updatedToolInput` is
// Claude-only), so the ORIGINAL collapsed content landed on disk anyway, and the
// completion scan it deferred to is 3.5x looser. The verdict must not depend on
// install state either — the same bytes cannot be illegal before `npm install`
// and legal after.
test('write gate: collapsed source is denied whether or not a formatter is reachable', () => {
  withProject((dir) => {
    // Pre-install: no node_modules anywhere.
    assert.deepEqual(planReadinessViolations(hotWriteArgs(dir, COLLAPSED_TSX)), ['frontend-structure-hot-gate']);

    // Toolchain present AND able to format this exact content — still denied.
    installFakePrettier(dir, CLEAN_TSX);
    assert.deepEqual(planReadinessViolations(hotWriteArgs(dir, COLLAPSED_TSX)), ['frontend-structure-hot-gate']);
  });
});

test('write gate: a formatter that cannot fix the collapse keeps the deny', () => {
  withProject((dir) => {
    installFakePrettier(dir, null);
    const denied = planReadinessViolations(hotWriteArgs(dir, COLLAPSED_TSX));
    assert.deepEqual(denied, ['frontend-structure-hot-gate']);
  });
});

// Negative row: the gate must still allow well-formatted source, or "deny
// collapse" would just be "deny everything".
test('write gate: formatted multi-line source passes with the formatter reachable', () => {
  withProject((dir) => {
    installFakePrettier(dir, CLEAN_TSX);
    assert.deepEqual(planReadinessViolations(hotWriteArgs(dir, CLEAN_TSX)), []);
  });
});

test('write gate: demoted copy findings accumulate per role instead of interrupting, deduped across rewrites', () => {
  withProject((dir) => {
    const content = [
      'export function Home() {',
      '  return <main><h1>Welcome to the app</h1></main>;',
      '}',
      '',
    ].join('\n');
    assert.deepEqual(planReadinessViolations(hotWriteArgs(dir, content)), []);
    assert.deepEqual(planReadinessViolations(hotWriteArgs(dir, content)), []);
    const entries = readQualityFindings(dir, 'R')
      .filter((entry) => entry.id === 'STRUCT_HARDCODED_COPY');
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0]!.file, 'apps/web/src/pages/Home.tsx');
  });
});

test('write gate: a missing catalog key referenced by an in-change Trans fallback is seeded into every locale', () => {
  withProject((dir) => {
    const locales = path.join(dir, 'apps', 'web', 'src', 'i18n', 'locales');
    fs.mkdirSync(path.join(locales, 'en'), { recursive: true });
    fs.mkdirSync(path.join(locales, 'ro'), { recursive: true });
    fs.writeFileSync(path.join(locales, 'en', 'common.json'), JSON.stringify({ hello: 'Hello' }), 'utf8');
    fs.writeFileSync(path.join(locales, 'ro', 'common.json'), JSON.stringify({ hello: 'Salut' }), 'utf8');
    const content = [
      "import { Trans } from 'react-i18next';",
      'export function Home() {',
      '  return (',
      '    <main>',
      '      <h1>',
      '        <Trans ns="common" i18nKey="greeting">Hello there</Trans>',
      '      </h1>',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n');
    assert.deepEqual(planReadinessViolations(hotWriteArgs(dir, content)), []);
    const en = JSON.parse(fs.readFileSync(path.join(locales, 'en', 'common.json'), 'utf8')) as Record<string, string>;
    const ro = JSON.parse(fs.readFileSync(path.join(locales, 'ro', 'common.json'), 'utf8')) as Record<string, string>;
    assert.equal(en.greeting, 'Hello there');
    assert.equal(ro.greeting, 'TODO(en copy): Hello there');
    // Existing agent content is never overwritten.
    assert.equal(en.hello, 'Hello');
    assert.equal(ro.hello, 'Salut');
  });
});

// 13cl: catalog parity is a property of the locale PAIR, but it was enforced
// per single-file write — a role cannot write two files atomically, so every
// legitimate intermediate state cost a deny (~8 denies including a perfect
// oscillation on one key: "en has extra key" → the counterpart write denied →
// "en is missing key"). The cross-locale classes now accumulate as ledger
// warnings; the single-file classes (empty values here) still deny.
test('write gate: cross-locale catalog parity accumulates instead of denying; empty values still deny', () => {
  withProject((dir) => {
    const locales = path.join(dir, 'apps', 'web', 'src', 'i18n', 'locales');
    fs.mkdirSync(path.join(locales, 'en'), { recursive: true });
    fs.mkdirSync(path.join(locales, 'ro'), { recursive: true });
    fs.writeFileSync(path.join(locales, 'en', 'common.json'), JSON.stringify({ hello: 'Hello' }), 'utf8');
    fs.writeFileSync(path.join(locales, 'ro', 'common.json'), JSON.stringify({ hello: 'Salut' }), 'utf8');
    // The intermediate state: the en write adds a key ro does not carry yet.
    const args = {
      ...hotWriteArgs(dir, JSON.stringify({ hello: 'Hello', installLabel: 'Install the app' })),
      filePath: 'apps/web/src/i18n/locales/en/common.json',
    };
    assert.deepEqual(planReadinessViolations(args), []);
    const banked = readQualityFindings(dir, 'R').filter((entry) => entry.id === 'STRUCT_I18N_CATALOG');
    assert.equal(banked.length, 1, JSON.stringify(banked));
    assert.equal(banked[0]!.severity, 'warning');
    assert.match(banked[0]!.message, /installLabel/);

    // Single-file classes stay immediate denies: an empty source-locale value
    // needs no sibling file to judge.
    const denied = planReadinessViolations({
      ...args,
      content: JSON.stringify({ hello: '' }),
    });
    assert.deepEqual(denied, ['frontend-structure-hot-gate']);
  });
});

test('completion digest consolidates accumulated findings once and still denies while blocking findings remain', () => {
  withProject((dir) => {
    fs.mkdirSync(path.join(dir, 'apps/web/src'), { recursive: true });
    // Accumulate the same finding twice (two writes of the same file).
    const content = [
      'export function Home() {',
      '  return <main><h1>Welcome to the app</h1></main>;',
      '}',
      '',
    ].join('\n');
    planReadinessViolations(hotWriteArgs(dir, content));
    planReadinessViolations(hotWriteArgs(dir, content));

    // Blocking on disk: collapsed product source, no formatter reachable.
    const collapsedLine = `function App() { ${'const x = <div className="a">hi</div>; return <section>{x}</section>; '.repeat(12)} }`;
    fs.writeFileSync(path.join(dir, 'apps/web/src/App.tsx'), `${collapsedLine}\n`, 'utf8');

    const digestArgs = {
      filePath: '.traffic-one/digests/R/frontend.md',
      content: 'verdict: IMPLEMENTED\n',
      projectRoot: dir,
      state: { ...DEFAULT_STATE, currentRunId: 'R', onboardingComplete: true },
      writingFeatureSource: false,
      block: names,
    };
    const denied = planReadinessViolations(digestArgs);
    assert.ok(denied.includes('frontend-collapse-gate'), JSON.stringify(denied));

    // The consolidated document exists and carries the finding exactly once.
    const doc = fs.readFileSync(
      path.join(dir, '.traffic-one', 'fix-cycles', 'R', 'senior-frontend-quality-findings.md'),
      'utf8',
    );
    const occurrences = doc.split('STRUCT_HARDCODED_COPY').length - 1;
    assert.equal(occurrences, 1, doc);
    assert.match(doc, /Apply ALL findings below in this one turn/);

    // With the blocking file formatted away, the digest clears — the batched
    // findings change delivery, not the completion bar.
    fs.writeFileSync(path.join(dir, 'apps/web/src/App.tsx'), CLEAN_TSX, 'utf8');
    assert.deepEqual(planReadinessViolations(digestArgs), []);
  });
});

test('completion digest auto-formats collapsed product source when the project prettier is reachable', () => {
  withProject((dir) => {
    fs.mkdirSync(path.join(dir, 'apps/web/src'), { recursive: true });
    const collapsedLine = `function App() { ${'const x = <div className="a">hi</div>; return <section>{x}</section>; '.repeat(12)} }`;
    fs.writeFileSync(path.join(dir, 'apps/web/src/App.tsx'), `${collapsedLine}\n`, 'utf8');
    installFakePrettier(dir, CLEAN_TSX);
    const digestArgs = {
      filePath: '.traffic-one/digests/R/frontend.md',
      content: 'verdict: IMPLEMENTED\n',
      projectRoot: dir,
      state: { ...DEFAULT_STATE, onboardingComplete: true },
      writingFeatureSource: false,
      block: names,
    };
    assert.deepEqual(planReadinessViolations(digestArgs), []);
    assert.equal(fs.readFileSync(path.join(dir, 'apps/web/src/App.tsx'), 'utf8'), CLEAN_TSX);
  });
});

// The completion scan used to key on RAW >500 chars while the write gate masked
// and thresholded at 140. Everything in between was flagged at write time, waved
// through, and then invisible here — it shipped collapsed (15co: format:check red
// for a whole run). This line is ~200 code chars: inside the old blind band.
test('completion digest blocks source collapsed below the old 500-char bar', () => {
  withProject((dir) => {
    fs.mkdirSync(path.join(dir, 'apps/web/src'), { recursive: true });
    const line = `function App() { ${'const a = 1; const b = 2; const c = 3; '.repeat(5)}return null; }`;
    assert.ok(line.length > 140 && line.length < 500, `fixture must sit in the blind band, got ${line.length}`);
    fs.writeFileSync(path.join(dir, 'apps/web/src/App.tsx'), `${line}\n`, 'utf8');
    // No formatter reachable, so the repair cannot mask the finding.
    const denied = planReadinessViolations({
      filePath: '.traffic-one/digests/R/frontend.md',
      content: 'verdict: IMPLEMENTED\n',
      projectRoot: dir,
      state: { ...DEFAULT_STATE, onboardingComplete: true },
      writingFeatureSource: false,
      block: names,
    });
    assert.deepEqual(denied, ['frontend-collapse-gate']);
  });
});

// The completion scan repairs with `prettier --write`, so the bar it applies on a
// repo Traffic One did not scaffold has to be one ordinary code never meets. A
// single table row of five `<td>` cells formatted at printWidth 100 clears the
// 80-char JSX bar, and the gate's own formatter puts it straight back on every
// retry — a maintenance run dead-ended on somebody else's code. So the STRICT
// arm is greenfield-only; existing codebases keep the raw >500-char arm, which
// is what shipped before and which no ordinary line reaches. The write gate stays
// strict in both modes, so collapse this run PRODUCES is still refused.
test('the strict collapse bar does not dead-end an existing codebase', () => {
  withProject((dir) => {
    fs.mkdirSync(path.join(dir, 'apps/web/src'), { recursive: true });
    const row = '      <tr><td>{u.id}</td><td>{u.name}</td><td>{u.email}</td><td>{u.team}</td><td>{u.role}</td></tr>';
    assert.ok(row.length > 80 && row.length < 500, `fixture must clear the JSX bar, got ${row.length}`);
    fs.writeFileSync(path.join(dir, 'apps/web/src/Table.tsx'), `${row}\n`, 'utf8');
    const args = {
      filePath: '.traffic-one/digests/R/frontend.md',
      content: 'verdict: IMPLEMENTED\n',
      projectRoot: dir,
      writingFeatureSource: false,
      block: names,
    };
    assert.deepEqual(
      planReadinessViolations({ ...args, state: { ...DEFAULT_STATE, mode: 'existing-codebase', onboardingComplete: true } }),
      [],
      'a pre-existing wide line must never dead-end a maintenance run',
    );
    // Same bytes on greenfield, where Traffic One owns the structure: still denied.
    assert.deepEqual(
      planReadinessViolations({ ...args, state: { ...DEFAULT_STATE, onboardingComplete: true } }),
      ['frontend-collapse-gate'],
      'the greenfield backstop must survive the mode guard',
    );
  });
});

// The scan is whole-project, so unscoped it denied `senior-backend` for a
// collapsed `App.tsx` — a file the assignment allowlist forbids it to edit, i.e.
// a deny with no legal remedy. The owner's own scopes are the fix, and they are
// what makes the Go/Python arm meaningful rather than a second way to blame the
// wrong role.
test('the collapse scan only judges files the owning role owns, in its own language', () => {
  withProject((dir) => {
    fs.mkdirSync(path.join(dir, 'apps/web/src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'internal/api'), { recursive: true });
    const collapsedTsx = `function App() { ${'const a = 1; const b = 2; const c = 3; '.repeat(5)}return null; }`;
    fs.writeFileSync(path.join(dir, 'apps/web/src/App.tsx'), `${collapsedTsx}\n`, 'utf8');
    const state = { ...DEFAULT_STATE, currentRunId: 'R', onboardingComplete: true };
    const backendScope = [{ include: ['internal/**'] }];

    // Unscoped, the walk finds the frontend file — which is how the backend arm
    // came to deny `senior-backend` for source it cannot legally edit.
    assert.match(
      String(collapsedProductSourceFile(dir, state).file),
      /App\.tsx/,
      'the unscoped walk reaches every language, which is why scoping is required',
    );
    assert.equal(
      collapsedProductSourceFile(dir, state, backendScope).file,
      null,
      'the backend scope must not see frontend source',
    );

    // Negative row: collapsed Go inside the backend's OWN scope IS found. This is
    // the coverage the branch claimed and did not have — `.go` was absent from the
    // walker's extension set, so the whole backend arm scanned zero files. It
    // routes through the raw >500-char arm, never the JS/TS lexer.
    const collapsedGo = `func main() { ${'a := 1; b := 2; c := 3; _ = a; _ = b; _ = c; '.repeat(12)} }`;
    assert.ok(collapsedGo.length > 500, `Go fixture must clear the raw bar, got ${collapsedGo.length}`);
    fs.writeFileSync(path.join(dir, 'internal/api/handler.go'), `${collapsedGo}\n`, 'utf8');
    assert.match(
      String(collapsedProductSourceFile(dir, state, backendScope).file),
      /handler\.go/,
      'collapsed Go inside the backend scope must be found',
    );

    // And vendored dependencies are never walked: without the skip the Go and
    // Python arms would exhaust COLLAPSE_MAX_FILES and report a clean project as
    // STRUCT_SCAN_INCOMPLETE.
    fs.mkdirSync(path.join(dir, 'internal/vendor/dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'internal/vendor/dep/lib.go'), `${collapsedGo}\n`, 'utf8');
    fs.unlinkSync(path.join(dir, 'internal/api/handler.go'));
    assert.equal(
      collapsedProductSourceFile(dir, state, backendScope).file,
      null,
      'vendored source is not the project author\'s to format',
    );
  });
});

// The CSS arm keeps the raw-length detector: `lexicalMask` is a JS/TS lexer and
// produces nonsense on a stylesheet, and the shape is real (13co: a 424-char
// single-line `@theme` block no lexical gate could see).
test('completion digest still blocks a collapsed stylesheet through the raw-length arm', () => {
  withProject((dir) => {
    fs.mkdirSync(path.join(dir, 'apps/web/src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'apps/web/src/App.tsx'), CLEAN_TSX, 'utf8');
    fs.writeFileSync(
      path.join(dir, 'apps/web/src/globals.css'),
      `@theme { ${'--color-a: #fff; --color-b: #000; --color-c: #ccc; '.repeat(14)}}\n`,
      'utf8',
    );
    const denied = planReadinessViolations({
      filePath: '.traffic-one/digests/R/frontend.md',
      content: 'verdict: IMPLEMENTED\n',
      projectRoot: dir,
      state: { ...DEFAULT_STATE, onboardingComplete: true },
      writingFeatureSource: false,
      block: names,
    });
    assert.deepEqual(denied, ['frontend-collapse-gate']);
  });
});

test('quality ledger: append dedupes, read returns entries, consolidation filters by role', () => {
  withProject((dir) => {
    const finding = {
      id: 'STRUCT_ENTRYPOINT_COMPONENT',
      severity: 'warning' as const,
      file: 'apps/web/src/main.tsx',
      line: 4,
      message: 'Entrypoint declares UI component Home.',
    };
    appendQualityFindings(dir, 'R', 'senior-frontend', [finding]);
    appendQualityFindings(dir, 'R', 'senior-frontend', [{ ...finding, line: 9 }]);
    appendQualityFindings(dir, 'R', 'senior-backend', [{
      id: 'STRUCT_ROUTE_PATH_UNRESOLVED',
      severity: 'warning' as const,
      file: 'apps/web/src/App.tsx',
      message: 'route path not a literal',
    }]);
    assert.equal(readQualityFindings(dir, 'R').length, 2);
    const rel = consolidateQualityFindings(dir, 'R', 'senior-frontend');
    assert.equal(rel, '.traffic-one/fix-cycles/R/senior-frontend-quality-findings.md');
    const doc = fs.readFileSync(path.join(dir, rel!), 'utf8');
    assert.match(doc, /STRUCT_ENTRYPOINT_COMPONENT/);
    assert.ok(!doc.includes('STRUCT_ROUTE_PATH_UNRESOLVED'), 'another role\'s findings stay out');
    assert.equal(consolidateQualityFindings(dir, 'R', 'senior-tester'), null);
  });
});
