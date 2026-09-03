// src/shared/__tests__/skill-block-coverage.test.ts
// Every agent-facing gate reason is assembled by `makeSkillBlock` (shared/
// skill-block.ts): the prose lives in a `<!-- T1BLOCK:BEGIN <name> -->` fence in
// src/modules/<moduleId>/skill/SKILL.md, and TS passes a name plus an optional
// VERBATIM FALLBACK. When a block is missing, `skillBlock` returns the fallback
// — or, when the call site passed none, the empty string. So a renamed or
// deleted T1BLOCK never disables enforcement (the deny still fires) but can
// render an EMPTY REASON: the agent is refused and told nothing. On the gates
// whose reason IS the remedy, that is the whole value of the deny.
//
// This file is the DETECTION for that, across the whole population. It used to
// cover exactly one module (onboarding-gate) from three hand-listed files with
// a regex; agent-model got its own copy of the same regex in
// modules/agent-model/__tests__/liveness-prose.test.ts. Neither could see the
// rest, and a hand-listed file set has the hole this repo has already been bitten
// by more than once: the list is what gets iterated, so anything absent from it
// is never examined.
//
// ── Why a parse and not a regex ──────────────────────────────────────────────
// The regex was `/(?<![A-Za-z0-9_])block\(\s*'([a-z0-9-]+)'/g`. It is blind in
// both directions, and both blindnesses are LIVE in this repo today:
//   - It matches on the NAME `block`, so it cannot tell which SKILL.md a call
//     reads. `modules/plan-guard/build-orchestration-directive.ts` and four
//     files under `modules/session/` bind their `block` to the ONBOARDING-GATE
//     skill, not to their own directory's. A directory-driven generalisation of
//     the regex would compare those call sites against the wrong file and pass.
//   - It only sees a callee spelled `block`. plan-guard threads its assembler
//     through as a `Block`-typed PARAMETER (`planStaticViolations(…, block)`,
//     `runIdPathViolation({ …, block })`, `args.block(…)`), and agent-model
//     imports a `block` exported by handler-prose.ts. 99 of the 174 call sites
//     found here reach the assembler through one of those indirections.
// So the pairing between a call site and a SKILL.md is established from the
// CODE — the module id is the string literal that reaches `SkillBlockFn`'s
// first parameter, which is literally the path segment makeSkillBlock joins
// into `<root>/src/modules/<moduleId>/skill/SKILL.md` — and never from the
// directory the call happens to sit in.
//
// The scanner follows the idiom of tests/deny-id-completeness.test.ts:
// `ts.createSourceFile` plus a small binding walk, no ts.Program and no type
// checker. Strings, templates, comments and regex literals become the parser's
// problem, and "is this callee a skill-block assembler?" becomes a binding
// question instead of a text question.
//
// ── The two severities ───────────────────────────────────────────────────────
// A call site whose block resolves to no prose AT ALL renders `''` — a live
// empty-reason defect. A call site whose prose exists but whose call-site copy
// says something else is documentation drift, not an enforcement loss. Both are
// asserted; only the first is described as a defect.
//
// What "no prose at all" means changed when shared/skill-fallbacks.generated.ts
// landed. `makeSkillBlock` now resolves the live T1BLOCK, then the GENERATED
// table (the same bodies, compiled beside the assembler and reached without
// pluginRoot()), then the call site's explicit argument. So a site that passes
// no fallback is no longer vulnerable by itself: it renders the shipped prose
// on a torn install like every other site. Only a block that exists in no
// SKILL.md can still render empty, and that is asserted DIRECTLY below
// ('every block a call site can render resolves to prose…') against the table
// itself, rather than through the 33-entry fallback-less allowlist that used to
// stand in for it. The table's own fidelity to the SKILL.md bodies is
// skill-fallback-drift.test.ts's job, and `npm run plugin:check`'s.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

import { extractBlock, generatedFallback } from '../skill-block';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// The module that DEFINES the assembler factory. Everything else either imports
// it (directly or through re-exports) or is out of scope.
const ORIGIN_REL = path.join('src', 'shared', 'skill-block.ts');
const ORIGIN_EXPORT = 'makeSkillBlock';

// ── binder model ─────────────────────────────────────────────────────────────
// `raw` is a `SkillBlockFn` itself: (moduleId, blockName, vars, fallback).
// `bound` is anything that has already closed over a module id — an arrow, a
// factory result, or a parameter something passed one into. `nameIndex` /
// `fallbackIndex` are read off the forwarding call rather than assumed, because
// the three shapes in this repo disagree about argument order:
//   onboarding/agent-model  (name, vars, fallback)
//   plan-guard              (name, fallback, vars)   ← fallback and vars swapped
//   model-choice-gate       (name, vars)             ← no fallback parameter
type Binder =
  | { readonly kind: 'raw' }
  | { readonly kind: 'bound'; readonly moduleId: string; readonly nameIndex: number; readonly fallbackIndex: number | null };

interface Scoped { readonly name: string; readonly binder: Binder; readonly start: number; readonly end: number }
interface Member { readonly obj: string; readonly prop: string; readonly binder: Binder; readonly start: number; readonly end: number }

interface FileState {
  readonly file: string;
  readonly src: ts.SourceFile;
  readonly imports: ReadonlyMap<string, { file: string | null; name: string }>;
  readonly factoryNames: ReadonlySet<string>;
  readonly exportedNames: ReadonlySet<string>;
  readonly reExports: ReadonlyMap<string, { file: string; name: string }>;
  readonly scoped: Scoped[];
  readonly members: Member[];
  /** Calls that FORWARD a parameter as the block name — the binder's own body, not a site. */
  readonly passThrough: Set<ts.CallExpression>;
  added: number;
}

export interface BlockCallSite {
  readonly relFile: string;
  readonly line: number;
  readonly callee: string;
  readonly moduleId: string | null;
  /** The block names this site can render, or null when the parse cannot say. */
  readonly names: readonly string[] | null;
  readonly literal: boolean;
  readonly hasFallback: boolean;
  /** The fallback argument COOKED: its string VALUE, with every `${expr}` kept
   *  as its source text. null when the expression is not a literal the parse can
   *  evaluate (a table lookup, a helper call, a ternary) — see
   *  FALLBACK_NOT_A_LITERAL. */
  readonly fallbackCooked: string | null;
  /** How the fallback expression was shaped, so a pair that leaves the
   *  comparable population says WHY. */
  readonly fallbackShape: string;
  /** The vars object literal: property name → initializer source text. */
  readonly vars: Readonly<Record<string, string>> | null;
}

interface Census {
  readonly root: string;
  readonly modules: readonly string[];
  readonly blocksByModule: ReadonlyMap<string, ReadonlySet<string>>;
  /** Raw SKILL.md text per module, so the parity bar reads block BODIES through
   *  the production extractor rather than re-listing the files. */
  readonly skillTextByModule: ReadonlyMap<string, string>;
  readonly sites: readonly BlockCallSite[];
  readonly fileCount: number;
}

interface Scope { readonly start: number; readonly end: number }
const FILE_SCOPE: Scope = { start: -1, end: Number.POSITIVE_INFINITY };

function binderKey(b: Binder): string {
  return b.kind === 'raw' ? 'raw' : `${b.moduleId}#${b.nameIndex}#${b.fallbackIndex}`;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)
      || ts.isTypeAssertionExpression(current)) { current = current.expression; continue; }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = current.right; continue;
    }
    return current;
  }
}

function moduleSpecifierText(node: { moduleSpecifier?: ts.Expression }): string | null {
  const specifier = node.moduleSpecifier;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : null;
}

// One scanner instance per root, so the fixtures below can drive a synthetic
// tree through exactly the code the real assertions run on.
function scanRoot(root: string): Census {
  const srcRoot = path.join(root, 'src');
  const origin = path.join(root, ORIGIN_REL);

  const textCache = new Map<string, string | null>();
  const read = (abs: string): string | null => {
    if (!textCache.has(abs)) {
      let text: string | null = null;
      try { text = fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null; } catch { text = null; }
      textCache.set(abs, text);
    }
    return textCache.get(abs) ?? null;
  };
  const astCache = new Map<string, ts.SourceFile | null>();
  const parse = (abs: string): ts.SourceFile | null => {
    if (!astCache.has(abs)) {
      const text = read(abs);
      // setParentNodes so getStart()/parent walks work; ScriptKind.TSX or a JSX
      // element is a parse error that eats every statement after it.
      astCache.set(abs, text === null ? null : ts.createSourceFile(
        abs, text, ts.ScriptTarget.Latest, true, abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ));
    }
    return astCache.get(abs) ?? null;
  };
  const resolveSpecifier = (fromFile: string, specifier: string): string | null => {
    if (!specifier.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromFile), specifier);
    const candidates = [
      base.endsWith('.ts') || base.endsWith('.tsx') ? base : `${base}.ts`,
      `${base}.tsx`,
      base.replace(/\.jsx?$/, '.ts'),
      path.join(base, 'index.ts'),
      path.join(base, 'index.tsx'),
    ];
    for (const candidate of candidates) if (read(candidate) !== null) return candidate;
    return null;
  };

  // Does `file` export `name`, and is that export the origin's makeSkillBlock?
  // Followed through re-exports and `export *` barrels, exactly as
  // deny-id-completeness.test.ts follows core's deny.
  const exportsOrigin = (file: string, name: string, seen = new Set<string>()): boolean => {
    if (file === origin) return name === ORIGIN_EXPORT;
    const key = `${file}#${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const source = parse(file);
    if (!source) return false;
    const importedFrom = new Map<string, { file: string; name: string }>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = moduleSpecifierText(statement);
      const target = specifier ? resolveSpecifier(file, specifier) : null;
      const bindings = statement.importClause?.namedBindings;
      if (!target || !bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        importedFrom.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
      }
    }
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      const specifier = moduleSpecifierText(statement);
      const target = specifier ? resolveSpecifier(file, specifier) : null;
      if (!statement.exportClause) {
        if (target && exportsOrigin(target, name, seen)) return true;
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== name) continue;
        const original = (element.propertyName ?? element.name).text;
        if (target) { if (exportsOrigin(target, original, seen)) return true; continue; }
        const local = importedFrom.get(original);
        if (local && exportsOrigin(local.file, local.name, seen)) return true;
      }
    }
    return false;
  };

  const listProductionFiles = (dir: string, out: string[] = []): string[] => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { listProductionFiles(full, out); continue; }
      const production = (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
        || (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx'));
      if (entry.isFile() && production) out.push(full);
    }
    return out;
  };

  const files = listProductionFiles(srcRoot);
  const states = new Map<string, FileState>();
  for (const file of files) {
    const src = parse(file);
    if (!src) continue;
    const imports = new Map<string, { file: string | null; name: string }>();
    for (const statement of src.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = moduleSpecifierText(statement);
      const target = specifier ? resolveSpecifier(file, specifier) : null;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        imports.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
      }
    }
    const factoryNames = new Set<string>();
    for (const [local, info] of imports) if (info.file && exportsOrigin(info.file, info.name)) factoryNames.add(local);

    const exportedNames = new Set<string>();
    const reExports = new Map<string, { file: string; name: string }>();
    const isExported = (node: ts.Node): boolean =>
      ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const collectExports = (node: ts.Node): void => {
      if (ts.isVariableStatement(node) && isExported(node)) {
        for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) exportedNames.add(d.name.text);
      }
      if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) exportedNames.add(node.name.text);
      ts.forEachChild(node, collectExports);
    };
    collectExports(src);
    for (const statement of src.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      const specifier = moduleSpecifierText(statement);
      const target = specifier ? resolveSpecifier(file, specifier) : null;
      if (!statement.exportClause) { if (target) reExports.set('*', { file: target, name: '*' }); continue; }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        const original = (element.propertyName ?? element.name).text;
        if (target) { reExports.set(element.name.text, { file: target, name: original }); continue; }
        exportedNames.add(element.name.text);
        if (original !== element.name.text) reExports.set(element.name.text, { file, name: original });
      }
    }
    states.set(file, {
      file, src, imports, factoryNames, exportedNames, reExports,
      scoped: [], members: [], passThrough: new Set(), added: 0,
    });
  }

  const addScoped = (st: FileState, name: string, binder: Binder, scope = FILE_SCOPE): void => {
    if (st.scoped.some((x) => x.name === name && x.start === scope.start && x.end === scope.end
      && binderKey(x.binder) === binderKey(binder))) return;
    st.scoped.push({ name, binder, start: scope.start, end: scope.end });
    st.added += 1;
  };
  const addMember = (st: FileState, obj: string, prop: string, binder: Binder, scope = FILE_SCOPE): void => {
    if (st.members.some((x) => x.obj === obj && x.prop === prop && x.start === scope.start && x.end === scope.end
      && binderKey(x.binder) === binderKey(binder))) return;
    st.members.push({ obj, prop, binder, start: scope.start, end: scope.end });
    st.added += 1;
  };
  // Innermost scope wins, so a `block` parameter of one function is not read as
  // the `block` parameter of another.
  const narrowest = <T extends { start: number; end: number }>(candidates: T[], pos: number): T | null => {
    let best: T | null = null;
    for (const c of candidates) {
      if (pos < c.start || pos > c.end) continue;
      if (!best || (c.end - c.start) < (best.end - best.start)) best = c;
    }
    return best;
  };
  const lookup = (st: FileState, name: string, pos: number): Binder | null =>
    narrowest(st.scoped.filter((b) => b.name === name), pos)?.binder ?? null;
  const lookupMember = (st: FileState, obj: string, prop: string, pos: number): Binder | null =>
    narrowest(st.members.filter((b) => b.obj === obj && b.prop === prop), pos)?.binder ?? null;

  // Is this expression a skill-block assembler value?
  const binderOf = (st: FileState, node: ts.Expression, pos: number): Binder | null => {
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) return lookup(st, expression.text, pos);
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      return lookupMember(st, expression.expression.text, expression.name.text, pos);
    }
    // `makeSkillBlock(pluginRoot)(…)` — the inner call yields a raw assembler
    // with no name bound to it at all (session-start.ts does exactly this).
    if (ts.isCallExpression(expression)) {
      const inner = unwrap(expression.expression);
      if (ts.isIdentifier(inner) && st.factoryNames.has(inner.text)) return { kind: 'raw' };
    }
    return null;
  };

  type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  const scopeOf = (fn: FunctionLike): Scope => ({ start: fn.pos, end: fn.end });
  const returnedExpression = (fn: FunctionLike): ts.Expression | null => {
    if (!fn.body) return null;
    if (!ts.isBlock(fn.body)) return fn.body;
    for (const statement of fn.body.statements) if (ts.isReturnStatement(statement) && statement.expression) return statement.expression;
    return null;
  };
  const parameterIndex = (fn: FunctionLike, name: string): number =>
    fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
  const enclosingScope = (node: ts.Node): Scope => {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      if (ts.isFunctionDeclaration(current) || ts.isArrowFunction(current) || ts.isFunctionExpression(current)
        || ts.isMethodDeclaration(current)) return { start: current.pos, end: current.end };
    }
    return FILE_SCOPE;
  };

  // A function value that forwards its parameter #k as the block NAME is itself
  // an assembler. Which parameter carries the name — and which the fallback —
  // is read off the forwarding call, never assumed.
  const binderFromFunction = (st: FileState, fn: FunctionLike): Binder | null => {
    const body = returnedExpression(fn);
    if (!body) return null;
    const call = unwrap(body);
    if (!ts.isCallExpression(call)) return null;
    const callee = binderOf(st, call.expression, call.pos);
    if (!callee) return null;
    let moduleId: string;
    let nameArg: ts.Expression | undefined;
    let fallbackArg: ts.Expression | undefined;
    if (callee.kind === 'raw') {
      const mod = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
      if (!mod || !ts.isStringLiteralLike(mod)) return null;
      moduleId = mod.text; nameArg = call.arguments[1]; fallbackArg = call.arguments[3];
    } else {
      moduleId = callee.moduleId;
      nameArg = call.arguments[callee.nameIndex];
      fallbackArg = callee.fallbackIndex === null ? undefined : call.arguments[callee.fallbackIndex];
    }
    const name = nameArg ? unwrap(nameArg) : undefined;
    if (!name || !ts.isIdentifier(name)) return null;
    const nameIndex = parameterIndex(fn, name.text);
    if (nameIndex < 0) return null;
    const fallback = fallbackArg ? unwrap(fallbackArg) : undefined;
    const fallbackIndex = fallback && ts.isIdentifier(fallback) ? parameterIndex(fn, fallback.text) : -1;
    st.passThrough.add(call);
    return { kind: 'bound', moduleId, nameIndex, fallbackIndex: fallbackIndex >= 0 ? fallbackIndex : null };
  };

  const findDeclaration = (st: FileState, name: string): FunctionLike | null => {
    let found: FunctionLike | null = null;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) { found = node; return; }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
        const init = unwrap(node.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) { found = init; return; }
      }
      ts.forEachChild(node, visit);
    };
    visit(st.src);
    return found;
  };
  // A callee identifier → the (file, function) it names, across one re-export hop.
  const resolveCallee = (st: FileState, expr: ts.Expression): { st: FileState; fn: FunctionLike } | null => {
    const callee = unwrap(expr);
    if (!ts.isIdentifier(callee)) return null;
    const info = st.imports.get(callee.text);
    if (!info) {
      const local = findDeclaration(st, callee.text);
      return local ? { st, fn: local } : null;
    }
    const target = info.file ? states.get(info.file) : undefined;
    if (!target) return null;
    const direct = findDeclaration(target, info.name);
    if (direct) return { st: target, fn: direct };
    const hop = target.reExports.get(info.name);
    const hopState = hop ? states.get(hop.file) : undefined;
    if (!hopState) return null;
    const hopped = findDeclaration(hopState, hop!.name);
    return hopped ? { st: hopState, fn: hopped } : null;
  };
  // A binder exported from `file` under `name`, following re-export hops. This
  // is what makes `import { block } from './handler-prose'` visible.
  const exportedBinderOf = (file: string, name: string, seen = new Set<string>()): Binder | null => {
    const st = states.get(file);
    if (!st) return null;
    const key = `${file}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const reExport = st.reExports.get(name);
    if (reExport && reExport.file !== file) return exportedBinderOf(reExport.file, reExport.name, seen);
    const local = reExport ? reExport.name : name;
    if (st.exportedNames.has(name) || reExport) {
      const hit = st.scoped.find((b) => b.name === local && b.start === FILE_SCOPE.start);
      if (hit) return hit.binder;
    }
    const star = st.reExports.get('*');
    return star ? exportedBinderOf(star.file, name, seen) : null;
  };

  const propagate = (st: FileState): void => {
    for (const [local, info] of st.imports) {
      if (!info.file || st.factoryNames.has(local)) continue;
      const imported = exportedBinderOf(info.file, info.name);
      if (imported) addScoped(st, local, imported);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = unwrap(node.initializer);
        if (ts.isIdentifier(node.name)) {
          const name = node.name.text;
          const calleeName = ts.isCallExpression(init) ? unwrap(init.expression) : null;
          if (calleeName && ts.isIdentifier(calleeName) && st.factoryNames.has(calleeName.text)) {
            addScoped(st, name, { kind: 'raw' });
          } else if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            const binder = binderFromFunction(st, init);
            if (binder) addScoped(st, name, binder);
          } else if (ts.isCallExpression(init)) {
            // A factory call: `makePlanBlock(makeSkillBlock(pluginRoot))`. The
            // factory's own parameter is bound raw first (below, via the
            // argument walk), then its returned arrow is read like any other.
            const target = resolveCallee(st, init.expression);
            const returned = target ? returnedExpression(target.fn) : null;
            const fn = returned ? unwrap(returned) : null;
            if (target && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
              const binder = binderFromFunction(target.st, fn);
              if (binder) addScoped(st, name, binder);
            }
          } else {
            const binder = binderOf(st, init, node.pos);
            if (binder) addScoped(st, name, binder);
          }
        }
        // `const { block } = args` — destructuring an options object that was
        // handed an assembler by its caller.
        if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(unwrap(node.initializer))) {
          const objectName = (unwrap(node.initializer) as ts.Identifier).text;
          for (const element of node.name.elements) {
            const property = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : (ts.isIdentifier(element.name) ? element.name.text : null);
            if (!property || !ts.isIdentifier(element.name)) continue;
            const binder = lookupMember(st, objectName, property, node.pos);
            if (binder) addScoped(st, element.name.text, binder, enclosingScope(node));
          }
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        const binder = binderFromFunction(st, node);
        if (binder) addScoped(st, node.name.text, binder);
      }
      // Interprocedural: an assembler handed to another function, positionally
      // (`planStaticViolations(…, block)`) or inside an options object
      // (`runIdPathViolation({ …, block })`). Without this the 99 plan-guard
      // sites in plan-static / plan-readiness / plan-runteam / plan-runid are
      // invisible, and plan-guard — the module with 83 of the repo's blocks —
      // would be the one this guard could not see.
      if (ts.isCallExpression(node)) {
        const target = resolveCallee(st, node.expression);
        if (target) {
          node.arguments.forEach((argument, index) => {
            const parameter = target.fn.parameters[index];
            if (!parameter) return;
            const direct = binderOf(st, argument, node.pos);
            if (direct) {
              if (ts.isIdentifier(parameter.name)) addScoped(target.st, parameter.name.text, direct, scopeOf(target.fn));
              return;
            }
            const object = unwrap(argument);
            if (!ts.isObjectLiteralExpression(object)) return;
            for (const property of object.properties) {
              let propertyName: string | null = null;
              let value: ts.Expression | null = null;
              if (ts.isShorthandPropertyAssignment(property)) { propertyName = property.name.text; value = property.name; }
              else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
                propertyName = property.name.text; value = property.initializer;
              }
              if (!propertyName || !value) continue;
              const binder = binderOf(st, value, node.pos);
              if (!binder) continue;
              if (ts.isIdentifier(parameter.name)) {
                addMember(target.st, parameter.name.text, propertyName, binder, scopeOf(target.fn));
              } else if (ts.isObjectBindingPattern(parameter.name)) {
                for (const element of parameter.name.elements) {
                  const from = element.propertyName && ts.isIdentifier(element.propertyName)
                    ? element.propertyName.text
                    : (ts.isIdentifier(element.name) ? element.name.text : null);
                  if (from === propertyName && ts.isIdentifier(element.name)) {
                    addScoped(target.st, element.name.text, binder, scopeOf(target.fn));
                  }
                }
              }
            }
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(st.src);
  };

  // Run to a fixpoint: an assembler can be threaded through several hops
  // (plan-write → plan-readiness → completion), and a binding can be declared
  // after its use in source order. Bounded; terminates as soon as a pass adds
  // nothing.
  for (let pass = 0; pass < 16; pass += 1) {
    let changed = 0;
    for (const st of states.values()) { st.added = 0; propagate(st); changed += st.added; }
    if (changed === 0) break;
  }

  // A block NAME expression → the set of names it can render. Deliberately
  // small: a literal, a ternary of literals, or an identifier with exactly ONE
  // const initializer in the file (exactly one, so a shadowed name is never
  // guessed at). Anything else is reported as unresolvable rather than skipped.
  const resolveNames = (expr: ts.Expression | undefined, src: ts.SourceFile, depth = 0): string[] | null => {
    if (!expr || depth > 4) return null;
    const expression = unwrap(expr);
    if (ts.isStringLiteralLike(expression)) return [expression.text];
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = resolveNames(expression.whenTrue, src, depth + 1);
      const whenFalse = resolveNames(expression.whenFalse, src, depth + 1);
      return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
    }
    if (ts.isIdentifier(expression)) {
      const initializers: ts.Expression[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
          && node.name.text === expression.text && node.initializer) initializers.push(node.initializer);
        ts.forEachChild(node, visit);
      };
      visit(src);
      return initializers.length === 1 ? resolveNames(initializers[0], src, depth + 1) : null;
    }
    return null;
  };

  // ── the fallback COOKER ─────────────────────────────────────────────────────
  // The parity bar below compares the shipped T1BLOCK against the verbatim
  // fallback, so it needs the fallback's VALUE. `.getText()` on the node cannot
  // supply it: a single-quoted literal and a template literal spell an embedded
  // backtick differently, and that one asymmetry alone would report every
  // plan-guard pair as drifted. So each supported literal shape is evaluated,
  // and `${expr}` is kept as source text — which is exactly the form a
  // `{{VAR}}` substitutes to, since the vars a call site passes are named by
  // their initializer text.
  const shapes = new Map<ts.Node, string>();
  const cook = (st: FileState, expr: ts.Expression | undefined, depth = 0): string | null => {
    if (!expr || depth > 6) return null;
    const e = unwrap(expr);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      shapes.set(expr, ts.isStringLiteral(e) ? 'string-literal' : 'template-plain');
      return e.text;
    }
    if (ts.isTemplateExpression(e)) {
      shapes.set(expr, 'template-interpolated');
      let out = e.head.text;
      for (const span of e.templateSpans) {
        out += `\${${span.expression.getText(st.src)}}`;
        out += span.literal.text;
      }
      return out;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = cook(st, e.left, depth + 1);
      const right = cook(st, e.right, depth + 1);
      shapes.set(expr, 'concat');
      return left === null || right === null ? null : left + right;
    }
    if (ts.isIdentifier(e)) {
      // Exactly ONE initializer, in this file or across one import hop, for the
      // same reason resolveNames insists on one: a shadowed name is never
      // guessed at.
      const local: ts.Expression[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
          && node.name.text === e.text && node.initializer) local.push(node.initializer);
        ts.forEachChild(node, visit);
      };
      visit(st.src);
      if (local.length === 1) {
        const cooked = cook(st, local[0], depth + 1);
        shapes.set(expr, `const:${e.text}`);
        return cooked;
      }
      const imported = st.imports.get(e.text);
      const targetState = imported?.file ? states.get(imported.file) : undefined;
      if (targetState) {
        const found: ts.Expression[] = [];
        const visitImported = (node: ts.Node): void => {
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
            && node.name.text === imported!.name && node.initializer) found.push(node.initializer);
          ts.forEachChild(node, visitImported);
        };
        visitImported(targetState.src);
        if (found.length === 1) {
          const cooked = cook(targetState, found[0], depth + 1);
          shapes.set(expr, `imported-const:${e.text}`);
          return cooked;
        }
      }
      shapes.set(expr, `unresolved-identifier:${e.text}`);
      return null;
    }
    if (ts.isConditionalExpression(e)) { shapes.set(expr, 'conditional'); return null; }
    if (ts.isCallExpression(e)) { shapes.set(expr, `call:${unwrap(e.expression).getText(st.src)}`); return null; }
    shapes.set(expr, ts.SyntaxKind[e.kind]);
    return null;
  };

  // The vars object literal a call site passes, by name. Which argument carries
  // it is not assumed: the three argument orders in this repo disagree, so the
  // first object literal argument is the vars bag by construction (no other
  // object literal is passed to an assembler).
  const varsOf = (st: FileState, node: ts.CallExpression): Record<string, string> | null => {
    for (const argument of node.arguments) {
      const value = unwrap(argument);
      if (!ts.isObjectLiteralExpression(value)) continue;
      const out: Record<string, string> = {};
      for (const property of value.properties) {
        if (ts.isPropertyAssignment(property)
          && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
          out[property.name.text] = property.initializer.getText(st.src);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          out[property.name.text] = property.name.text;
        } else if (ts.isSpreadAssignment(property)) {
          out['\u2026spread'] = property.expression.getText(st.src);
        }
      }
      return out;
    }
    return null;
  };

  const sites: BlockCallSite[] = [];
  for (const st of states.values()) {
    const relFile = path.relative(root, st.file);
    const lineAt = (node: ts.Node): number => st.src.getLineAndCharacterOfPosition(node.getStart(st.src)).line + 1;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && !st.passThrough.has(node)) {
        const binder = binderOf(st, node.expression, node.pos);
        if (binder) {
          const fallbackIndex = binder.kind === 'raw' ? 3 : binder.fallbackIndex;
          const nameExpr = node.arguments[binder.kind === 'raw' ? 1 : binder.nameIndex];
          const fallbackExpr = fallbackIndex === null ? undefined : node.arguments[fallbackIndex];
          const moduleArg = node.arguments[0] ? unwrap(node.arguments[0]) : undefined;
          const moduleId = binder.kind === 'raw'
            ? (moduleArg && ts.isStringLiteralLike(moduleArg) ? moduleArg.text : null)
            : binder.moduleId;
          const calleeExpr = unwrap(node.expression);
          const callee = ts.isIdentifier(calleeExpr) ? calleeExpr.text
            : (ts.isPropertyAccessExpression(calleeExpr) ? calleeExpr.getText(st.src) : 'makeSkillBlock(…)(…)');
          const fallback = fallbackExpr ? unwrap(fallbackExpr) : undefined;
          sites.push({
            relFile, line: lineAt(node), callee, moduleId,
            names: resolveNames(nameExpr, st.src),
            literal: Boolean(nameExpr && ts.isStringLiteralLike(unwrap(nameExpr))),
            // An explicitly-empty fallback is no fallback: it renders `''` too.
            hasFallback: Boolean(fallbackExpr) && !(fallback && ts.isStringLiteralLike(fallback) && fallback.text === ''),
            fallbackCooked: fallbackExpr ? cook(st, fallbackExpr) : null,
            fallbackShape: fallbackExpr ? (shapes.get(fallbackExpr) ?? 'none') : 'none',
            vars: varsOf(st, node),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(st.src);
  }

  // Module discovery is a directory listing, never a hand-written list: any
  // src/modules/<id>/skill/SKILL.md is in the population from the moment it
  // lands, with no edit to this file.
  const modulesDir = path.join(srcRoot, 'modules');
  let moduleDirs: fs.Dirent[] = [];
  try { moduleDirs = fs.readdirSync(modulesDir, { withFileTypes: true }); } catch { moduleDirs = []; }
  const modules = moduleDirs
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(modulesDir, entry.name, 'skill', 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
  const blocksByModule = new Map<string, ReadonlySet<string>>();
  const skillTextByModule = new Map<string, string>();
  for (const id of modules) {
    const text = fs.readFileSync(path.join(modulesDir, id, 'skill', 'SKILL.md'), 'utf8');
    skillTextByModule.set(id, text);
    const declared = new Set<string>();
    for (const match of text.matchAll(/<!-- T1BLOCK:BEGIN (\S+) -->/g)) {
      // Confirm through the production extractor, so a BEGIN without its END
      // (which resolves to the fallback at runtime) is not counted as present.
      if (extractBlock(text, match[1]!) !== null) declared.add(match[1]!);
    }
    blocksByModule.set(id, declared);
  }

  return { root, modules, blocksByModule, skillTextByModule, sites, fileCount: files.length };
}

const CENSUS = scanRoot(REPO_ROOT);

// ── declared exemptions ──────────────────────────────────────────────────────
// Block names that are referenced WITH a verbatim fallback and have no T1BLOCK.
// They render their TS prose, so enforcement and the reason both survive — but
// SKILL.md is not their source of truth, and that has to be visible rather than
// discovered. Pinned as an exact set in both directions: an unlisted one fails
// here, and so does authoring a listed one into SKILL.md without deleting its
// line. The set was eight, then three, and is now two; it grows only with a
// reason beside it.
// Six of the original eight were authored into plan-guard/skill/SKILL.md as
// byte-exact transcriptions of their TS fallbacks (`${expr}` → `{{VAR}}` over
// the vars the call site already passes). Four of the six did not move the
// rendered deny by a byte; the last two — `run-team-quick-fix-contract` and
// `architecture-input-owner-gate` — had their PROSE fixed first (each prescribed
// an action its own addressee could not take, and the first also dropped the
// `TARGETS` var its call site passes), and were then transcribed, so their cells
// moved deliberately and are measured in
// modules/plan-guard/__tests__/skill-fallback-parity.test.ts.
// The SEVENTH was reset-record-owner-gate, and it stood here for a different
// reason from the two below: COORDINATION, not structure. Its prose was
// authorable as it stood — no runtime-composed clause, no second call site, no
// vars — and the only thing holding it was that the round which added the gate
// did not own plan-guard/skill/SKILL.md. It is transcribed now. Transcribing it
// took one edit its entry did not anticipate: the fallback was the only one of
// these written as a SINGLE-QUOTED string, and the parity test compares against a
// template-literal body, so the two could not be compared byte for byte until the
// call site became a template literal (50 backticks escaped, `\'` unescaped, the
// round trip asserted to reproduce the prose exactly).
// The two that remain are each here for a STRUCTURAL reason, not for want of
// effort — transcribing either as it stands would ship a WORSE deny than the TS
// fallback renders today:
//
//   run-artifact-work-unit-gate — the fallback ends in a three-valued clause
//     built in TS (`unresolvedNote`: settled ledger / illegible ledger /
//     neither) that is NOT among the vars the call site passes. A single
//     T1BLOCK collapses those three renders into one, which is exactly the
//     "illegible ledger reads like a healthy run" defect that clause exists to
//     fix. Authorable only together with a `{{NOTE}}` var at the call site —
//     the idiom `run-team-not-subagent` already uses for `{{RECOVERY}}`.
//   run-team-maintenance-contract — ONE name, TWO call sites
//     (plan-runteam.ts, the no-bounded-scope arm and the not-in-subagent arm)
//     with different CAUSE and different REMEDY. One block renders both arms
//     identically; splitting the stem into vars leaves a block that is mostly
//     placeholders and reviewable by nobody. Needs two block names first.
const TS_ONLY_PROSE: readonly string[] = [
  'plan-guard :: run-artifact-work-unit-gate',
  'plan-guard :: run-team-maintenance-contract',
];

// Blocks a SKILL.md DECLARES that no call site renders. Nothing used to look in
// this direction — the conformance test walks call sites, so a block with no
// call site is invisible to it, and both of these have been shipping unread.
// Neither is safe to delete on sight, which is why they are pinned with a
// disposition rather than swept:
//
//   architecture-assignment-gate — reads like the missing ARM of
//     `architecture-contract-gate`, which is currently one name serving four
//     distinct refusals from plan-readiness/index.ts with four per-site
//     fallbacks (BLOCK_WITH_PER_SITE_FALLBACKS, below). Splitting that name is
//     already the recommended fix; this block is a destination for one of the
//     arms, not dead prose.
//   run-team-unexpected — a defensive catch-all ("this is a gate bug — please
//     report") whose call site in plan-runteam.ts is gone. Delete it with the
//     evidence that the fall-through it covered is gone too, or restore the arm.
//
// No block name in this repo is built dynamically (UNRESOLVABLE_NAME_SITES is
// empty and the resolved+exempt==total assertion below keeps it that way), so
// "unreferenced" here means unreferenced, not merely unresolvable by parse.
const ORPHAN_BLOCKS: readonly string[] = [
  // Kept in SKILL.md / the fallback table; unused on the success path after
  // first-spawn materialization falls through instead of teaching via deny.
  'agent-model :: agent-materialization-deny',
  // Converted from deny-for-retry to allow+context after a successful
  // rematerialize; catalog id and T1BLOCK kept, call site removed.
  'onboarding-gate :: repaired-materialization',
  // First wait is allowed + the link is injected via setupLinkNudge. The
  // deny-to-teach-post-first path (and these T1BLOCKs) retired: SessionStart
  // + UserPromptSubmit already carry the wizard URL; a denied wait is a
  // user-visible Error. Catalog ids stay in deny-ids.ts as UNREACHED.
  'onboarding-gate :: claude-wait-link-first',
  'onboarding-gate :: codex-wait-link-first',
  'onboarding-gate :: cursor-wait-link-first',
  'plan-guard :: architecture-assignment-gate',
  'plan-guard :: run-team-unexpected',
];

// Call sites whose block name the parse cannot resolve to a literal set. EMPTY
// today: the three non-literal sites in the repo all pick between two named
// blocks with a ternary, and are resolved to BOTH. Kept as a declared list
// rather than a silent skip, because the assertion below requires
// resolved + exempt == total: a site cannot leave the population quietly.
const UNRESOLVABLE_NAME_SITES: readonly string[] = [];

// ── what replaced the fallback-less allowlist, and why that is not a relaxation ─
// This file used to pin, as an exact 33-entry set, every (file, module, block)
// triple whose call site passed no verbatim fallback — a proxy for "sites that
// would render `''` if their SKILL.md went away". The proxy is gone, replaced
// by the invariant it was standing in for: 'every block a call site can render
// resolves to prose with no filesystem read', asserted below against the
// GENERATED table for all 179 sites.
//
// The replacement is strictly stronger in three ways, and weaker in none:
//   - it checks what actually renders on a torn install (the generated body),
//     not merely that SOME literal was typed at the call site;
//   - it covers the ~145 sites that DO pass a fallback, which the allowlist
//     never looked at;
//   - it is an equality against the empty set, not against a 33-line roster
//     that has to be maintained by hand.
// And the allowlist had turned anti-correlated with the goal, the same defect
// its own comment recorded about the count floor it replaced: now that the
// generated table serves a fallback-less site, DELETING a redundant call-site
// literal is the improvement — and it grew that list by one line every time.

// ── the parity bar: "every gate keeps a VERBATIM deny fallback" ──────────────
// The claim in AGENTS.md is that the TS fallback is a verbatim copy of the
// T1BLOCK, so a torn install renders the same prose. Measured across the whole
// population (135 pairs = a call site that BOTH passes a fallback AND names a
// block that exists), it is true of 72. It is not "mostly true with a few typos"
// — the divergences fall into three kinds with three different meanings, and
// collapsing them into one relaxed comparison would hide the only kind that
// matters:
//
//   72  the fallback IS the block, byte for byte, once `{{VAR}}` is substituted
//       to the `${expr}` the call site passes. This is the bar.
//   31  the fallback is not a LITERAL at the call site at all — a lookup into a
//       reason table, or a `…Reason()` helper that composes several sentences.
//       There is nothing at the call site to transcribe; the prose lives in
//       another symbol. FALLBACK_NOT_A_LITERAL.
//   12  ONE block name, SEVERAL call sites, each with its OWN site-specific
//       fallback. A single generic T1BLOCK cannot be byte-identical to four
//       different fallbacks — this is a structural fact about the block, not
//       drift. BLOCK_WITH_PER_SITE_FALLBACKS.
//   18  genuine 1:1 prose divergence: one block, one fallback, different words.
//       PROSE_DIVERGED_FROM_FALLBACK. Was 20; the two agent-model pairs were
//       reconciled and their call-site copies deleted (see the list's own note).
//
// The bar is byte-identity, NOT a normalised comparison. Normalising whitespace
// or stripping backticks would silently absorb this entire class. `no-any` was
// the pair that settled it: SKILL.md shipped ``Avoid `any` — use `unknown` …``
// against a fallback reading `Avoid the any type — use unknown …`, which is how
// it and its siblings reached this list unnoticed in the first place. That pair
// has since CONVERGED — the four-sentence deny rewrite gave both sides one text
// — which is why it is no longer pinned below and why this bucket is 20 rather
// than the 22 the three kinds were first measured at. Every divergence is
// pinned BY NAME instead, and each list is an EQUALITY: a new divergence fails,
// and so does a stale pin whose pair now matches. The second half is not
// hypothetical — it is what caught the rewrite.
//
// A pinned divergence is not a defect to be fixed on sight — the two texts are
// two spellings of the same refusal and both read fine. What the pin buys is
// that the NEXT one is a test failure and not a discovery.
//
// Two agent-model entries left this list by being RESOLVED rather than
// re-pinned, and they are the argument for the generated table.
// `agent-reuse-await-codex-meta`'s transcription had drifted 400 characters
// short of its block, losing the task-name contract a replacement spawn needs;
// `architect-phase-incomplete`'s had gained two clauses the block never got.
// Neither call site carries a copy now — the shipped block is the only text,
// and shared/skill-fallbacks.generated.ts is what renders it on a torn install.
// The rest are plan-guard, whose `Block` still makes the fallback a required
// positional argument.
const PROSE_DIVERGED_FROM_FALLBACK: readonly string[] = [
  'plan-guard :: architect-memory-baseline-gate',
  'plan-guard :: architect-opencode-queue-gate',
  'plan-guard :: architect-planning-allowlist-gate',
  'plan-guard :: cross-feature-import',
  'plan-guard :: frontend-collapse-gate',
  'plan-guard :: frontend-structure-hot-gate',
  'plan-guard :: monorepo-root-flat-scaffold',
  'plan-guard :: plan-opencode-queue-gate',
  'plan-guard :: plan-opencode-queue-policy-gate',
  'plan-guard :: run-team-runtime-allowlist-gap',
  'plan-guard :: run-team-scope-conflict',
  'plan-guard :: scaffold-plan-gate',
  'plan-guard :: tester-qa-v2-gate',
  'plan-guard :: tester-stale-qa-gate',
  'plan-guard :: verification-contract-refresh-gate',
  'plan-guard :: verification-contract-scan-gate',
];

// One name, several call sites, each passing a DIFFERENT fallback. The T1BLOCK
// is a generic stem and the fallbacks are per-arm; byte-identity is not
// available to them by construction. The two `run-team-*` entries in
// TS_ONLY_PROSE are the same shape caught one step earlier — a name that needs
// splitting before it can be authored at all.
const BLOCK_WITH_PER_SITE_FALLBACKS: readonly string[] = [
  'plan-guard :: architecture-contract-gate',
  'plan-guard :: bootstrap-publication-gate',
  'plan-guard :: frontend-structure-completion-gate',
  'plan-guard :: lighthouse-claim-reconciliation-gate',
  'plan-guard :: reviewer-structure-gate',
  'plan-guard :: run-team-fallback-taken',
];

// The fallback argument is not a literal the parse can evaluate, so there is no
// text at the call site to compare. Every one is a deliberate indirection: a
// per-host/per-provider reason TABLE indexed at the call site, or a helper that
// assembles several sentences from runtime state. Pinned with its shape, so a
// fallback that becomes an inline literal (and therefore JOINS the comparable
// population) shows up here as a stale line rather than slipping in unmeasured.
const FALLBACK_NOT_A_LITERAL: readonly string[] = [
  'agent-model :: cursor-agent-type-required',
  'agent-model :: cursor-api-limit-auto-retry',
  'agent-model :: cursor-api-limit-composer-choice',
  'agent-model :: cursor-api-limit-terminal',
  'agent-model :: cursor-model-failure-generic',
  'agent-model :: cursor-model-unavailable-runtime-choice',
  'materialize :: digest-size',
  'onboarding-gate :: browser-open-denied',
  'onboarding-gate :: claude-wait-background-denied',
  'onboarding-gate :: server-bootstrap-required',
  'onboarding-gate :: server-bootstrap-required-compact',
  'onboarding-gate :: stop-setup-link-posted',
  'onboarding-gate :: stop-setup-links-shown',
  'onboarding-gate :: stop-setup-required',
  'onboarding-gate :: tech-classify-required',
  'onboarding-gate :: windsurf-server-deny-reason',
  'onboarding-gate :: windsurf-server-deny-reason-repeat',
  'plan-guard :: capability-no-implementer-gate',
  'plan-guard :: contract-self-conflict',
  'session :: authoring-write-guard',
];

// Per-module floors, from the parsed census. A module listed here that stops
// yielding call sites fails BY NAME — the failure this repo keeps re-learning
// is a population that silently shrinks to zero and reads as solved. A NEW
// module needs no line here: it is covered by the conformance assertion, which
// iterates what discovery found.
const MODULE_SITE_FLOORS: Readonly<Record<string, number>> = {
  'agent-model': 30,
  materialize: 1,
  'model-choice-gate': 2,
  'onboarding-gate': 21,
  'plan-guard': 80,
  session: 1,
};

function siteLabel(site: BlockCallSite): string {
  return `${site.relFile}:${site.line}`;
}

// file :: module :: block, with a POSIX separator so the pin above reads the
// same on every platform.
function renderLabels(site: BlockCallSite): string[] {
  const file = site.relFile.split(path.sep).join('/');
  return (site.names ?? []).map((name) => `${file} :: ${site.moduleId} :: ${name}`);
}

// ── the census itself ────────────────────────────────────────────────────────

test('the skill-block census finds the whole population, not a corner of it', () => {
  assert.ok(
    CENSUS.fileCount > 100,
    `expected well over 100 production source files under src/, found ${CENSUS.fileCount} — is the tree walk broken?`,
  );
  assert.ok(
    CENSUS.modules.length >= 6,
    `expected at least 6 modules shipping a skill/SKILL.md, discovered ${CENSUS.modules.length}`
    + ` (${CENSUS.modules.join(', ')}) — module discovery reads the filesystem, so zero means the walk broke, not that the gates were deleted`,
  );
  assert.ok(
    CENSUS.sites.length >= 150,
    `expected at least 150 skill-block call sites across src/, found ${CENSUS.sites.length} — the binder resolver or the AST walk is broken`,
  );
  const scannedFiles = new Set(CENSUS.sites.map((site) => site.relFile));
  assert.ok(
    scannedFiles.size >= 25,
    `expected call sites in at least 25 files, found ${scannedFiles.size}`,
  );

  // Every site must name a module. A raw `skillBlock(<non-literal>, …)` would
  // land here, and it would mean the pairing is unknowable by parse.
  const unpaired = CENSUS.sites.filter((site) => site.moduleId === null).map(siteLabel);
  assert.deepEqual(unpaired, [], `${unpaired.length} call site(s) do not resolve to a module id:\n  ${unpaired.join('\n  ')}`);

  // Every module id the code names must be a module that actually ships a
  // SKILL.md — a typo'd id resolves to no file at runtime, so EVERY block it
  // asks for is empty.
  const known = new Set(CENSUS.modules);
  const strangers = [...new Set(CENSUS.sites.map((site) => site.moduleId!))].filter((id) => !known.has(id)).sort();
  assert.deepEqual(
    strangers, [],
    `call sites name module id(s) with no src/modules/<id>/skill/SKILL.md: ${strangers.join(', ')}`,
  );
});

test('every module with a SKILL.md is exercised by at least its floor of call sites', () => {
  const sitesPerModule = new Map<string, number>();
  for (const site of CENSUS.sites) {
    if (site.moduleId) sitesPerModule.set(site.moduleId, (sitesPerModule.get(site.moduleId) ?? 0) + 1);
  }
  const short = Object.entries(MODULE_SITE_FLOORS)
    .filter(([id, floor]) => (sitesPerModule.get(id) ?? 0) < floor)
    .map(([id, floor]) => `${id}: found ${sitesPerModule.get(id) ?? 0}, floor ${floor}`);
  assert.deepEqual(
    short, [],
    `${short.length} module(s) yield fewer call sites than the parsed census measured — either the calls really went `
    + 'away (then lower the floor in the same commit) or the scanner has gone blind to that module\'s binding shape:\n  '
    + short.join('\n  '),
  );
  // Discovery must still see every module the floors name, or the floors above
  // are being checked against a module set that no longer contains them.
  const missingModules = Object.keys(MODULE_SITE_FLOORS).filter((id) => !CENSUS.modules.includes(id));
  assert.deepEqual(missingModules, [], `module discovery lost: ${missingModules.join(', ')}`);
});

// ── the conformance guard ────────────────────────────────────────────────────

test('every block a gate renders exists in the SKILL.md that gate reads', () => {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const site of CENSUS.sites) {
    if (!site.moduleId || !site.names) continue;
    const declared = CENSUS.blocksByModule.get(site.moduleId);
    for (const name of site.names) {
      const label = `${site.moduleId} :: ${name}`;
      if (seen.has(label)) continue;
      seen.add(label);
      if (!declared || !declared.has(name)) missing.push(label);
    }
  }
  assert.ok(seen.size >= 140, `expected at least 140 distinct module::block references, found ${seen.size}`);

  const undeclared = missing.filter((label) => !TS_ONLY_PROSE.includes(label)).sort();
  assert.deepEqual(
    undeclared, [],
    `${undeclared.length} block(s) are referenced in code but have no T1BLOCK in the SKILL.md the call site reads:\n  `
    + `${undeclared.join('\n  ')}\n`
    + 'Either restore the block under that exact name, or — if the prose is deliberately TS-only and the call site '
    + 'passes a verbatim fallback — add it to TS_ONLY_PROSE with that reason.',
  );
  // The exemption list and the measured set must be EQUAL, not merely
  // overlapping: a stale line here is an exemption that stopped exempting
  // anything, and it would mask the next real one.
  const stale = TS_ONLY_PROSE.filter((label) => !missing.includes(label));
  assert.deepEqual(
    stale, [],
    `${stale.length} TS_ONLY_PROSE entr(ies) no longer name a missing block — the T1BLOCK exists now, so delete the line:\n  `
    + stale.join('\n  '),
  );
});

test('a block rendered with NO verbatim fallback is a live empty-reason risk and must exist', () => {
  const bare = CENSUS.sites.filter((site) => !site.hasFallback);
  const defects: string[] = [];
  for (const site of bare) {
    if (!site.moduleId || !site.names) continue;
    const declared = CENSUS.blocksByModule.get(site.moduleId);
    for (const name of site.names) {
      if (!declared || !declared.has(name)) defects.push(`${siteLabel(site)} — ${site.moduleId} :: ${name}`);
    }
  }
  assert.deepEqual(
    defects.sort(), [],
    `${defects.length} call site(s) render an EMPTY reason today: the block is absent from the SKILL.md and the site `
    + `passes no verbatim fallback, so the agent is refused and told nothing:\n  ${defects.join('\n  ')}`,
  );
});

test('a declared block that no call site renders is pinned, not silently shipped', () => {
  const referenced = new Set<string>();
  for (const site of CENSUS.sites) {
    for (const name of site.names ?? []) if (site.moduleId) referenced.add(`${site.moduleId} :: ${name}`);
  }
  const orphans: string[] = [];
  for (const [moduleId, names] of CENSUS.blocksByModule) {
    for (const name of names) if (!referenced.has(`${moduleId} :: ${name}`)) orphans.push(`${moduleId} :: ${name}`);
  }
  assert.ok(referenced.size >= 140, `expected 140+ referenced ids, found ${referenced.size} — the census is empty`);
  assert.deepEqual(
    orphans.sort(), [...ORPHAN_BLOCKS].sort(),
    'the set of declared-but-unrendered blocks moved. A NEW one is either prose written for a call site that was '
    + 'never added, or a call site that was deleted and left its paragraph behind — both ship as dead weight and '
    + 'both are now in the generated fallback table. One that LEFT got its call site, so delete its line here.',
  );
});

// The whole point of the generated table, asserted where the call-site census
// lives. `makeSkillBlock` resolves live block → generated table → call-site
// fallback, and the first of those needs a readable SKILL.md under a plugin
// root this process was HANDED. The other two do not, so this is the assertion
// that no gate can be reduced to silence by a bad root, a partial rsync or a
// plugin sync caught mid-swap.
test('every block a call site can render resolves to prose with no filesystem read', () => {
  const silent: string[] = [];
  const tableless = new Set<string>();
  let checked = 0;
  for (const site of CENSUS.sites) {
    if (!site.moduleId || !site.names) continue;
    for (const name of site.names) {
      checked += 1;
      if (generatedFallback(site.moduleId, name) !== null) continue;
      tableless.add(`${site.moduleId} :: ${name}`);
      if (!site.hasFallback) silent.push(`${siteLabel(site)} — ${site.moduleId} :: ${name}`);
    }
  }
  assert.ok(checked >= 150, `expected 150+ (site, block) renders to check, saw ${checked} — the census is empty`);

  assert.deepEqual(
    silent.sort(), [],
    `${silent.length} call site(s) render NOTHING on an install whose skill trees cannot be read: the block has no `
    + 'entry in shared/skill-fallbacks.generated.ts (so it exists in no SKILL.md) and the site passes no verbatim '
    + `fallback either. The agent is refused and told nothing:\n  ${silent.join('\n  ')}`,
  );

  // The exception set, as an equality. These are the ids whose prose is TS-only,
  // so the generated table cannot carry them and the call-site argument is
  // load-bearing rather than redundant. A THIRD one has to be justified here,
  // and one that gets authored into a SKILL.md has to have its line deleted.
  assert.deepEqual(
    [...tableless].sort(), [...TS_ONLY_PROSE].sort(),
    'the set of rendered ids with no generated prose moved. A new one means a block was renamed or deleted without '
    + 'its call site following; one that left is now in a SKILL.md, so delete its TS_ONLY_PROSE line.',
  );
});

// ── the parity comparison ────────────────────────────────────────────────────

interface ParityPair {
  readonly key: string;
  readonly site: BlockCallSite;
  /** The block body with `{{VAR}}` substituted to the `${expr}` the call site
   *  passes for it — the form the fallback is written in. */
  readonly expected: string;
  /** The block body untouched. `skillBlock` runs applyVars over the FALLBACK as
   *  well as over the block, so a fallback that carries `{{VAR}}` verbatim
   *  renders identically too; both spellings satisfy the bar. */
  readonly body: string;
  readonly actual: string | null;
}

function parityPairs(census: Census): ParityPair[] {
  const out: ParityPair[] = [];
  for (const site of census.sites) {
    if (!site.moduleId || !site.names || !site.hasFallback) continue;
    const text = census.skillTextByModule.get(site.moduleId);
    if (text === undefined) continue;
    for (const name of site.names) {
      const body = extractBlock(text, name);
      if (body === null) continue;
      const vars = site.vars ?? {};
      let expected = body;
      for (const [varName, expression] of Object.entries(vars)) {
        expected = expected.split(`{{${varName}}}`).join(`\${${expression}}`);
      }
      out.push({ key: `${site.moduleId} :: ${name}`, site, expected, body, actual: site.fallbackCooked });
    }
  }
  return out;
}

const matchesBar = (pair: ParityPair): boolean => pair.actual === pair.expected || pair.actual === pair.body;

test('the verbatim-fallback claim holds byte for byte, or the pair is pinned by name', () => {
  const pairs = parityPairs(CENSUS);
  assert.ok(
    pairs.length >= 130,
    `expected at least 130 comparable (block, fallback) pairs, found ${pairs.length} — the cooker or the extractor broke`,
  );

  // A name with several call sites passing DIFFERENT fallbacks cannot be
  // byte-identical to all of them. Measured, then required to EQUAL the list, so
  // a new one is a failure and a name that gets split into per-arm blocks
  // forces its line to be deleted.
  const byKey = new Map<string, ParityPair[]>();
  for (const pair of pairs) byKey.set(pair.key, [...(byKey.get(pair.key) ?? []), pair]);
  const perSite = [...byKey.entries()]
    .filter(([, group]) => new Set(group.map((pair) => pair.actual)).size > 1)
    .map(([key]) => key).sort();
  assert.deepEqual(
    perSite, [...BLOCK_WITH_PER_SITE_FALLBACKS].sort(),
    'the set of block names whose call sites pass DIFFERENT fallbacks moved. A new one means one T1BLOCK is now being '
    + 'asked to stand in for several distinct refusals — give each arm its own block name, or add it here with the '
    + 'reason. A name that left means it can be compared now, so delete its line.',
  );

  const notLiteral = [...new Set(pairs.filter((pair) => pair.actual === null).map((pair) => pair.key))].sort();
  assert.deepEqual(
    notLiteral, [...FALLBACK_NOT_A_LITERAL].sort(),
    'the set of fallbacks that are not literals at the call site moved. A NEW one leaves the parity population '
    + 'unmeasured — inline the prose, or add it here. One that LEFT is now comparable, so delete its line and let the '
    + 'bar hold it:\n  '
    + `found: ${notLiteral.join(', ')}`,
  );

  // The bar. Byte-identity, with no normalisation of whitespace, backticks or
  // hole spelling: each of those relaxations was measured to absorb real
  // rewordings.
  const comparable = pairs.filter((pair) => pair.actual !== null
    && !BLOCK_WITH_PER_SITE_FALLBACKS.includes(pair.key));
  const diverged = [...new Set(comparable.filter((pair) => !matchesBar(pair)).map((pair) => pair.key))].sort();

  const unpinned = diverged.filter((key) => !PROSE_DIVERGED_FROM_FALLBACK.includes(key));
  assert.deepEqual(
    unpinned, [],
    `${unpinned.length} deny paragraph(s) DRIFTED between skill/SKILL.md and the verbatim TS fallback. SKILL.md is `
    + 'what ships and what the operator reviews; the fallback is what renders when SKILL.md cannot be read, and an '
    + 'agent must not be refused with two different reasons. Apply the edit to both. If the divergence is deliberate '
    + 'and benign, add the name to PROSE_DIVERGED_FROM_FALLBACK — never relax the comparison, because that admits the '
    + `next real drift silently:\n  ${unpinned.map((key) => {
      const pair = comparable.find((candidate) => candidate.key === key)!;
      return `${key} (${siteLabel(pair.site)})\n      SKILL.md: ${JSON.stringify(pair.expected)}\n      TS      : ${JSON.stringify(pair.actual)}`;
    }).join('\n  ')}`,
  );

  // Equality, not containment, and against the MEASURED divergence set rather
  // than "is it still in the population": an entry that names a pair which now
  // matches, a pair that moved into one of the two lists above, or nothing at
  // all, is a line that has stopped exempting anything.
  const stale = PROSE_DIVERGED_FROM_FALLBACK.filter((key) => !diverged.includes(key));
  assert.deepEqual(
    stale, [],
    `${stale.length} PROSE_DIVERGED_FROM_FALLBACK entr(ies) name nothing that diverges — the pair matches now (or the `
    + `name is gone), so delete the line in the same change. A stale pin masks the next real drift:\n  ${stale.join('\n  ')}`,
  );

  // Non-vacuity from the other side: the bar must be PASSED by a large majority,
  // or the comparison is answering "everything differs" and the pins above are
  // doing all the work.
  const passing = comparable.filter(matchesBar);
  assert.ok(
    passing.length >= 60,
    `only ${passing.length} of ${comparable.length} comparable pairs are byte-identical — a comparison that almost `
    + 'nothing passes is measuring the comparison, not the prose',
  );
});

test('the parity comparison detects a one-word divergence in a tree it has never seen', () => {
  // The real assertions above are pinned equalities, so they cannot show that
  // the COMPARATOR works — a cooker that returned the block body for every
  // fallback would pass them all. These fixtures drive the same code over a
  // synthetic tree: identical prose must compare equal, and a single changed
  // word must not.
  const handler = (fallback: string): string =>
    `${PRELUDE}export const g = () => skillBlock('fx', 'a', {}, ${fallback});\n`;

  withSyntheticRoot({
    'src/modules/fx/skill/SKILL.md': FIXTURE_SKILL('a'),
    'src/modules/fx/handler.ts': handler("'prose'"),
  }, (root) => {
    const pairs = parityPairs(scanRoot(root));
    assert.equal(pairs.length, 1, 'precondition: one comparable pair');
    assert.equal(pairs[0]!.actual, 'prose', 'the fallback literal was cooked to its value');
    assert.equal(matchesBar(pairs[0]!), true, 'identical prose passes the bar');
  });

  withSyntheticRoot({
    'src/modules/fx/skill/SKILL.md': FIXTURE_SKILL('a'),
    'src/modules/fx/handler.ts': handler("'prose.'"),
  }, (root) => {
    const pairs = parityPairs(scanRoot(root));
    assert.equal(pairs.length, 1);
    assert.equal(matchesBar(pairs[0]!), false, 'one added character is a divergence, not a rounding error');
  });

  // A backtick spelled in a single-quoted literal and in a template literal is
  // the same rendered character. If the cooker used `.getText()` this pair would
  // read as drifted, and 26 plan-guard pairs would need a pin they do not
  // deserve.
  withSyntheticRoot({
    'src/modules/fx/skill/SKILL.md': '---\nname: fixture\n---\n\n'
      + '<!-- T1BLOCK:BEGIN a -->\nAvoid `any` here.\n<!-- T1BLOCK:END a -->\n',
    'src/modules/fx/handler.ts': handler('`Avoid \\`any\\` here.`'),
  }, (root) => {
    const pairs = parityPairs(scanRoot(root));
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.actual, 'Avoid `any` here.', 'the template literal cooked to its VALUE, not its source');
    assert.equal(matchesBar(pairs[0]!), true);
  });

  // And the `{{VAR}}` → `${expr}` substitution is real: the block carries the
  // placeholder, the fallback interpolates the expression the call site names
  // for it, and the two are the same pair.
  withSyntheticRoot({
    'src/modules/fx/skill/SKILL.md': '---\nname: fixture\n---\n\n'
      + '<!-- T1BLOCK:BEGIN a -->\nTarget: {{TARGET}}.\n<!-- T1BLOCK:END a -->\n',
    'src/modules/fx/handler.ts': `${PRELUDE}declare const filePath: string;\n`
      + "export const g = () => skillBlock('fx', 'a', { TARGET: filePath }, `Target: ${filePath}.`);\n",
  }, (root) => {
    const pairs = parityPairs(scanRoot(root));
    assert.equal(pairs.length, 1);
    assert.deepEqual(pairs[0]!.site.vars, { TARGET: 'filePath' }, 'the vars bag was read off the call');
    assert.equal(matchesBar(pairs[0]!), true, 'the placeholder and the interpolation are the same hole');
    assert.equal(pairs[0]!.expected, 'Target: ${filePath}.');
  });
});

test('a block name the parse cannot resolve is declared, never silently skipped', () => {
  const unresolvable = CENSUS.sites.filter((site) => site.names === null).map(siteLabel).sort();
  assert.deepEqual(
    unresolvable, [...UNRESOLVABLE_NAME_SITES].sort(),
    'a call site computes its block name in a way this parse cannot follow. Either give it a literal (or a ternary of '
    + 'literals, which IS followed), or add it to UNRESOLVABLE_NAME_SITES with the reason — the covered set plus the '
    + 'exemptions must account for every parsed site, so a name cannot leave the population unnoticed.',
  );
  // Non-vacuity for the resolver: the repo really does compute block names
  // conditionally, and each of those sites must yield MORE than one name. If
  // this drops to zero the ternary arm of resolveNames is dead code and a
  // future dynamic site would be silently under-covered rather than caught.
  const computed = CENSUS.sites.filter((site) => !site.literal && site.names && site.names.length > 1);
  assert.ok(
    computed.length >= 3,
    `expected at least 3 sites whose block name is computed and resolved to several names, found ${computed.length}`,
  );
  const total = CENSUS.sites.length;
  const resolved = CENSUS.sites.filter((site) => site.names !== null).length;
  assert.equal(
    resolved + unresolvable.length, total,
    `the census must partition: ${resolved} resolved + ${unresolvable.length} exempt != ${total} parsed`,
  );
});

// ── the pairing, which is the trap ───────────────────────────────────────────

test('a call site is paired with the SKILL.md its binder names, not with its own directory', () => {
  // The five files that would be compared against the WRONG SKILL.md by any
  // generalisation keyed on the directory a call sits in. Pinned by name
  // because this is the specific way a coverage test passes while measuring
  // nothing: onboarding-gate's blocks all exist, so comparing them against
  // plan-guard's or session's file would report "missing" — and comparing
  // plan-guard's own blocks against them would too. Silence here is the bug.
  const crossModule = CENSUS.sites.filter((site) => {
    const owner = site.relFile.split(path.sep)[2]; // src/modules/<id>/…
    return site.relFile.startsWith(`src${path.sep}modules${path.sep}`) && owner !== site.moduleId;
  });
  const files = [...new Set(crossModule.map((site) => site.relFile))].sort();
  assert.ok(
    files.length >= 5,
    `expected at least 5 files whose block calls read a DIFFERENT module's SKILL.md, found ${files.length}: ${files.join(', ')}`,
  );
  assert.ok(
    crossModule.some((site) => site.relFile.includes(`plan-guard${path.sep}`) && site.moduleId === 'onboarding-gate'),
    'plan-guard/build-orchestration-directive.ts binds its `block` to onboarding-gate — the canary for directory-keyed pairing',
  );
  // And every one of those cross-module names must resolve in the file the
  // binder actually names, which is what the conformance test above asserts.
  for (const site of crossModule) {
    const declared = CENSUS.blocksByModule.get(site.moduleId!);
    for (const name of site.names ?? []) {
      assert.ok(declared?.has(name), `${siteLabel(site)} reads ${site.moduleId} :: ${name}`);
    }
  }
});

// ── discovery: a NEW module is covered with no edit to this file ─────────────
// The property under test is that the module list comes off the filesystem. The
// fixture is a real temporary tree rather than an in-memory overlay, so the
// directory walk, the SKILL.md lookup and the specifier resolution all run for
// real — an overlay would let the walk stay broken and still pass.

function withSyntheticRoot(
  files: Readonly<Record<string, string>>,
  run: (root: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w8c-skill-block-'));
  try {
    const write = (rel: string, text: string): void => {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
    };
    // A stand-in for the real origin: the resolver has to REACH it for anything
    // in the fixture to be recognised as an assembler at all.
    write(ORIGIN_REL, 'export function makeSkillBlock(resolve: () => string) {\n'
      + '  return (m: string, n: string, v?: unknown, f = \'\') => `${m}${n}${String(v)}${f}`;\n}\n');
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const FIXTURE_SKILL = (name: string): string =>
  `---\nname: fixture\n---\n\n<!-- T1BLOCK:BEGIN ${name} -->\nprose\n<!-- T1BLOCK:END ${name} -->\n`;

test('a module that ships a SKILL.md and a block call is covered with no edit to this file', () => {
  withSyntheticRoot({
    'src/modules/brand-new-gate/skill/SKILL.md': FIXTURE_SKILL('present-block'),
    'src/modules/brand-new-gate/handler.ts':
      "import { makeSkillBlock } from '../../shared/skill-block';\n"
      + 'const skillBlock = makeSkillBlock(() => process.cwd());\n'
      + "const block = (name: string, vars: Record<string, string> = {}, fallback = ''): string =>\n"
      + "  skillBlock('brand-new-gate', name, vars, fallback);\n"
      + "export const ok = () => block('present-block');\n"
      + "export const bad = () => block('absent-block');\n",
  }, (root) => {
    const census = scanRoot(root);
    assert.deepEqual(census.modules, ['brand-new-gate'], 'the module was DISCOVERED, not listed');
    assert.equal(census.sites.length, 2, 'both call sites found through the bound arrow');
    const declared = census.blocksByModule.get('brand-new-gate')!;
    const missing = census.sites
      .flatMap((site) => (site.names ?? []).map((name) => ({ site, name })))
      .filter((entry) => !declared.has(entry.name));
    assert.deepEqual(missing.map((entry) => entry.name), ['absent-block'],
      'the unmatched block in a module this file has never heard of is reported');
    // …and it is the LOUD severity, because the call passes no fallback.
    assert.equal(missing[0]!.site.hasFallback, false);
  });
});

test('discovery that finds nothing fails a floor rather than passing vacuously', () => {
  withSyntheticRoot({}, (root) => {
    const census = scanRoot(root);
    assert.equal(census.modules.length, 0, 'precondition: nothing to discover');
    assert.equal(census.sites.length, 0, 'precondition: nothing to scan');
    // The real assertions are floors, so an empty census is a FAILURE, not a
    // silent pass. Proven by running the same predicates the tests above run.
    assert.equal(census.modules.length >= 6, false, 'the module floor would fail');
    assert.equal(census.sites.length >= 150, false, 'the site floor would fail');
    // The prose-resolution assertion is an EQUALITY against TS_ONLY_PROSE, so an
    // empty census fails it from the other side rather than passing with an
    // empty defect list. That is the property a count floor never had: a floor
    // is satisfied by having MORE vulnerable sites.
    const rendered = census.sites.flatMap((site) => (site.names ?? []).map((name) => `${site.moduleId} :: ${name}`));
    assert.deepEqual(rendered, [], 'precondition: nothing measured');
    assert.notDeepEqual(
      rendered.sort(), [...TS_ONLY_PROSE].sort(),
      'an empty census must not satisfy the tableless-ids equality, or the assertion passes on a broken scanner',
    );
  });
});

// ── scanner coverage: the shapes an assembler is reached through ─────────────
// Each row is one binding shape this repo actually writes. The regex this file
// replaced yielded ZERO sites for rows 3–6, and rows 3 and 4 alone account for
// 99 of the 174 real sites.

interface ShapeCase {
  readonly label: string;
  readonly files: Readonly<Record<string, string>>;
  readonly expected: readonly string[];
  readonly expectFallback?: boolean;
}

const PRELUDE = "import { makeSkillBlock } from '../../shared/skill-block';\n"
  + 'const skillBlock = makeSkillBlock(() => process.cwd());\n';

const SHAPE_CASES: readonly ShapeCase[] = [
  {
    label: 'raw SkillBlockFn — skillBlock(module, name, vars, fallback)',
    expected: ['a'],
    expectFallback: true,
    files: {
      'src/modules/fx/handler.ts': `${PRELUDE}export const g = () => skillBlock('fx', 'a', {}, 'FB');\n`,
    },
  },
  {
    label: 'raw applied inline — makeSkillBlock(root)(module, name, …)',
    expected: ['a'],
    files: {
      'src/modules/fx/handler.ts': "import { makeSkillBlock } from '../../shared/skill-block';\n"
        + "export const g = () => makeSkillBlock(() => '.')('fx', 'a', {});\n",
    },
  },
  {
    label: 'bound arrow — const block = (name, vars, fallback) => skillBlock(module, …)',
    expected: ['a'],
    files: {
      'src/modules/fx/handler.ts': `${PRELUDE}`
        + "const block = (name: string, vars: Record<string, string> = {}, fallback = ''): string =>\n"
        + "  skillBlock('fx', name, vars, fallback);\n"
        + "export const g = () => block('a');\n",
    },
  },
  {
    label: 'assembler passed POSITIONALLY into another function',
    expected: ['a'],
    files: {
      'src/modules/fx/rules.ts': 'type B = (n: string, f: string) => string;\n'
        + "export function rules(block: B): string { return block('a', 'FB'); }\n",
      'src/modules/fx/handler.ts': `${PRELUDE}`
        + "const block = (name: string, fallback: string): string => skillBlock('fx', name, {}, fallback);\n"
        + "import { rules } from './rules';\nexport const g = () => rules(block);\n",
    },
    expectFallback: true,
  },
  {
    label: 'assembler passed inside an OPTIONS OBJECT, then destructured',
    expected: ['a'],
    files: {
      'src/modules/fx/rules.ts': 'type B = (n: string, f: string) => string;\n'
        + "export function rules(args: { block: B }): string { const { block } = args; return block('a', 'FB'); }\n",
      'src/modules/fx/handler.ts': `${PRELUDE}`
        + "const block = (name: string, fallback: string): string => skillBlock('fx', name, {}, fallback);\n"
        + "import { rules } from './rules';\nexport const g = () => rules({ block });\n",
    },
    expectFallback: true,
  },
  {
    label: 'assembler read straight off the options object — args.block(…)',
    expected: ['a'],
    files: {
      'src/modules/fx/rules.ts': 'type B = (n: string, f: string) => string;\n'
        + "export function rules(args: { block: B }): string { return args.block('a', 'FB'); }\n",
      'src/modules/fx/handler.ts': `${PRELUDE}`
        + "const block = (name: string, fallback: string): string => skillBlock('fx', name, {}, fallback);\n"
        + "import { rules } from './rules';\nexport const g = () => rules({ block });\n",
    },
    expectFallback: true,
  },
  {
    label: 'assembler EXPORTED by one file and imported by another',
    expected: ['a'],
    files: {
      'src/modules/fx/prose.ts': `${PRELUDE}`
        + "export const block = (name: string, vars: Record<string, string> = {}, fallback = ''): string =>\n"
        + "  skillBlock('fx', name, vars, fallback);\n",
      'src/modules/fx/handler.ts': "import { block } from './prose';\nexport const g = () => block('a');\n",
    },
  },
  {
    label: 'factory in another file — makePlanBlock(skillBlock), argument order SWAPPED',
    expected: ['a'],
    expectFallback: true,
    files: {
      'src/modules/fx/static.ts': "import type { SkillBlockFn } from './kinds';\n"
        + 'export function makeBlock(skillBlock: SkillBlockFn) {\n'
        + "  return (name: string, fallback: string, vars: Record<string, string> = {}) => skillBlock('fx', name, vars, fallback);\n}\n",
      'src/modules/fx/kinds.ts': 'export type SkillBlockFn = (m: string, n: string, v?: unknown, f?: string) => string;\n',
      'src/modules/fx/handler.ts': `${PRELUDE}import { makeBlock } from './static';\n`
        + "const block = makeBlock(skillBlock);\nexport const g = () => block('a', 'FB');\n",
    },
  },
  {
    label: 'a wrapper around a bound assembler — the plan-write violation recorder',
    expected: ['a'],
    expectFallback: true,
    files: {
      'src/modules/fx/handler.ts': `${PRELUDE}`
        + "const raw = (name: string, fallback: string): string => skillBlock('fx', name, {}, fallback);\n"
        + 'function wrap(seen: { hit: string | null }) {\n'
        + '  return (name: string, fallback: string): string => { if (!seen.hit) seen.hit = name; return raw(name, fallback); };\n}\n'
        + "const block = wrap({ hit: null });\nexport const g = () => block('a', 'FB');\n",
    },
  },
  {
    label: 'a computed name — ternary of two literals resolves to BOTH',
    expected: ['a', 'b'],
    files: {
      'src/modules/fx/handler.ts': `${PRELUDE}declare const flag: boolean;\n`
        + "const block = (name: string, vars: Record<string, string> = {}): string => skillBlock('fx', name, vars);\n"
        + "const picked = flag ? 'a' : 'b';\nexport const g = () => block(picked);\n",
    },
  },
];

test('the scanner reaches the assembler through every binding shape this repo writes', () => {
  for (const shapeCase of SHAPE_CASES) {
    withSyntheticRoot({ 'src/modules/fx/skill/SKILL.md': FIXTURE_SKILL('a'), ...shapeCase.files }, (root) => {
      const census = scanRoot(root);
      const names = census.sites.flatMap((site) => site.names ?? ['<unresolved>']).sort();
      assert.deepEqual(names, [...shapeCase.expected].sort(), `${shapeCase.label}: block names found`);
      for (const site of census.sites) {
        assert.equal(site.moduleId, 'fx', `${shapeCase.label}: module id is read from the binder`);
        if (shapeCase.expectFallback !== undefined) {
          assert.equal(site.hasFallback, shapeCase.expectFallback, `${shapeCase.label}: fallback slot`);
        }
      }
    });
  }
});

test('the scanner ignores lookalikes that are not skill-block assemblers', () => {
  const cases: ReadonlyArray<{ label: string; files: Readonly<Record<string, string>> }> = [
    {
      label: 'a local block() helper that never touches makeSkillBlock',
      files: {
        'src/modules/fx/handler.ts': 'const block = (name: string): string => `X: ${name}`;\n'
          + "export const g = () => block('a');\n",
      },
    },
    {
      label: 'block( inside a string or template literal',
      files: {
        'src/modules/fx/handler.ts': "export const shim = `const block = (n) => block('a');`;\n"
          + 'export const other = "block(\'a\')";\n',
      },
    },
    {
      label: 'a same-named export from an unrelated module',
      files: {
        'src/modules/fx/prose.ts': 'export const block = (name: string): string => name;\n',
        'src/modules/fx/handler.ts': "import { block } from './prose';\nexport const g = () => block('a');\n",
      },
    },
    {
      label: 'a member call on an object that carries no assembler',
      files: {
        'src/modules/fx/handler.ts': `${PRELUDE}`
          + "const other = { block: (n: string) => n };\nexport const g = () => other.block('a');\n",
      },
    },
  ];
  for (const lookalike of cases) {
    withSyntheticRoot({ 'src/modules/fx/skill/SKILL.md': FIXTURE_SKILL('a'), ...lookalike.files }, (root) => {
      const census = scanRoot(root);
      assert.equal(census.sites.length, 0, `${lookalike.label}: expected 0 sites, found ${census.sites.length}`);
    });
  }
});

test('an unterminated T1BLOCK counts as ABSENT, the way the runtime reads it', () => {
  // extractBlock returns null when the END marker is missing, so the gate
  // renders its fallback. A BEGIN-only fence must therefore not satisfy the
  // conformance test — counting markers by regex alone would let it.
  withSyntheticRoot({
    'src/modules/fx/skill/SKILL.md': '---\nname: fixture\n---\n\n<!-- T1BLOCK:BEGIN a -->\nprose but no end marker\n',
    'src/modules/fx/handler.ts': `${PRELUDE}export const g = () => skillBlock('fx', 'a', {});\n`,
  }, (root) => {
    const census = scanRoot(root);
    assert.equal(census.blocksByModule.get('fx')!.has('a'), false, 'a BEGIN without an END is not a usable block');
    assert.equal(census.sites.length, 1);
    assert.equal(census.sites[0]!.hasFallback, false, 'and this site would render the empty string');
  });
});
