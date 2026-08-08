// src/shared/auth/__tests__/auth-source-census.test.ts
// The two clauses of the invariant written above authEnforced() in ../index.ts
// that no behavioural test can reach: "keep the reader count at one" and "never
// source the value from project state, a project dotfile Traffic One itself
// parses, or tool argv".
//
// The argv half is already pinned by behaviour (auth-enforced.test.ts asserts
// the doctor exemption anchors on `words[0] === 'node'`, so an
// `TRAFFIC_ONE_AUTH=0 node …` prefix buys nothing). The PROJECT-STATE half was
// not pinned by anything: making authEnforced() prefer a value read out of
// `.traffic-one/one.json` leaves the whole suite green, because every existing
// test hands the function an env and asks what it returns — which is exactly
// what a project-state reader would still answer correctly whenever no project
// state is present.
//
// So this file asks a question about the SOURCE instead. It is deliberately not
// "does authEnforced ignore a one.json I planted": that test has to guess the
// key the regression would read, and guesses the wrong one for free. The shape
// below cannot be evaded by choice of key — the predicate is allowed to see its
// own `env` argument and nothing else, so ANY new input, whether a file read, a
// state helper, a cached module global or an argv scan, arrives as an
// identifier the function did not declare and is named here.

import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const AUTH_SOURCE = path.join(REPO_ROOT, 'src', 'shared', 'auth', 'index.ts');
const ENV_VAR = 'TRAFFIC_ONE_AUTH';

function parse(abs: string): ts.SourceFile {
  return ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
}

function relOf(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

/** Every .ts under src/ and tests/, minus the trees no build ever reads. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '.tmp'].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(abs, out);
    else if (/\.[cm]?tsx?$/.test(entry.name)) out.push(abs);
  }
  return out;
}

// Tests and harnesses set this variable constantly — that is how they drive the
// two branches — so the census is about PRODUCTION source. compiled-smoke.ts is
// named explicitly rather than pattern-matched: it is the smoke harness, it
// spawns compiled hooks with `TRAFFIC_ONE_AUTH: 'on'` in their env, and it is
// the one harness that does not live under a test path.
const HARNESS_PATHS = ['src/test-support/', 'src/test-environment/'];
const HARNESS_FILES = ['src/build/compiled-smoke.ts'];

function isProduction(rel: string): boolean {
  if (rel.startsWith('tests/')) return false;
  if (/(^|\/)__tests__\//.test(rel) || /\.test\.[cm]?tsx?$/.test(rel)) return false;
  if (HARNESS_PATHS.some((prefix) => rel.startsWith(prefix))) return false;
  return !HARNESS_FILES.includes(rel);
}

interface Access { readonly at: string; readonly write: boolean }

function isAssignedTo(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isDeleteExpression(parent)) return true;
  return ts.isBinaryExpression(parent)
    && parent.left === node
    && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * Every access to `TRAFFIC_ONE_AUTH` in a file, by AST rather than by grep.
 *
 * grep answers a different question: it reports 117 lines in 33 files here,
 * because the name also appears in prose comments, in generated shell strings
 * and in documentation of the variable — none of which is a reader. The four
 * shapes below are the ones that actually touch the value.
 */
function accessesIn(sf: ts.SourceFile): Access[] {
  const found: Access[] = [];
  const at = (node: ts.Node) => `${relOf(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === ENV_VAR) {
      found.push({ at: at(node), write: isAssignedTo(node) });
    } else if (ts.isElementAccessExpression(node)
      && ts.isStringLiteralLike(node.argumentExpression)
      && node.argumentExpression.text === ENV_VAR) {
      found.push({ at: at(node), write: isAssignedTo(node) });
    } else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
      && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
      && node.name.text === ENV_VAR) {
      found.push({ at: at(node), write: true }); // an env object being composed
    } else if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === ENV_VAR) {
        found.push({ at: at(node), write: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

test('exactly one production site reads TRAFFIC_ONE_AUTH, and it is authEnforced', () => {
  const accesses = [...sourceFiles(path.join(REPO_ROOT, 'src')), ...sourceFiles(path.join(REPO_ROOT, 'tests'))]
    .filter((abs) => fs.readFileSync(abs, 'utf8').includes(ENV_VAR))
    .flatMap((abs) => accessesIn(parse(abs)));

  // Fixture guard: a census that stopped finding anything would pass forever.
  assert.ok(accesses.length > 50, `expected the variable to be exercised throughout the suite, found ${accesses.length}`);

  const production = accesses.filter((access) => isProduction(access.at.split(':')[0] as string));
  const reads = production.filter((access) => !access.write).map((access) => access.at);
  const writes = production.filter((access) => access.write).map((access) => access.at);

  // Named, not counted: "expected 1, got 2" sends the reader hunting for the
  // second one, and the whole value of this census is that it already knows.
  assert.deepEqual(
    reads.map((at) => at.split(':')[0]),
    ['src/shared/auth/index.ts'],
    `TRAFFIC_ONE_AUTH must be read in exactly one production place — authEnforced. Found: ${reads.join(', ')}`,
  );
  assert.deepEqual(writes, [],
    `production code must never SET the opt-out — that is a bypass with a different name. Found: ${writes.join(', ')}`);
});

/**
 * The identifiers a function uses but does not declare: its whole input surface
 * beyond its own arguments. Property NAMES are not identifiers here
 * (`env.TRAFFIC_ONE_AUTH` uses `env`, not `TRAFFIC_ONE_AUTH`), so the walk skips
 * the name side of a property access and of a property assignment.
 */
function freeIdentifiers(fn: ts.FunctionDeclaration, sf: ts.SourceFile): Map<string, string> {
  const declared = new Set<string>();
  const used = new Map<string, string>();
  const collectDeclared = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) declared.add(name.text);
    else for (const element of name.elements) {
      if (ts.isBindingElement(element)) collectDeclared(element.name);
    }
  };
  for (const parameter of fn.parameters) collectDeclared(parameter.name);

  const visit = (node: ts.Node): void => {
    // Type positions are erased at runtime and read nothing: `NodeJS.ProcessEnv`
    // is an annotation, not an input.
    if (ts.isTypeNode(node)) return;
    if (node === fn.name) return;
    if (ts.isVariableDeclaration(node)) collectDeclared(node.name);
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node)
        || (ts.isBindingElement(parent) && parent.propertyName === node)
        // Only the NAME side of a declaration binds; everything else about it is
        // a use. Testing `isVariableDeclaration(parent)` on its own also skipped
        // the INITIALIZER, so `const planted = PROJECT_AUTH_OVERRIDE;` consumed a
        // module-level project-state read invisibly — the exact defect this file
        // exists to name, one syntax away, measured green before this line was
        // narrowed. Same for a bare parameter default, which is why the
        // signature is walked at all.
        || (ts.isVariableDeclaration(parent) && parent.name === node)
        || (ts.isParameter(parent) && parent.name === node);
      if (!isPropertyName && !declared.has(node.text)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (!used.has(node.text)) used.set(node.text, `${relOf(sf.fileName)}:${line}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  // Signature included: a default like `env: NodeJS.ProcessEnv = process.env`
  // is an input too, and swapping it for one that reaches a file would be the
  // same defect written one line higher.
  ts.forEachChild(fn, visit);
  return used;
}

// The clause this closes: "never source the value from project state, a project
// dotfile Traffic One itself parses, or tool argv". authEnforced() decides
// whether the user's key is DEMANDED, and a project can already ship a host
// settings `env` block (see the comment above the function) — so a second,
// file-shaped way for a repository to switch the demand off is exactly the
// exposure that comment refuses. A predicate that can only see its own argument
// cannot acquire one.
test('authEnforced sees its env argument and nothing else', () => {
  const sf = parse(AUTH_SOURCE);
  const fn = sf.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'authEnforced',
  );
  assert.ok(fn, 'fixture guard: authEnforced must be a function declaration in src/shared/auth/index.ts');

  const free = freeIdentifiers(fn, sf);
  const offenders = [...free].filter(([name]) => !['process', 'AUTH_ENABLED'].includes(name));
  assert.deepEqual(
    offenders.map(([name, at]) => `${name} (${at})`),
    [],
    'authEnforced may read only its `env` argument, the compiled-in AUTH_ENABLED default and `process.env` as that '
    + "argument's default. Anything else is a new source for the opt-out — project state, a dotfile, argv, cached "
    + 'module state — and the invariant above the function forbids all of them.',
  );
  // The allowance is not a hole: AUTH_ENABLED is a compiled-in literal, not
  // something a project can write to. If it ever becomes a computed value the
  // exemption above would launder that computation's inputs.
  const config = fs.readFileSync(path.join(REPO_ROOT, 'src', 'config', 'auth.ts'), 'utf8');
  assert.match(config, /^export const AUTH_ENABLED = (?:true|false);$/m,
    'AUTH_ENABLED must stay a literal constant in src/config/auth.ts');
});

// The test above is only as good as the walk beneath it, and the walk's failure
// mode is SILENCE: a shape it cannot see makes the assertion pass. Nothing in
// the real source exercises these two shapes, so on the pristine tree a
// regression here is invisible in both directions — which is how the first
// version shipped skipping every bare initializer and every bare parameter
// default, letting a module-level `.traffic-one/one.json` read through green.
// Synthetic inputs are the only way to hold the instrument to its claim.
test('the free-identifier walk sees a bare initializer and a bare default, not just a call', () => {
  const cases: ReadonlyArray<{ readonly why: string; readonly src: string; readonly expect: string }> = [
    { why: 'a called helper', src: 'function f(env = process.env) { const v = readIt(); return v || env.X; }', expect: 'readIt' },
    { why: 'a bare initializer', src: 'function f(env = process.env) { const v = PLANTED; return v || env.X; }', expect: 'PLANTED' },
    { why: 'a bare parameter default', src: 'function f(env = PLANTED_ENV) { return env.X; }', expect: 'PLANTED_ENV' },
    { why: 'a destructured module value', src: 'function f(env = process.env) { const { a } = PLANTED_OBJ; return a || env.X; }', expect: 'PLANTED_OBJ' },
  ];

  for (const { why, src, expect } of cases) {
    const sf = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true);
    const fn = sf.statements.find(ts.isFunctionDeclaration);
    assert.ok(fn, `fixture: ${why} must parse to a function declaration`);
    assert.ok(
      freeIdentifiers(fn, sf).has(expect),
      `the walk must report ${expect} as a free identifier (${why}) — a shape it cannot see is a source the `
      + 'census cannot refuse',
    );
  }

  // The mirror bound: the walk must NOT report a function's own bindings, or it
  // fires on correct code and gets exempted into uselessness.
  const clean = ts.createSourceFile(
    'probe.ts',
    'function f(env = process.env) { const local = env.X; return local ? local.y : false; }',
    ts.ScriptTarget.Latest,
    true,
  );
  const cleanFn = clean.statements.find(ts.isFunctionDeclaration);
  assert.ok(cleanFn, 'fixture: the clean probe must parse');
  assert.deepEqual(
    [...freeIdentifiers(cleanFn, clean).keys()].filter((name) => name !== 'process'),
    [],
    'a function reading only its own argument and its own locals has no free identifiers besides `process`',
  );
});
