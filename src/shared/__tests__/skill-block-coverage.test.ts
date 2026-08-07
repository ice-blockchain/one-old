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
// A call site that passes NO verbatim fallback renders `''` when its block goes
// missing — a live empty-reason defect. A call site that passes one degrades to
// that prose instead, which is a documentation drift, not an enforcement loss.
// Both are asserted; only the first is described as a defect. plan-guard's
// assembler makes the fallback a REQUIRED positional argument, which is why its
// 8 TS-only names below are safe — and why they are pinned rather than fixed
// here: closing them means moving prose into shipped SKILL.md, which is a
// golden-snapshot change and a separate piece of work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

import { extractBlock } from '../skill-block';

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
}

interface Census {
  readonly root: string;
  readonly modules: readonly string[];
  readonly blocksByModule: ReadonlyMap<string, ReadonlySet<string>>;
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
  for (const id of modules) {
    const text = fs.readFileSync(path.join(modulesDir, id, 'skill', 'SKILL.md'), 'utf8');
    const declared = new Set<string>();
    for (const match of text.matchAll(/<!-- T1BLOCK:BEGIN (\S+) -->/g)) {
      // Confirm through the production extractor, so a BEGIN without its END
      // (which resolves to the fallback at runtime) is not counted as present.
      if (extractBlock(text, match[1]!) !== null) declared.add(match[1]!);
    }
    blocksByModule.set(id, declared);
  }

  return { root, modules, blocksByModule, sites, fileCount: files.length };
}

const CENSUS = scanRoot(REPO_ROOT);

// ── declared exemptions ──────────────────────────────────────────────────────
// Block names that are referenced WITH a verbatim fallback and have no T1BLOCK.
// They render their TS prose, so enforcement and the reason both survive — but
// SKILL.md is not their source of truth, and that has to be visible rather than
// discovered. Pinned as an exact set: a NINTH one fails here, and so does
// authoring one of these eight into SKILL.md without deleting its line.
// Deliberately NOT closed by hand-writing prose into SKILL.md — that is shipped
// bytes inside the golden snapshot and belongs to the generation work.
const TS_ONLY_PROSE: readonly string[] = [
  'plan-guard :: architecture-input-owner-gate',
  'plan-guard :: implementer-collapse-gate',
  'plan-guard :: run-artifact-work-unit-gate',
  'plan-guard :: run-id-mismatch',
  'plan-guard :: run-team-maintenance-contract',
  'plan-guard :: run-team-quick-fix-contract',
  'plan-guard :: run-team-runtime-contract-invalid',
  'plan-guard :: runtime-sidecar-owner-gate',
];

// Call sites whose block name the parse cannot resolve to a literal set. EMPTY
// today: the three non-literal sites in the repo all pick between two named
// blocks with a ternary, and are resolved to BOTH. Kept as a declared list
// rather than a silent skip, because the assertion below requires
// resolved + exempt == total: a site cannot leave the population quietly.
const UNRESOLVABLE_NAME_SITES: readonly string[] = [];

// Per-module floors, from the parsed census. A module listed here that stops
// yielding call sites fails BY NAME — the failure this repo keeps re-learning
// is a population that silently shrinks to zero and reads as solved. A NEW
// module needs no line here: it is covered by the conformance assertion, which
// iterates what discovery found.
const MODULE_SITE_FLOORS: Readonly<Record<string, number>> = {
  'agent-model': 30,
  materialize: 1,
  'model-choice-gate': 2,
  'onboarding-gate': 25,
  'plan-guard': 80,
  session: 1,
};

function siteLabel(site: BlockCallSite): string {
  return `${site.relFile}:${site.line}`;
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
  // The floor that makes the assertion below non-vacuous. Measured at 36 of
  // 174 sites; the convention in AGENTS.md says every gate carries a fallback,
  // and this is the count of the sites where it does not.
  assert.ok(
    bare.length >= 30,
    `expected at least 30 call sites passing NO verbatim fallback, found ${bare.length} — if the fallback slot moved, `
    + 'this assertion is measuring nothing',
  );
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
    assert.equal(census.sites.filter((site) => !site.hasFallback).length >= 30, false, 'the no-fallback floor would fail');
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
