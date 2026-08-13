// tests/deny-id-completeness.test.ts
// Structural contract test (see agent-type-safety-contract.test.ts for the
// idiom): every call to the core `deny()` function in production source must
// declare a `denyId`. Without this gate, the 190+ hand-edited call sites in
// src/config/deny-ids.ts regress silently the moment call site #191 is added
// without one — the pipeline would still run (a missing `denyId` only ever
// produces an anonymous `unattributed-handler:<gateId>` fallback, see
// core/pipeline.ts), so nothing else in the suite would ever fail.
//
// ── Why this is a real parse and not a hand-rolled lexer ────────────────────
// It used to be one: a character walk that skipped strings/comments/templates
// to find `deny(`, plus a text filter that only scanned a file whose import
// specifier ended in `core/result`. Both halves were silently blind, and one
// was blind to a LIVE call site:
//   - A REGEX LITERAL containing a quote desynchronized the walk.
//     spawn-hygiene.ts holds `/[^\s'"`<>)]*.../g`; the `'` inside that
//     character class opened a phantom string that ran to the apostrophe in
//     "Copilot's" 40 lines later and swallowed the real deny( in between.
//     That file's yield was 0. Nothing noticed, because the only scanner
//     self-check was a global "> 80 sites" floor.
//   - The specifier filter required `.../core/result`, so core/pipeline.ts
//     (`import { deny } from './result'`) was out of scope — the ONE file that
//     mints the `unattributed-handler:` fallback was the one file the gate
//     could not see.
//   - Every indirect binding shape was invisible too: a re-export wrapper, a
//     namespace import (`result.deny(...)`), `require`/`await import`
//     destructuring, a barrel. Worst of all was `import { deny as refuse }`:
//     the file WAS scanned, so the file-count and site-count guards stayed
//     green while its call sites vanished.
// ts.createSourceFile removes all six classes at once: strings, templates,
// comments, and regex literals are the parser's problem, and "is this callee
// core's deny?" becomes a binding question instead of a text question.
//
// ── What counts as core's deny ───────────────────────────────────────────────
// A binding is core's `deny` when it resolves, through any number of
// re-exports/barrels, to the `deny` exported by src/core/result.ts. That is
// followed with a small module walk (exportsCoreDeny below) rather than a full
// type checker: no ts.Program, no whole-repo type resolution, and the answer
// is exact for every specifier shape this repo can write (all in-repo callers
// use relative specifiers). It also keeps the three documented false-positive
// classes falling out structurally, by definition rather than by name:
//   - src/core/result.ts DEFINES `deny` and imports nothing — no bindings, so
//     never a site.
//   - src/build/compiled-smoke.ts embeds `deny(...)` inside STRING LITERALS of
//     generated fs-shim source — the parser sees a string, not a call.
//   - src/modules/plan-guard/plan-runteam.ts declares its OWN local `const
//     deny = (reason: string) => ...` string helper and never imports core's —
//     no binding, no sites.
// A future file of any of those shapes is excluded the same way, without
// editing this file; a future REAL call site is caught the same way.
//
// ── The denyId check ─────────────────────────────────────────────────────────
// Read off the argument NODE, not the argument text: `/\bdenyId\b/` on source
// text also matches the word inside a comment or a nested string, which would
// let a site pass while declaring nothing. A site declares an id when its
// second argument is an object literal carrying `denyId` — and, for the one
// call that picks its id per branch (model-rotation.ts's conditional meta),
// when EVERY branch does. Anything else (no second argument, a variable, a
// call) is reported: the id has to be declared at the call site, since that is
// the only place that knows which cause fired.
// This test does not re-verify that a declared id is spelled correctly —
// `ResultMeta.denyId: DenyId` (core/types.ts) makes a typo a compile-time
// error already, and it no longer accepts the pipeline's `FallbackDenyId`
// shape either. This test exists for the ONE thing TypeScript cannot see: a
// call site that never set the field at all.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import * as ts from 'typescript';
import {
  DENY_IDS,
  NEVER_ESCALATED_DENY_IDS,
  NEVER_OVERRIDABLE_DENY_IDS,
} from '../src/config/deny-ids';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
// The single module that DEFINES `deny`. Everything else either imports it
// (directly or through re-exports) or is out of scope.
const DENY_ORIGIN = path.join(SRC_ROOT, 'core', 'result.ts');
const DENY_EXPORT = 'deny';

// The file set the scanner reads. The fixture tests below overlay synthetic
// files on the real tree, so a fixture still resolves the REAL
// src/core/result.ts and proves the resolver reaches it.
interface SourceTree {
  read(absPath: string): string | null;
}

function sourceTree(overrides: Readonly<Record<string, string>> = {}): SourceTree {
  const cache = new Map<string, string | null>();
  return {
    read(absPath: string): string | null {
      const override = overrides[absPath];
      if (override !== undefined) return override;
      if (!cache.has(absPath)) {
        let text: string | null = null;
        try {
          text = fs.statSync(absPath).isFile() ? fs.readFileSync(absPath, 'utf8') : null;
        } catch {
          text = null; // does not exist / not readable — an unresolvable specifier
        }
        cache.set(absPath, text);
      }
      return cache.get(absPath) ?? null;
    },
  };
}

function parseSource(file: string, text: string): ts.SourceFile {
  // setParentNodes: true so node.getText()/getStart() work on the walked tree.
  // .tsx needs ScriptKind.TSX or every JSX element is a parse error and the
  // statements after it are lost — which is how a whole file could hold
  // unattributed deny() calls and yield nothing.
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

// Resolve a relative import specifier to a file the tree can read. Only
// relative specifiers can name core/result, so a bare package specifier ends
// the walk immediately. Handles the `./x` → `./x.ts`, `./x.js` → `./x.ts`
// (ESM-style suffix), and `./dir` → `./dir/index.ts` (barrel) spellings.
function resolveSpecifier(tree: SourceTree, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.endsWith('.ts') || base.endsWith('.tsx') ? base : `${base}.ts`,
    `${base}.tsx`,
    base.replace(/\.jsx?$/, '.ts'),
    base.replace(/\.jsx?$/, '.tsx'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (tree.read(candidate) !== null) return candidate;
  }
  return null;
}

function moduleSpecifierText(node: { moduleSpecifier?: ts.Expression }): string | null {
  const specifier = node.moduleSpecifier;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : null;
}

// Does `file` export `exportName`, and is that export (transitively) the
// origin's `deny`? Covers `export { deny } from '...'`, `export { deny as x }
// from '...'`, `export * from '...'`, and a bare `export { deny }` re-exporting
// an imported binding. A LOCAL declaration of the same name is deliberately
// not followed — that is plan-runteam.ts's string helper, not core's deny.
function exportsCoreDeny(
  tree: SourceTree,
  file: string,
  exportName: string,
  seen: Set<string> = new Set(),
): boolean {
  if (file === DENY_ORIGIN) return exportName === DENY_EXPORT;
  const key = `${file}#${exportName}`;
  if (seen.has(key)) return false; // import cycle — stop rather than recurse forever
  seen.add(key);
  const text = tree.read(file);
  if (text === null) return false;
  const source = parseSource(file, text);

  // Local name → (module, original name), so a bare `export { deny }` can be
  // followed back to whatever the file imported under that name.
  const importedFrom = new Map<string, { file: string; name: string }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = moduleSpecifierText(statement);
    const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
    const bindings = statement.importClause?.namedBindings;
    if (!target || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      importedFrom.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
    }
  }

  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const specifier = moduleSpecifierText(statement);
    const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
    if (!statement.exportClause) { // `export * from '...'` — a barrel
      if (target && exportsCoreDeny(tree, target, exportName, seen)) return true;
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== exportName) continue;
      const original = (element.propertyName ?? element.name).text;
      if (target) {
        if (exportsCoreDeny(tree, target, original, seen)) return true;
        continue;
      }
      const local = importedFrom.get(original);
      if (local && exportsCoreDeny(tree, local.file, local.name, seen)) return true;
    }
  }
  return false;
}

// Does `file` export `exportName` as a NAMESPACE whose `.deny` is core's deny?
// That is `export * as res from '.../result'` — which creates no local binding
// in the exporting file, so it is only ever reachable through an importer
// (`import { res } from './barrel'; res.deny(...)`). Followed through `export *`
// barrels the same way exportsCoreDeny follows named exports.
function exportsCoreDenyNamespace(
  tree: SourceTree,
  file: string,
  exportName: string,
  seen: Set<string> = new Set(),
): boolean {
  const key = `${file}#*#${exportName}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const text = tree.read(file);
  if (text === null) return false;
  for (const statement of parseSource(file, text).statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const specifier = moduleSpecifierText(statement);
    const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
    if (!target) continue;
    const clause = statement.exportClause;
    if (clause && ts.isNamespaceExport(clause)) {
      if (clause.name.text === exportName && exportsCoreDeny(tree, target, DENY_EXPORT)) return true;
      continue;
    }
    if (!clause && exportsCoreDenyNamespace(tree, target, exportName, seen)) return true;
  }
  return false;
}

interface DenyBindings {
  // Local identifiers that ARE core's deny (`deny`, an alias like `refuse`, or
  // anything later initialized from one of them).
  readonly direct: ReadonlySet<string>;
  // Local identifiers whose `.deny` member is core's deny (namespace import, a
  // `const result = require(...)`, a `export * as res` re-export, or a local
  // object literal carrying the binding: `const fns = { deny }`).
  readonly namespaces: ReadonlySet<string>;
}

// Strip the wrappers that change nothing about which value an expression is.
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)
      || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    // `(0, deny)` — the comma operator's value is its LAST operand. A minifier
    // and a hand-written "call without a receiver" both produce this.
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = current.right;
      continue;
    }
    return current;
  }
}

// Is this expression core's deny, given what is bound so far? Covers the bare
// identifier, a namespace member (`result.deny`, `result['deny']`) and any
// wrapper unwrapExpression removes.
function isDenyExpression(node: ts.Expression, direct: ReadonlySet<string>, namespaces: ReadonlySet<string>): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) return direct.has(expression.text);
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === DENY_EXPORT
      && ts.isIdentifier(expression.expression)
      && namespaces.has(expression.expression.text);
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    return Boolean(argument)
      && ts.isStringLiteralLike(argument)
      && argument.text === DENY_EXPORT
      && ts.isIdentifier(expression.expression)
      && namespaces.has(expression.expression.text);
  }
  return false;
}

// `require('...')` / `import('...')` / `await import('...')` → its specifier.
function requireLikeSpecifier(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  const expression = ts.isAwaitExpression(node) ? node.expression : node;
  if (!ts.isCallExpression(expression)) return null;
  const isRequire = ts.isIdentifier(expression.expression) && expression.expression.text === 'require';
  const isDynamicImport = expression.expression.kind === ts.SyntaxKind.ImportKeyword;
  if (!isRequire && !isDynamicImport) return null;
  const argument = expression.arguments[0];
  return argument && ts.isStringLiteral(argument) ? argument.text : null;
}

function denyBindings(tree: SourceTree, file: string, source: ts.SourceFile): DenyBindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  const providesCoreDeny = (specifier: string | null): boolean => {
    const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
    return target !== null && exportsCoreDeny(tree, target, DENY_EXPORT);
  };

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    const specifier = moduleSpecifierText(statement);
    if (ts.isNamespaceImport(bindings)) {
      if (providesCoreDeny(specifier)) namespaces.add(bindings.name.text);
      continue;
    }
    const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
    for (const element of bindings.elements) {
      const original = (element.propertyName ?? element.name).text;
      // `{ deny }` → propertyName undefined, name 'deny';
      // `{ deny as refuse }` → propertyName 'deny', name 'refuse'.
      if (original === DENY_EXPORT && providesCoreDeny(specifier)) {
        direct.add(element.name.text);
        continue;
      }
      // `import { res } from './barrel'` where the barrel does
      // `export * as res from '.../core/result'` — `res` is a namespace, so
      // `res.deny(...)` is a call site under ANY export name, not just `deny`.
      if (target && exportsCoreDenyNamespace(tree, target, original)) namespaces.add(element.name.text);
    }
  }

  // require/dynamic-import destructuring can appear anywhere, including inside
  // a function body (`const { deny } = await import(...)`), so this half walks
  // the whole tree rather than the top-level statement list.
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const specifier = requireLikeSpecifier(node.initializer);
      if (specifier && providesCoreDeny(specifier)) {
        if (ts.isIdentifier(node.name)) {
          namespaces.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const original = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : (ts.isIdentifier(element.name) ? element.name.text : '');
            if (original === DENY_EXPORT && ts.isIdentifier(element.name)) direct.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  propagateLocalRebindings(source, direct, namespaces);
  return { direct, namespaces };
}

// The half the scanner was missing entirely: how deny is IMPORTED was resolved,
// how it is BOUND locally afterwards was not. `const refuse = deny;` is what an
// ordinary extract-a-helper refactor produces, and it made every call site in
// the file vanish while the file itself stayed "scanned" — so no file-level or
// count-level guard moved.
//
// Run to a fixpoint because a rebinding can chain (`const a = deny; const b =
// a;`) and can be declared after its use in source order; the loop is bounded
// by the number of identifiers in the file, and terminates as soon as a pass
// adds nothing.
function propagateLocalRebindings(source: ts.SourceFile, direct: Set<string>, namespaces: Set<string>): void {
  const bindName = (name: ts.BindingName, initializer: ts.Expression | undefined): void => {
    if (!initializer || !ts.isIdentifier(name)) return;
    const value = unwrapExpression(initializer);
    if (isDenyExpression(value, direct, namespaces)) {
      direct.add(name.text);
      return;
    }
    // `const fns = { deny }` / `const fns = { deny: refuse }` — an object
    // literal carrying the binding is a namespace for the purposes of
    // `fns.deny(...)`.
    if (ts.isObjectLiteralExpression(value) && value.properties.some((property) => {
      const key = property.name;
      const named = key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === DENY_EXPORT;
      if (ts.isShorthandPropertyAssignment(property)) return named && direct.has(property.name.text);
      if (ts.isPropertyAssignment(property)) return named && isDenyExpression(property.initializer, direct, namespaces);
      return false;
    })) {
      namespaces.add(name.text);
    }
  };

  for (let pass = 0; pass < 16; pass += 1) {
    const before = direct.size + namespaces.size;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        bindName(node.name, node.initializer);
        // `const { deny: refuse } = fns` — destructuring OFF a namespace.
        if (ts.isObjectBindingPattern(node.name) && node.initializer
          && ts.isIdentifier(unwrapExpression(node.initializer))
          && namespaces.has((unwrapExpression(node.initializer) as ts.Identifier).text)) {
          for (const element of node.name.elements) {
            const original = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : (ts.isIdentifier(element.name) ? element.name.text : '');
            if (original === DENY_EXPORT && ts.isIdentifier(element.name)) direct.add(element.name.text);
          }
        }
      }
      // `let refuse; … refuse = deny;`
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left) && isDenyExpression(node.right, direct, namespaces)) {
        direct.add(node.left.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (direct.size + namespaces.size === before) return;
  }
}

// Where the deny META argument sits for the call shapes a callee can be
// invoked through. Returns null when the shape is recognised as deny but the
// meta cannot be read — an `.apply` with a non-literal argument array, say —
// which fails closed exactly like a missing argument.
//
// This is the axis the old scanner had no notion of: its name promised "every
// import shape a call site can use", and it delivered that, but a call site
// picks a CALL shape independently of the import shape. `deny.call(null, msg)`,
// `(0, deny)(msg)` and `apply(deny, msg)` all reach the same function through
// bindings the resolver had already resolved correctly.
type DenyCallShape =
  | { readonly kind: 'direct'; readonly meta: ts.Expression | undefined }
  | { readonly kind: 'call'; readonly meta: ts.Expression | undefined }
  | { readonly kind: 'apply'; readonly meta: ts.Expression | undefined };

function denyCallShape(node: ts.CallExpression, bindings: DenyBindings): DenyCallShape | null {
  const { direct, namespaces } = bindings;
  const callee = unwrapExpression(node.expression);
  if (isDenyExpression(callee, direct, namespaces)) {
    return { kind: 'direct', meta: node.arguments[1] };
  }
  // `deny.call(thisArg, reason, meta)` / `deny.apply(thisArg, [reason, meta])`.
  if (ts.isPropertyAccessExpression(callee) && isDenyExpression(callee.expression, direct, namespaces)) {
    if (callee.name.text === 'call') return { kind: 'call', meta: node.arguments[2] };
    if (callee.name.text === 'apply') {
      const array = node.arguments[1] ? unwrapExpression(node.arguments[1]) : undefined;
      const meta = array && ts.isArrayLiteralExpression(array) ? array.elements[1] : undefined;
      return { kind: 'apply', meta };
    }
    // `.bind`/anything else on deny yields a VALUE, not a call — reported by
    // the bare-reference rule below rather than guessed at here.
  }
  return null;
}

const SPREAD_META_REASON = 'the denyId is spread in from another object — declare it INLINE at the call site '
  + '(`deny(msg, { ...META, denyId: \'…\' })`), since the spread source cannot be read here';
const INDIRECT_REASON = 'core deny() is passed as an argument here, so its call site (and its denyId) is not '
  + 'visible to this scanner — call deny() directly instead of handing the function to a helper';
const MISSING_META_REASON = 'no denyId (add one from src/config/deny-ids.ts DENY_IDS, or add a new registry entry there first)';

// Does this call declare a denyId? Object literal → carries the property.
// Conditional → BOTH branches must (model-rotation.ts picks its id per
// branch). Parenthesized / `as` / `satisfies` wrappers are transparent.
function declaresDenyId(argument: ts.Expression | undefined): boolean {
  if (!argument) return false;
  if (ts.isConditionalExpression(argument)) {
    return declaresDenyId(argument.whenTrue) && declaresDenyId(argument.whenFalse);
  }
  const meta = unwrapExpression(argument);
  if (meta !== argument) return declaresDenyId(meta);
  if (!ts.isObjectLiteralExpression(meta)) return false;
  return meta.properties.some((property) => {
    const name = property.name;
    if (!name) return false;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === 'denyId';
    return false;
  });
}

// A meta object whose only contribution is a spread. Failing closed is right —
// the spread source is not readable here — but "no denyId" sends an author
// hunting for a field that is, from their point of view, already set.
function spreadsMeta(argument: ts.Expression | undefined): boolean {
  if (!argument) return false;
  const meta = unwrapExpression(argument);
  if (ts.isConditionalExpression(meta)) return spreadsMeta(meta.whenTrue) || spreadsMeta(meta.whenFalse);
  return ts.isObjectLiteralExpression(meta) && meta.properties.some((property) => ts.isSpreadAssignment(property));
}

interface DenyCallSite {
  readonly relFile: string;
  readonly line: number;
  readonly declaresDenyId: boolean;
  /** Why it does not, for the failure message. Empty when it declares one. */
  readonly reason: string;
}

function scanDenyCallSites(tree: SourceTree, absFile: string): DenyCallSite[] {
  const text = tree.read(absFile);
  if (text === null) return [];
  const source = parseSource(absFile, text);
  const bindings = denyBindings(tree, absFile, source);
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) return [];
  const relFile = path.relative(REPO_ROOT, absFile);
  const sites: DenyCallSite[] = [];
  const at = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const push = (node: ts.Node, declares: boolean, reason: string): void => {
    sites.push({ relFile, line: at(node), declaresDenyId: declares, reason: declares ? '' : reason });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const shape = denyCallShape(node, bindings);
      if (shape) {
        const declares = declaresDenyId(shape.meta);
        push(node, declares, spreadsMeta(shape.meta) ? SPREAD_META_REASON : MISSING_META_REASON);
        // Do NOT descend into the callee: `(0, deny)(…)` and `deny.call(…)`
        // both mention the binding there, and it is this call, not a second
        // indirect one.
        for (const argument of node.arguments) visit(argument);
        return;
      }
      // deny handed to something else (`apply(deny, msg)`, `wrap(deny)`): the
      // real call is out of sight, so fail closed rather than lose the site.
      for (const argument of node.arguments) {
        if (isDenyExpression(argument, bindings.direct, bindings.namespaces)) push(argument, false, INDIRECT_REASON);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function listProductionTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listProductionTsFiles(full, out);
      continue;
    }
    // .tsx as well as .ts: a React-shaped file is production source like any
    // other, and excluding the extension made a whole file class unscannable
    // rather than merely unscanned.
    const production = (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      || (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx'));
    if (entry.isFile() && production) out.push(full);
  }
  return out;
}

// Every file that yields at least one deny() call site today. This is the
// zero-drop guard, and it is the assertion the old scanner most needed: when
// spawn-hygiene.ts silently fell to 0 sites, the only self-check was a global
// site floor that a single missing file could not move. A file listed here
// falling to zero now fails BY NAME. Adding a NEW gate file needs no edit
// here — its sites are covered by the denyId assertion itself.
const FILES_WITH_DENY_SITES: readonly string[] = [
  // The fallback minter itself. Out of scope for the old text filter (it
  // imports from './result', not '.../core/result'), which is exactly why it
  // is pinned first here.
  'src/core/pipeline.ts',
  'src/modules/agent-model/codex-child-model.ts',
  'src/modules/agent-model/cursor-failures.ts',
  'src/modules/agent-model/gate-enforcement.ts',
  'src/modules/agent-model/gate-opencode-first.ts',
  'src/modules/agent-model/gate-reuse.ts',
  'src/modules/agent-model/handler.ts',
  'src/modules/agent-model/model-denies.ts',
  'src/modules/agent-model/model-rotation.ts',
  // The regex-literal canary: its `/[^\s'"`<>)]*/` character class is what
  // desynchronized the old hand-rolled lexer into reporting 0 sites for this
  // file while a real deny( sat at line 36.
  'src/modules/agent-model/spawn-hygiene.ts',
  'src/modules/agent-model/spawn-shape.ts',
  'src/modules/agent-model/subagent-bind.ts',
  'src/modules/model-choice-gate/index.ts',
  'src/modules/onboarding-gate/handler.ts',
  'src/modules/onboarding-gate/stop.ts',
  'src/modules/one-mcp-tool-gate/index.ts',
  'src/modules/plan-guard/deploy-gate.ts',
  'src/modules/plan-guard/handler.ts',
  'src/modules/plan-guard/plan-write/index.ts',
  'src/modules/plan-guard/scaffold-gate.ts',
  'src/modules/plan-guard/supabase-local-gate.ts',
  'src/modules/session/authoring-guard.ts',
  'src/modules/session/workspace-boundary-guard.ts',
];

test('every deny() call site in production source declares a denyId', () => {
  const files = listProductionTsFiles(SRC_ROOT);
  assert.ok(files.length > 100, `expected to find well over 100 production .ts files, found ${files.length} — is SRC_ROOT wrong?`);

  const tree = sourceTree();
  const sites = files.flatMap((file) => scanDenyCallSites(tree, file));
  // A regression guard on the scanner itself: if a future refactor of
  // core/result.ts's export shape (or of this scanner) silently stops finding
  // real call sites, an empty/tiny result must fail loudly here rather than
  // let the assert.deepEqual below vacuously pass on zero sites.
  assert.ok(
    sites.length > 80,
    `expected well over 80 deny() call sites across production source, found ${sites.length} — `
    + 'the binding resolver or the AST walk may be broken, not that every gate was deleted',
  );

  const scannedFiles = new Set(sites.map((site) => site.relFile));
  const wentSilent = FILES_WITH_DENY_SITES.filter((file) => !scannedFiles.has(file));
  assert.deepEqual(
    wentSilent,
    [],
    `${wentSilent.length} file(s) that used to yield deny() call sites now yield ZERO — either the deny calls `
    + 'really were removed (then delete the line from FILES_WITH_DENY_SITES in the same commit) or the scanner '
    + `has gone blind to that file's import/call shape:\n${wentSilent.map((file) => `  ${file}`).join('\n')}`,
  );

  const missing = sites.filter((site) => !site.declaresDenyId);
  assert.deepEqual(
    missing.map((site) => `${site.relFile}:${site.line}`),
    [],
    `${missing.length} deny() call site(s) are unattributed:\n`
    + missing.map((site) => `  ${site.relFile}:${site.line} — ${site.reason}`).join('\n'),
  );
});

// ── scanner coverage: the binding shapes a call site can be written in ──────
// Each fixture is one line of the shape table the reviewer measured against
// the old scanner. Five of these yielded 0 sites there; the aliased-import row
// was the dangerous one, because the file WAS scanned (so no count guard
// moved) while its call sites disappeared. Fixtures rather than real files, so
// the shapes stay covered even though this repo happens to write only the
// direct one today.

const FIXTURE_FILE = path.join(SRC_ROOT, 'modules', '__deny-scanner-fixture__', 'gate.ts');
const FIXTURE_HELPER = path.join(SRC_ROOT, 'modules', '__deny-scanner-fixture__', 'deny-helpers.ts');
const FIXTURE_BARREL = path.join(SRC_ROOT, 'modules', '__deny-scanner-fixture__', 'core-barrel', 'index.ts');

interface ShapeCase {
  readonly label: string;
  readonly files: Record<string, string>;
  readonly expectedSites: number;
}

const SHAPE_CASES: readonly ShapeCase[] = [
  {
    label: "direct named import — import { deny } from '.../core/result'",
    expectedSites: 1,
    files: {
      [FIXTURE_FILE]: "import { deny } from '../../core/result';\nexport const gate = () => deny('no', { denyId: 'authoring-guard' });\n",
    },
  },
  {
    label: 'relative-to-core import — the shape core/pipeline.ts uses (./result)',
    expectedSites: 1,
    files: {
      [path.join(SRC_ROOT, 'core', '__deny-scanner-fixture__.ts')]: "import { deny } from './result';\nexport const gate = () => deny('no', { denyId: 'pipeline-handler-crashed' });\n",
    },
  },
  {
    label: 're-export wrapper — import { deny } from \'./deny-helpers\'',
    expectedSites: 1,
    files: {
      [FIXTURE_HELPER]: "export { deny } from '../../core/result';\n",
      [FIXTURE_FILE]: "import { deny } from './deny-helpers';\nexport const gate = () => deny('no', { denyId: 'authoring-guard' });\n",
    },
  },
  {
    label: 'namespace import — import * as result → result.deny(...)',
    expectedSites: 1,
    files: {
      [FIXTURE_FILE]: "import * as result from '../../core/result';\nexport const gate = () => result.deny('no', { denyId: 'authoring-guard' });\n",
    },
  },
  {
    label: 'aliased import — import { deny as refuse } → refuse(...)',
    expectedSites: 1,
    files: {
      [FIXTURE_FILE]: "import { deny as refuse } from '../../core/result';\nexport const gate = () => refuse('no', { denyId: 'authoring-guard' });\n",
    },
  },
  {
    label: 'require destructuring — const { deny } = require(...)',
    expectedSites: 1,
    files: {
      [FIXTURE_FILE]: "const { deny } = require('../../core/result');\nexport const gate = () => deny('no', { denyId: 'authoring-guard' });\n",
    },
  },
  {
    label: 'dynamic import destructuring, inside a function body, aliased',
    expectedSites: 1,
    files: {
      [FIXTURE_FILE]: "export async function gate() {\n  const { deny: refuse } = await import('../../core/result');\n  return refuse('no', { denyId: 'authoring-guard' });\n}\n",
    },
  },
  {
    label: "barrel — import { deny } from '../../core' (export * from './result')",
    expectedSites: 1,
    files: {
      [FIXTURE_BARREL]: "export * from '../../../core/result';\n",
      [FIXTURE_FILE]: "import { deny } from './core-barrel';\nexport const gate = () => deny('no', { denyId: 'authoring-guard' });\n",
    },
  },
  {
    label: 'two calls, one shape — every call site is a separate site',
    expectedSites: 2,
    files: {
      [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
        + "export const a = () => deny('no', { denyId: 'authoring-guard' });\n"
        + "export const b = () => deny('also no', { denyId: 'workspace-boundary-guard' });\n",
    },
  },
];

test('the scanner finds core deny() through every import shape a call site can use', () => {
  for (const shapeCase of SHAPE_CASES) {
    const tree = sourceTree(shapeCase.files);
    const entry = Object.keys(shapeCase.files).at(-1)!;
    const sites = scanDenyCallSites(tree, entry);
    assert.equal(
      sites.length,
      shapeCase.expectedSites,
      `${shapeCase.label}: expected ${shapeCase.expectedSites} site(s), found ${sites.length}`,
    );
  }
});

// ── scanner coverage: the shapes a call can be WRITTEN in ───────────────────
// The axis above resolves how deny is IMPORTED. A call site picks its call
// shape independently, and every row here resolved its import correctly while
// yielding zero sites — `const refuse = deny` most dangerously, because it is
// what an ordinary extract-a-helper refactor emits and the file stayed
// "scanned" the whole time, so neither the per-file guard nor the site floor
// could move.
//
// Each row is run twice from one template: once with an inline denyId (must be
// found AND attributed — a shape the scanner over-reports is as useless as one
// it misses) and once without (must be found AND reported).
const INLINE_META = "{ denyId: 'authoring-guard' }";
const FIXTURE_TSX = path.join(SRC_ROOT, 'modules', '__deny-scanner-fixture__', 'panel.tsx');
const FIXTURE_NS_BARREL = path.join(SRC_ROOT, 'modules', '__deny-scanner-fixture__', 'ns-barrel.ts');

interface CallShapeCase {
  readonly label: string;
  /** `%META%` is replaced by an inline meta object, then by nothing. */
  readonly files: Record<string, string>;
  readonly entry: string;
}

const CALL_SHAPE_CASES: readonly CallShapeCase[] = [
  {
    label: 'local rebinding — const refuse = deny; refuse(...)',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
        + 'const refuse = deny;\n'
        + "export const gate = () => refuse('no'%META%);\n",
    },
  },
  {
    label: "namespace re-export — export * as res from '.../result'; res.deny(...)",
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_NS_BARREL]: "export * as res from '../../core/result';\n",
      [FIXTURE_FILE]: "import { res } from './ns-barrel';\n"
        + "export const gate = () => res.deny('no'%META%);\n",
    },
  },
  {
    label: 'object literal carrying the binding — const fns = { deny }; fns.deny(...)',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
        + 'const fns = { deny };\n'
        + "export const gate = () => fns.deny('no'%META%);\n",
    },
  },
  {
    label: 'Function.prototype.call — deny.call(null, ...)',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
        + "export const gate = () => deny.call(null, 'no'%META%);\n",
    },
  },
  {
    label: 'Function.prototype.apply — deny.apply(null, [...])',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
        + "export const gate = () => deny.apply(null, ['no'%META%]);\n",
    },
  },
  {
    label: 'comma expression — (0, deny)(...)',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
        + "export const gate = () => (0, deny)('no'%META%);\n",
    },
  },
  {
    label: 'a .tsx file — JSX must not eat the statements after it',
    entry: FIXTURE_TSX,
    files: {
      [FIXTURE_TSX]: "import { deny } from '../../core/result';\n"
        + "export const Panel = () => <div className='x'>{'hi'}</div>;\n"
        + "export const gate = () => deny('no'%META%);\n",
    },
  },
];

test('the scanner finds core deny() through every CALL shape, not just every import shape', () => {
  for (const shapeCase of CALL_SHAPE_CASES) {
    for (const [what, meta] of [['attributed', `, ${INLINE_META}`], ['unattributed', '']] as const) {
      const files = Object.fromEntries(
        Object.entries(shapeCase.files).map(([file, text]) => [file, text.replace('%META%', meta)]),
      );
      const sites = scanDenyCallSites(sourceTree(files), shapeCase.entry);
      assert.equal(sites.length, 1, `${shapeCase.label} (${what}): expected 1 site, found ${sites.length}`);
      assert.equal(
        sites[0]!.declaresDenyId,
        what === 'attributed',
        `${shapeCase.label} (${what}): declaresDenyId=${sites[0]!.declaresDenyId}`,
      );
    }
  }
});

// deny handed to a helper: the real invocation happens somewhere this scanner
// cannot follow, so the reference itself is the site and it fails closed.
test('core deny() passed as a value is reported rather than lost', () => {
  const files = {
    [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
      + 'declare function apply(fn: unknown, reason: string): unknown;\n'
      + "export const gate = () => apply(deny, 'no');\n",
  };
  const sites = scanDenyCallSites(sourceTree(files), FIXTURE_FILE);
  assert.equal(sites.length, 1, 'passing deny to a helper must not make the site disappear');
  assert.equal(sites[0]!.declaresDenyId, false);
  assert.match(sites[0]!.reason, /passed as an argument/);
});

test('the scanner ignores deny lookalikes that are not core deny', () => {
  const cases: ReadonlyArray<{ label: string; files: Record<string, string> }> = [
    {
      // plan-runteam.ts's real shape: a local string-concatenation helper.
      label: 'a local deny() helper with no core import',
      files: {
        [FIXTURE_FILE]: "const deny = (reason: string): string => `X: ${reason}`;\nexport const gate = () => deny('no');\n",
      },
    },
    {
      // compiled-smoke.ts's real shape: generated source inside a template.
      label: 'deny( inside a string/template literal',
      files: {
        [FIXTURE_FILE]: 'export const shim = `function deny(a) { return deny("x"); }`;\nexport const other = "deny(\'y\')";\n',
      },
    },
    {
      label: 'a member call on something that is not a deny namespace',
      files: {
        [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
          + "const other = { deny: (r: string) => r };\n"
          + "export const gate = () => other.deny('no');\n",
      },
    },
    {
      label: 'a same-named export from an unrelated module',
      files: {
        [FIXTURE_HELPER]: 'export const deny = (reason: string): string => reason;\n',
        [FIXTURE_FILE]: "import { deny } from './deny-helpers';\nexport const gate = () => deny('no');\n",
      },
    },
  ];
  for (const lookalike of cases) {
    const tree = sourceTree(lookalike.files);
    const entry = Object.keys(lookalike.files).at(-1)!;
    const sites = scanDenyCallSites(tree, entry);
    assert.equal(sites.length, 0, `${lookalike.label}: expected 0 sites, found ${sites.length}`);
  }
});

// The specific defect that made the old scanner blind to a live call site: a
// regex literal whose character class contains a quote, followed much later by
// an apostrophe in prose. The old lexer treated the `'` as a string opener,
// ran to the apostrophe, and swallowed everything between — including the real
// deny(. Pinned as its own test because the production canary
// (spawn-hygiene.ts) could legitimately be rewritten some day, and the
// scanner property must survive that.
test('a regex literal containing a quote does not hide a later deny() call', () => {
  const files = {
    [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
      + "const re = /\\/[^\\s'\"`<>)]*?\\.traffic-one\\/(?:runs|digests)\\/[^\\s'\"`<>)]*/g;\n"
      + "export const gate = (p: string) => (re.test(p) ? deny('no', { denyId: 'absolute-traffic-one-path' }) : null);\n"
      + "// Later prose with Copilot's apostrophe in it.\n",
  };
  const sites = scanDenyCallSites(sourceTree(files), FIXTURE_FILE);
  assert.equal(sites.length, 1, 'the deny() after the regex literal must still be found');
  assert.equal(sites[0]!.declaresDenyId, true);
});

test('a call site that declares no denyId is reported, including per-branch metas', () => {
  const cases: ReadonlyArray<{ label: string; body: string; declares: boolean }> = [
    { label: 'no second argument at all', body: "deny('no')", declares: false },
    { label: 'second argument without denyId', body: "deny('no', { denyTarget: 'x' })", declares: false },
    { label: 'denyId only in a comment', body: "deny('no', { /* denyId: 'authoring-guard' */ denyTarget: 'x' })", declares: false },
    { label: 'denyId only inside a nested string', body: "deny('reads like denyId: authoring-guard', { denyTarget: 'x' })", declares: false },
    { label: 'meta hidden behind a variable', body: "deny('no', meta)", declares: false },
    { label: 'declared', body: "deny('no', { denyId: 'authoring-guard' })", declares: true },
    { label: 'declared with a quoted key', body: "deny('no', { 'denyId': 'authoring-guard' })", declares: true },
    {
      label: 'conditional meta, both branches declared (model-rotation.ts\'s shape)',
      body: "deny('no', cond ? { denyId: 'authoring-guard' } : { denyId: 'workspace-boundary-guard' })",
      declares: true,
    },
    {
      label: 'conditional meta, only ONE branch declared',
      body: "deny('no', cond ? { denyId: 'authoring-guard' } : { denyTarget: 'x' })",
      declares: false,
    },
  ];
  for (const argCase of cases) {
    const files = {
      [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
        + 'declare const cond: boolean;\ndeclare const meta: Record<string, string>;\n'
        + `export const gate = () => ${argCase.body};\n`,
    };
    const sites = scanDenyCallSites(sourceTree(files), FIXTURE_FILE);
    assert.equal(sites.length, 1, `${argCase.label}: expected exactly 1 site`);
    assert.equal(sites[0]!.declaresDenyId, argCase.declares, argCase.label);
  }
});

// Failing closed on a spread is correct — the spread source is not readable
// here — but the generic "no denyId" message sends the author looking for a
// field that, from where they sit, is already set. Name the actual rule.
test('a spread meta says the denyId must be INLINE, not that it is missing', () => {
  const files = {
    [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
      + "const META = { denyId: 'authoring-guard' } as const;\n"
      + "export const gate = () => deny('no', { ...META });\n",
  };
  const sites = scanDenyCallSites(sourceTree(files), FIXTURE_FILE);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.declaresDenyId, false, 'a spread cannot be read, so it must still fail closed');
  assert.match(sites[0]!.reason, /spread/);
  assert.match(sites[0]!.reason, /INLINE/);
  // The generic message must NOT be what the author sees here.
  assert.equal(sites[0]!.reason.includes(MISSING_META_REASON), false);
  // A spread PLUS an inline denyId is attributed — the inline one is readable.
  const withInline = {
    [FIXTURE_FILE]: "import { deny } from '../../core/result';\n"
      + "const META = { denyTarget: 'x' } as const;\n"
      + "export const gate = () => deny('no', { ...META, denyId: 'authoring-guard' });\n",
  };
  const attributed = scanDenyCallSites(sourceTree(withInline), FIXTURE_FILE);
  assert.equal(attributed.length, 1);
  assert.equal(attributed[0]!.declaresDenyId, true);
});

// ── The two population tallies deny-ids.ts states in prose ──────────────────
// Both headers explain a DEFAULT by sizing the set that takes it: "a gate NOT
// listed here is overridable ... the N remaining ids are ordinary
// process/sequencing refusals", and the same shape for escalation. A reader
// deciding whether a new id belongs on either list weighs it against that size,
// so a stale N argues from a population that does not exist.
//
// Both had decayed to "~110" — a figure from the 192-id era, wrong by 56 and 62
// once the catalog reached 201, and wrong for the SECOND time. Numbers written
// beside the arrays they describe do not stay true on their own, so this pins
// them the way readme-claims.test.ts pins the README and node-floor pins
// `engines`: read the number out of the PROSE, derive it from the ARRAYS, and
// let the two be unable to name different values.
test('the population tallies in deny-ids.ts prose match the arrays they describe', () => {
  const file = path.join(SRC_ROOT, 'config', 'deny-ids.ts');
  // Flatten the comment block before matching: both sentences wrap across lines,
  // so in the raw bytes "the" and its number are separated by "\n// ". Matching
  // the raw text needs a pattern that encodes the line-comment prefix, which
  // then breaks the moment someone rewraps the paragraph — a false failure on an
  // edit that changed no claim.
  const text = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/ ?/gm, '').replace(/\s+/g, ' ');

  // Derive from the arrays, never from a second hardcoded number.
  const declared = new Set(DENY_IDS).size;
  const tallies: { label: string; stated: RegExp; remaining: number }[] = [
    {
      // This sentence is pinned in TWO places, and they must be rewritten
      // together: state/__tests__/deny-signature-plugin-root.test.ts recomputes
      // all three of its numbers against the same regex. Rewording it for that
      // pin alone is what reddened this one — the paragraph gained its
      // parenthetical while adding `host-role-contracts-unwritable`, and only
      // the sibling was updated.
      label: 'NEVER_OVERRIDABLE_DENY_IDS',
      stated: /(\d+) remaining ids \((\d+) declared, less the (\d+) below\)/,
      remaining: declared - new Set(NEVER_OVERRIDABLE_DENY_IDS).size,
    },
    {
      label: 'NEVER_ESCALATED_DENY_IDS',
      stated: /the remaining (\d+) ids are refusals with an/,
      remaining: declared - new Set(NEVER_ESCALATED_DENY_IDS).size,
    },
  ];

  for (const { label, stated, remaining } of tallies) {
    const match = stated.exec(text);
    assert.ok(
      match,
      `deny-ids.ts no longer states a tally for the ids NOT in ${label}.\n`
      + 'If the sentence was reworded, update this pattern — do not delete the assertion:'
      + ' the number is what a reader sizes a new entry against.',
    );
    assert.equal(
      Number(match![1]),
      remaining,
      `deny-ids.ts prose says ${match![1]} ids fall outside ${label}; the arrays say ${remaining}`
      + ` (${declared} declared - ${declared - remaining} listed).`
      + ' FIX: correct the prose. It has gone stale twice, both times by growing the catalog.',
    );
  }

  // Non-vacuity: a pattern that matched nothing would fail above, but a pattern
  // that matched the WRONG sentence would pass while pinning something else.
  // Both tallies are strictly inside the catalog, and they differ from each
  // other, so neither can be reading a shared constant or the total.
  for (const { label, remaining } of tallies) {
    assert.ok(remaining > 0 && remaining < declared, `${label}'s remainder must be a strict subset`);
  }
  assert.notEqual(tallies[0]!.remaining, tallies[1]!.remaining, 'the two tallies must be distinct numbers');
});
