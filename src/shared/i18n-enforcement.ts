// Dependency-free i18n enforcement shared by write/completion gates and the
// OpenCode post-apply verifier. It deliberately reports source occurrences,
// never a file-wide "i18n exists, therefore pass" signal.

import * as fs from 'fs';
import * as path from 'path';

import type { CapabilityProfileV1 } from './capabilities';
import {
  moduleOutputVariants,
  profileUsesReactI18n,
  type CompiledArchitectureV1,
  type CompiledI18nCatalogV1,
  type CompiledI18nContractV1,
} from './architecture-contract';
import { lexicalMask } from './collapsed-source';

export type I18nEnforcementFindingId =
  | 'STRUCT_I18N_RUNTIME'
  | 'STRUCT_HARDCODED_COPY'
  | 'STRUCT_I18N_REACT_TRANS'
  | 'STRUCT_I18N_CATALOG';

export interface I18nEnforcementFinding {
  id: I18nEnforcementFindingId;
  file: string;
  line?: number;
  message: string;
  /**
   * True for the parity classes whose truth spans the namespace's locale PAIR
   * (key missing in a sibling locale / extra key vs the source locale). A role
   * cannot write two catalog files atomically, so every legitimate
   * intermediate state trips one of these (observed 13cl: ~8 denies including
   * a perfect oscillation on one key — "en has extra key" → counterpart write
   * denied → "en is missing key"). The write-time hot gate banks these as
   * warnings in the quality ledger instead of denying; the completion scan
   * still blocks on them, and the single-file classes (unparseable JSON, empty
   * catalog, empty values) keep denying at write time.
   */
  crossLocaleParity?: boolean;
}

export interface I18nReference {
  namespace: string;
  key: string;
  line: number;
  /**
   * The literal source-language children of the `<Trans>` that made this
   * reference, when there is one. This is the DECLARED source copy, which is
   * what makes seeding a missing catalog key deterministic (i18n-seed.ts);
   * `t()` references carry no fallback and are never seedable.
   */
  fallback?: string;
}

export interface I18nSourceAnalysis {
  findings: I18nEnforcementFinding[];
  references: I18nReference[];
}

export const I18N_SOURCE_RE = /\.(?:tsx?|jsx?|vue|svelte|astro|html|blade\.php|swift|kt|dart)$/i;
// Files that may legally contain JSX. `.ts`/`.js` may not — TypeScript rejects
// JSX outside `.tsx` — so element-shaped text there is a generic type argument.
const JSX_CAPABLE_RE = /\.(?:tsx|jsx)$/i;
// Plain script files: no markup children, only `t()` references worth reading.
const SCRIPT_ONLY_RE = /\.(?:ts|js|mjs|cjs)$/i;
export const I18N_CATALOG_RE = /\.(?:json|php|xlf|xcstrings|xml|arb)$/i;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function normalizeDisplayText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function visibleLiteral(value: string): boolean {
  const normalized = normalizeDisplayText(value);
  return /[\p{L}]/u.test(normalized) && normalized.length > 1;
}

function exactBrand(value: string, brands: readonly string[]): boolean {
  const normalized = normalizeDisplayText(value);
  return brands.some((brand) => normalized === normalizeDisplayText(brand));
}

function tagName(raw: string): string {
  return /^<\/?\s*([A-Za-z][\w.:/-]*)/.exec(raw)?.[1] || '';
}

function literalAttribute(raw: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`).exec(raw);
  return match?.[2] ?? null;
}

function translatableLiteralAttributes(
  raw: string,
): Array<{ name: string; value: string; offset: number }> {
  const out: Array<{ name: string; value: string; offset: number }> = [];
  const re = /\b(placeholder|aria-label|alt|title|label|accessibilityLabel|accessibilityHint|children)\s*=\s*(["'])([\s\S]*?)\2/g;
  for (let match = re.exec(raw); match; match = re.exec(raw)) {
    out.push({ name: match[1]!, value: match[3]!, offset: match.index });
  }
  return out;
}

function fileTranslationNamespace(text: string): string {
  return /\buseTranslation\s*\(\s*(['"])([^'"]+)\1/.exec(text)?.[2] || 'common';
}

function addTReferences(text: string, namespace: string, references: I18nReference[]): void {
  const re = /(?:^|[^\w])t\s*\(\s*(['"])([^'"]+)\1/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const rawKey = match[2]!;
    const split = /^([^:]+):(.+)$/.exec(rawKey);
    references.push({
      namespace: split?.[1] || namespace,
      key: split?.[2] || rawKey,
      line: lineAt(text, match.index),
    });
  }
}

// `<Course[]>` in `useState<Course[]>([])` matches every shape test for a JSX
// opening tag, so a generic type argument opened an element and the code that
// followed was collected as rendered child text. `useState<T[]>` is the most
// common idiom in React+TypeScript, so this denied ordinary components.
//
// The discriminator is position, and it is exact: JSX only appears where an
// EXPRESSION may start — after `(`, `{`, `}`, `>`, `,`, an operator, a keyword
// plus whitespace, or at the beginning of the file. A generic type argument
// only appears glued to the identifier it parameterises (`useState<`,
// `Promise<`, `Array<`, `.from<`). So a `<` immediately preceded by an
// identifier character is a type argument, never a tag.
//
// Two further shapes opened a tag that is not one, and both are answered by the
// same two extra tests:
//   - `const html = "<p>Welcome</p>"` — a `<` inside a string literal. `syntax`
//     (string bodies blanked) says whether the character is code at all.
//   - `<T,>(x: T) => x`, the generic-arrow idiom. A JSX tag name is followed by
//     whitespace, `>` or `/`; `,` (and `[` in `<Course[]>`) never follows one.
//
// The preceding-character rule does NOT apply to a CLOSING tag inside an open
// element: `<h2>Traffic One</h2>` ends on a letter, so `</h2>` failed the test
// and the child token came out as `"Traffic One</h2>"`. Two consequences, both
// bad: the brand no longer compared equal to itself, and — because the element
// was never popped — a `<Trans>` closed that way stayed on the stack for the
// rest of the FILE, silently absorbing every later child text as its own
// fallback. Depth-gating keeps ordinary `a < /re/.test(x)` code untouched.
function jsxTagAt(text: string, syntax: string, index: number, jsxDepth: number): boolean {
  if (syntax[index] !== '<') return false;
  const ahead = text.slice(index);
  if (/^(?:<>|<\/>)/.test(ahead)) return true;
  if (!/^<\/?[A-Za-z][A-Za-z0-9_.:-]*(?:[\s/>]|$)/.test(ahead)) return false;
  if (jsxDepth > 0 && ahead.startsWith('</')) return true;
  const previous = index > 0 ? text[index - 1]! : '';
  return !/[\w$]/.test(previous);
}

function jsxTokens(text: string, syntax: string): Array<{ token: string; index: number }> {
  const tokens: Array<{ token: string; index: number }> = [];
  let index = 0;
  let jsxDepth = 0;
  while (index < text.length) {
    const start = index;
    const opener = text[index];
    const jsxExpression = opener === '{' && syntax[index] === '{' && jsxDepth > 0;
    const jsxTag = opener === '<' && jsxTagAt(text, syntax, index, jsxDepth);
    if (!jsxTag && !jsxExpression) {
      index += 1;
      while (index < text.length) {
        const candidate = text[index];
        if (candidate === '<' && jsxTagAt(text, syntax, index, jsxDepth)) break;
        if (candidate === '{' && syntax[index] === '{' && jsxDepth > 0) break;
        index += 1;
      }
      tokens.push({ token: text.slice(start, index), index: start });
      continue;
    }
    const closer = jsxTag ? '>' : '}';
    let braces = jsxExpression ? 1 : 0;
    let quote: string | null = null;
    index += 1;
    while (index < text.length) {
      const ch = text[index]!;
      if (quote) {
        if (ch === '\\') index += 2;
        else {
          if (ch === quote) quote = null;
          index += 1;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        index += 1;
        continue;
      }
      if (ch === '{') braces += 1;
      else if (ch === '}') {
        braces -= 1;
        if (jsxExpression && braces === 0) {
          index += 1;
          break;
        }
      } else if (ch === closer && jsxTag && braces === 0) {
        index += 1;
        break;
      }
      index += 1;
    }
    const token = text.slice(start, index);
    tokens.push({ token, index: start });
    if (jsxTag) {
      if (/^<\//.test(token)) jsxDepth = Math.max(0, jsxDepth - 1);
      else if (!/\/\s*>$/.test(token)) jsxDepth += 1;
    }
  }
  return tokens;
}

function reactSourceAnalysis(
  file: string,
  text: string,
  i18n: CompiledI18nContractV1 | undefined,
): I18nSourceAnalysis {
  const findings: I18nEnforcementFinding[] = [];
  const references: I18nReference[] = [];
  const brands = i18n?.literalBrands || [];
  // Comment bodies are blanked (offsets and newlines preserved, so every
  // reported line still points at the real source): a JSDoc `@example` holding
  // `<Button>Save</Button>` is documentation, not rendered copy, and reading it
  // as hardcoded text denied files whose only sin was being documented. String
  // BODIES stay — attribute and child copy lives in them — and `syntax`, where
  // they are blanked, is what tells the tag scanner which `<` is code at all.
  const scan = lexicalMask(text, false);
  const syntax = lexicalMask(text, true);
  const namespace = fileTranslationNamespace(scan);
  addTReferences(scan, namespace, references);
  // JSX child-text analysis is only valid where JSX itself is valid. TypeScript
  // REJECTS JSX in `.ts` (it is `.tsx` or nothing), so every "element" found in
  // a .ts file is really a generic type argument — `Promise<Course[]>` opens a
  // `<Course[]>` tag and the code that follows reads as rendered child text.
  // Two generics in one file were enough to deny a plain backend service with
  // STRUCT_HARDCODED_COPY on a line holding nothing but a closing brace.
  // `t()` references are collected above and stay available to catalog
  // validation, which is the part that IS meaningful in a .ts file.
  if (!JSX_CAPABLE_RE.test(file)) return { findings, references };
  if (!/<\/?[A-Za-z][^>]*>/.test(scan)) return { findings, references };

  type StackEntry = {
    name: string;
    trans: boolean;
    fallback: boolean;
    line: number;
    // The reference this <Trans> pushed, so its literal children can be
    // recorded as the reference's declared source-language fallback.
    reference?: I18nReference;
  };
  const stack: StackEntry[] = [];
  for (const { token, index } of jsxTokens(scan, syntax)) {
    if (token.startsWith('<')) {
      const name = tagName(token);
      if (!name) continue;
      if (/^<\//.test(token)) {
        const entryIndex = stack.map((entry) => entry.name).lastIndexOf(name);
        if (entryIndex >= 0) {
          // Every entry from here down is closed — the tail entries implicitly,
          // by their parent. Judging only the first one silently dropped any
          // <Trans> that a parent closed over.
          for (const entry of stack.splice(entryIndex, stack.length - entryIndex)) {
            if (!entry.trans) continue;
            if (!entry.fallback) {
              findings.push({
                id: 'STRUCT_I18N_REACT_TRANS',
                file,
                line: entry.line,
                message: '<Trans> must contain a non-empty source-language children fallback.',
              });
            }
          }
        }
        continue;
      }

      const isTrans = name === 'Trans' || name.endsWith('.Trans');
      let transReference: I18nReference | undefined;
      if (isTrans) {
        const ns = literalAttribute(token, 'ns');
        const key = literalAttribute(token, 'i18nKey');
        if (!ns || !key) {
          findings.push({
            id: 'STRUCT_I18N_REACT_TRANS',
            file,
            line: lineAt(text, index),
            message: '<Trans> requires literal `ns` and `i18nKey` attributes.',
          });
        } else {
          transReference = { namespace: ns, key, line: lineAt(text, index) };
          references.push(transReference);
        }
      }
      for (const attr of translatableLiteralAttributes(token)) {
        if (!visibleLiteral(attr.value) || exactBrand(attr.value, brands)) continue;
        findings.push({
          id: 'STRUCT_HARDCODED_COPY',
          file,
          line: lineAt(text, index + attr.offset),
          message: attr.name === 'children'
            ? 'User-facing React `children` text is hardcoded; render a <Trans> child with ns, i18nKey, and fallback.'
            : `User-facing React \`${attr.name}\` text is hardcoded; use t() for string props/attributes.`,
        });
      }
      if (/\bchildren\s*=\s*\{\s*(?:[\w$.]+\.)?t\s*\(/.test(token)) {
        findings.push({
          id: 'STRUCT_I18N_REACT_TRANS',
          file,
          line: lineAt(text, index),
          message: 'React `children={t(...)}` is rendered child text; use a nested <Trans> element with visible fallback.',
        });
      }
      const selfClosing = /\/\s*>$/.test(token);
      if (isTrans && selfClosing) {
        findings.push({
          id: 'STRUCT_I18N_REACT_TRANS',
          file,
          line: lineAt(text, index),
          message: '<Trans> may not be self-closing; provide visible source-language fallback children.',
        });
      } else if (!selfClosing) {
        stack.push({
          name,
          trans: isTrans,
          fallback: false,
          line: lineAt(text, index),
          ...(transReference ? { reference: transReference } : {}),
        });
      }
      continue;
    }

    const insideIgnoredTag = stack.some((entry) => /^(?:script|style|code|pre)$/i.test(entry.name));
    if (insideIgnoredTag || stack.length === 0) continue;
    const transEntry = [...stack].reverse().find((entry) => entry.trans);
    if (token.startsWith('{')) {
      if (transEntry) {
        const literalFallback = /^\{\s*(["'])([\s\S]*?)\1\s*\}$/.exec(token)?.[2];
        if (literalFallback && visibleLiteral(literalFallback)) {
          transEntry.fallback = true;
          if (transEntry.reference && !transEntry.reference.fallback) {
            transEntry.reference.fallback = normalizeDisplayText(literalFallback);
          }
        }
        continue;
      }
      if (/^\{\s*(?:[\w$.]+\.)?t\s*\(/.test(token)) {
        findings.push({
          id: 'STRUCT_I18N_REACT_TRANS',
          file,
          line: lineAt(text, index),
          message: 'React rendered child text must use <Trans> with fallback; reserve t() for string props, metadata, and imperative APIs.',
        });
        continue;
      }
      const literal = /^\{\s*(["'])([\s\S]*?)\1\s*\}$/.exec(token)?.[2];
      if (literal && visibleLiteral(literal) && !exactBrand(literal, brands)) {
        findings.push({
          id: 'STRUCT_HARDCODED_COPY',
          file,
          line: lineAt(text, index),
          message: 'User-facing React child text is hardcoded; wrap it in <Trans> with ns, i18nKey, and fallback.',
        });
      }
      continue;
    }

    if (!visibleLiteral(token)) continue;
    if (transEntry) {
      transEntry.fallback = true;
      if (transEntry.reference && !transEntry.reference.fallback) {
        transEntry.reference.fallback = normalizeDisplayText(token);
      }
      continue;
    }
    if (exactBrand(token, brands)) continue;
    findings.push({
      id: 'STRUCT_HARDCODED_COPY',
      file,
      line: lineAt(text, index),
      message: 'User-facing React child text is hardcoded; wrap it in <Trans> with ns, i18nKey, and fallback.',
    });
  }
  return { findings, references };
}

// Blank the BODY of embedded code blocks so it is never read as template text,
// replacing each character with a space so every offset — and therefore every
// reported line number — is preserved.
//
// This replaces a 20-character lookbehind that could not see past the opening
// tag it was testing for: `<script>` (8 chars) was skipped correctly, but
// `<script setup lang="ts">` (23 chars) overran the window, so the code inside
// every modern Vue SFC was scanned as markup and `defineProps<{…}>` read as
// hardcoded copy. `<script setup lang="ts">` is the standard Vue 3 idiom.
function blankEmbeddedCode(text: string): string {
  return text
    .replace(
      /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      (block) => block.replace(/[^\n]/g, ' '),
    )
    // Blade directives are CODE sitting between tags, so the `>text<` rule read
    // `@include('components.Card')` as user-facing copy and denied idiomatic
    // Blade. Blanked for the same reason and in the same way as a script block:
    // it is not rendered text. `{{ }}` and `{!! !!}` already fall out of the
    // scan because the capture excludes braces.
    .replace(
      /@[A-Za-z]+(?:\s*\([^)]*\))?/g,
      (directive) => directive.replace(/[^\n]/g, ' '),
    );
}

// The app ENTRY html document (`index.html`). Its document-level metadata —
// `<title>`, `<noscript>`, `<meta>` — renders BEFORE any framework boots, so
// "use the active framework localization primitive" is unsatisfiable for it:
// the primitive does not exist yet at that point in the page lifecycle.
// Observed 13co: the mandatory vite-react `apps/web/index.html` scaffold's
// static `<title>`/`<noscript>` text tripped STRUCT_HARDCODED_COPY and blocked
// the frontend for multiple cycles on a file the contract itself requires.
const ENTRY_HTML_RE = /(?:^|\/)index\.html$/i;

// Blank ONLY the document-metadata blocks of an entry html (offsets/newlines
// preserved, same technique as blankEmbeddedCode). Everything else in the file
// — rendered body markup, attributes on body elements — stays strictly scanned.
function blankEntryHtmlDocumentMetadata(text: string): string {
  return text
    .replace(
      /<(title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      (block) => block.replace(/[^\n]/g, ' '),
    )
    .replace(/<meta\b[^>]*>/gi, (tag) => tag.replace(/[^\n]/g, ' '));
}

function markupSourceAnalysis(
  file: string,
  text: string,
  i18n: CompiledI18nContractV1 | undefined,
): I18nSourceAnalysis {
  const findings: I18nEnforcementFinding[] = [];
  // Same rule as the React path: a plain script file has no markup children, so
  // the `>text<` scan below can only misread generic type arguments. Non-React
  // profiles (Vue, Svelte, generic-web) route their .ts files here.
  if (SCRIPT_ONLY_RE.test(file)) return { findings, references: [] };
  const brands = i18n?.literalBrands || [];
  // Entry-HTML carve-out: pre-boot document metadata cannot be localized by any
  // framework primitive, so it is exempt in the ENTRY document only. All other
  // .html content — and every other element in the entry html — stays strict.
  const scannable = ENTRY_HTML_RE.test(file)
    ? blankEntryHtmlDocumentMetadata(blankEmbeddedCode(text))
    : blankEmbeddedCode(text);
  const re = />([^<>{}]+)</g;
  for (let match = re.exec(scannable); match; match = re.exec(scannable)) {
    const value = match[1]!;
    const before = scannable.slice(Math.max(0, match.index - 20), match.index);
    if (/<(?:script|style|code|pre)[^>]*$/i.test(before)) continue;
    if (!visibleLiteral(value) || exactBrand(value, brands)) continue;
    findings.push({
      id: 'STRUCT_HARDCODED_COPY',
      file,
      line: lineAt(text, match.index + 1),
      message: 'User-facing template text is hardcoded; use the active framework localization primitive.',
    });
  }
  // `(?<![:\w\-[])` excludes BINDINGS, whose value is an expression rather than
  // literal copy: Vue's `:title="t('x')"` and `v-bind:title`, Angular's
  // `[title]`, and any `data-title`. `\b` matched the name inside `:title`, so
  // the idiomatic way to localize an attribute was itself reported as hardcoded.
  const attrRe = /(?<![:\w\-[])(placeholder|aria-label|alt|title)\s*=\s*(["'])([\s\S]*?)\2/g;
  // Same blanked text: a `title:` key inside a script block is not a template
  // attribute, and reading one as user-facing copy is the same class of error.
  for (let match = attrRe.exec(scannable); match; match = attrRe.exec(scannable)) {
    const value = match[3]!;
    if (!visibleLiteral(value) || exactBrand(value, brands)) continue;
    findings.push({
      id: 'STRUCT_HARDCODED_COPY',
      file,
      line: lineAt(text, match.index),
      message: `User-facing \`${match[1]}\` text is hardcoded; use the active framework localization primitive.`,
    });
  }
  return { findings, references: [] };
}

function nativeSourceAnalysis(
  file: string,
  text: string,
  i18n: CompiledI18nContractV1 | undefined,
): I18nSourceAnalysis {
  const findings: I18nEnforcementFinding[] = [];
  const brands = i18n?.literalBrands || [];
  const patterns = file.endsWith('.swift')
    ? [/\b(?:Text|Button|navigationTitle|accessibilityLabel|accessibilityHint)\s*\(\s*"([^"]+)"/g]
    : file.endsWith('.kt')
      ? [/\b(?:Text|Button|contentDescription)\s*\(\s*(?:text\s*=\s*)?"([^"]+)"/g]
      : [/\b(?:Text|Tooltip)\s*\(\s*(['"])(.*?)\1/g];
  for (const re of patterns) {
    for (let match = re.exec(text); match; match = re.exec(text)) {
      const value = file.endsWith('.dart') ? match[2]! : match[1]!;
      if (!visibleLiteral(value) || exactBrand(value, brands)) continue;
      findings.push({
        id: 'STRUCT_HARDCODED_COPY',
        file,
        line: lineAt(text, match.index),
        message: 'User-facing native text is hardcoded; use the platform localization resource API.',
      });
    }
  }
  return { findings, references: [] };
}

// `<sharedRoot>/src/components/ui/` is defined BY THE CONTRACT as the adapter
// CLI's vendor output (the shadcn campaign's structure: `shadcn add` writes and
// OVERWRITES primitives there), so a copy/Trans finding inside it orders an
// edit the next CLI run destroys (observed 14cl: 7 of 17 consolidated findings
// were the CLI-installed breadcrumb/pagination/sidebar/spinner primitives).
// Same principle as `.prettierignore` — the verifier must skip what the owning
// tool overwrites. The root is derived from the compiled profile's uiSystem,
// never a hardcoded literal (workspace roots vary), and ONLY the `ui/` vendor
// dir is exempt: `<sharedRoot>/src/components/` siblings are role-authored
// compositions and stay fully scanned.
function vendorUiPrimitiveFile(file: string, profile: CapabilityProfileV1): boolean {
  const sharedRoot = profile.uiSystem?.sharedRoot;
  if (!sharedRoot) return false;
  const normalizedRoot = sharedRoot.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
  if (!normalizedRoot) return false;
  const normalizedFile = file.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  return normalizedFile.startsWith(`${normalizedRoot}/src/components/ui/`);
}

export function analyzeI18nSourceText(
  file: string,
  text: string,
  profile: CapabilityProfileV1,
  i18n?: CompiledI18nContractV1,
): I18nSourceAnalysis {
  if (!I18N_SOURCE_RE.test(file)) return { findings: [], references: [] };
  const analysis = profileUsesReactI18n(profile) && /\.(?:tsx?|jsx?)$/i.test(file)
    ? reactSourceAnalysis(file, text, i18n)
    : /\.(?:swift|kt|dart)$/i.test(file)
      ? nativeSourceAnalysis(file, text, i18n)
      : markupSourceAnalysis(file, text, i18n);
  // Vendor exemption applies to the copy/Trans findings only; `t()`/`<Trans>`
  // references still feed catalog validation — the keys a vendor file consumes
  // must exist regardless of who owns the file.
  if (analysis.findings.length > 0 && vendorUiPrimitiveFile(file, profile)) {
    return { findings: [], references: analysis.references };
  }
  return analysis;
}

function manifestPaths(contract?: CompiledArchitectureV1): string[] {
  const manifests = new Set(['package.json']);
  for (const root of contract?.sourceRoots || []) {
    const parts = root.replace(/\\/g, '/').split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      manifests.add(`${parts.slice(0, depth).join('/')}/package.json`);
    }
  }
  for (const output of contract?.scaffoldOutputs || []) {
    if (output.path === 'package.json' || output.path.endsWith('/package.json')) {
      manifests.add(output.path);
    }
  }
  return [...manifests];
}

const DISCOVERY_SKIP_DIRS = new Set([
  '.git',
  '.traffic-one',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
]);

function discoverProjectFiles(
  projectRoot: string,
  accept: (relative: string) => boolean,
  maxFiles = 512,
): string[] {
  const found: string[] = [];
  const pending: Array<{ absolute: string; depth: number }> = [{ absolute: projectRoot, depth: 0 }];
  while (pending.length > 0 && found.length < maxFiles) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 7 && !DISCOVERY_SKIP_DIRS.has(entry.name)) {
          pending.push({ absolute, depth: current.depth + 1 });
        }
      } else if (entry.isFile()) {
        const relative = path.relative(projectRoot, absolute).replace(/\\/g, '/');
        if (accept(relative)) found.push(relative);
      }
    }
  }
  return found.sort();
}

const I18N_DEPENDENCIES = [
  'i18next',
  'react-i18next',
  'next-intl',
  'vue-i18n',
  '@nuxtjs/i18n',
  'svelte-i18n',
  '@lingui/core',
] as const;

export function projectDeclaresI18nRuntime(
  projectRoot: string,
  contract?: CompiledArchitectureV1,
): boolean {
  let dependencyPresent = false;
  const manifests = new Set(manifestPaths(contract));
  if (!contract) {
    for (const rel of discoverProjectFiles(projectRoot, (candidate) => (
      candidate === 'package.json' || candidate.endsWith('/package.json')
    ), 96)) {
      manifests.add(rel);
    }
  }
  for (const rel of manifests) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, rel), 'utf8')) as Record<string, unknown>;
      for (const field of ['dependencies', 'devDependencies']) {
        const deps = manifest[field];
        if (deps && typeof deps === 'object' && !Array.isArray(deps)
          && I18N_DEPENDENCIES.some((name) => Object.prototype.hasOwnProperty.call(deps, name))) {
          dependencyPresent = true;
        }
      }
    } catch {
      // keep looking
    }
  }
  if (dependencyPresent) {
    return !contract?.i18n
      || contract.i18n.runtimeOutputs.every((rel) => fs.existsSync(path.join(projectRoot, rel)));
  }
  if (contract?.i18n) {
    if (profileUsesReactI18n(contract.profile)
      || ['nuxt', 'vue', 'svelte', 'sveltekit', 'generic-web'].includes(contract.profile.profileId)) {
      return false;
    }
    return [...contract.i18n.catalogs.map((catalog) => catalog.path), ...contract.i18n.runtimeOutputs]
      .every((rel) => fs.existsSync(path.join(projectRoot, rel)));
  }
  const known = [
    'Localizable.xcstrings',
    'l10n.yaml',
    'lang',
    'locales',
    'src/locales',
    'src/i18n',
    'packages/i18n',
    'app/src/main/res/values/strings.xml',
  ];
  return known.some((rel) => fs.existsSync(path.join(projectRoot, rel)))
    || discoverProjectFiles(projectRoot, (candidate) => (
      /(?:^|\/)(?:locales|messages|lang|l10n)\//i.test(candidate)
      && /\.(?:json|php|xlf|xcstrings|xml|arb)$/i.test(candidate)
    ), 1).length > 0;
}

function flattenJson(
  value: unknown,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('@')) continue;
      flattenJson(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (prefix) {
    out.set(prefix, typeof value === 'string' ? value : String(value ?? ''));
  }
  return out;
}

function catalogEntries(
  projectRoot: string,
  catalog: CompiledI18nCatalogV1,
  locale?: string,
  contentOverrides?: Readonly<Record<string, string>>,
): Map<string, string> | null {
  let text: string;
  try {
    text = Object.prototype.hasOwnProperty.call(contentOverrides || {}, catalog.path)
      ? contentOverrides![catalog.path]!
      : fs.readFileSync(path.join(projectRoot, catalog.path), 'utf8');
  } catch {
    return null;
  }
  try {
    if (catalog.format === 'json' || catalog.format === 'arb') {
      return flattenJson(JSON.parse(text) as unknown);
    }
    if (catalog.format === 'xcstrings') {
      const parsed = JSON.parse(text) as {
        strings?: Record<string, {
          localizations?: Record<string, { stringUnit?: { value?: unknown } }>;
        }>;
      };
      const entries = new Map<string, string>();
      for (const [key, value] of Object.entries(parsed.strings || {})) {
        const localized = locale ? value.localizations?.[locale]?.stringUnit?.value : undefined;
        entries.set(key, typeof localized === 'string' ? localized : '');
      }
      return entries;
    }
  } catch {
    return new Map();
  }
  const entries = new Map<string, string>();
  const patterns = catalog.format === 'xlf'
    ? [/\b(?:id|name)=["']([^"']+)["'][^>]*>[\s\S]*?<target[^>]*>([\s\S]*?)<\/target>/g]
    : catalog.format === 'php'
      ? [/["']([^"']+)["']\s*=>\s*["']([^"']*)["']/g]
      : [/<string\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/string>/g];
  for (const re of patterns) {
    for (let match = re.exec(text); match; match = re.exec(text)) {
      entries.set(match[1]!, normalizeDisplayText(match[2]!.replace(/<[^>]+>/g, '')));
    }
  }
  return entries;
}

function entriesForNamespace(
  entries: Map<string, string>,
  catalog: CompiledI18nCatalogV1,
  namespace: string,
): Map<string, string> {
  if (catalog.namespaces.length === 1) return entries;
  const out = new Map<string, string>();
  const normalizedNamespace = namespace.replace(/-/g, '_');
  for (const [key, value] of entries) {
    if (key.startsWith(`${namespace}.`)) out.set(key.slice(namespace.length + 1), value);
    else if (key.startsWith(`${namespace}_`)) out.set(key.slice(namespace.length + 1), value);
    else if (normalizedNamespace !== namespace && key.startsWith(`${normalizedNamespace}_`)) {
      out.set(key.slice(normalizedNamespace.length + 1), value);
    }
    else if (namespace === 'common' && !key.includes('.')) out.set(key, value);
  }
  return out;
}

// i18next/vue-i18n CLDR plural forms — `key_one`/`key_other` (cardinal) and
// `key_ordinal_two` … — are per-locale spellings of ONE logical key. WHICH
// categories a locale needs is CLDR data this validator does not carry
// (Romanian needs `_few`, Japanese only `_other`), so parity and reference
// resolution are judged on the logical key: a locale satisfies a plural
// family by declaring ANY of its forms, and a form another locale does not
// need is never an "extra key". The category list is the closed CLDR set —
// ground truth, not a per-scenario table.
const PLURAL_SUFFIX_RE = /_(?:ordinal_)?(?:zero|one|two|few|many|other)$/;

function pluralBase(key: string): string | null {
  return PLURAL_SUFFIX_RE.test(key) ? key.replace(PLURAL_SUFFIX_RE, '') : null;
}

/** Any non-empty form of the logical key: exact, or a CLDR plural variant. */
function pluralFamilySatisfied(entries: Map<string, string>, logicalKey: string): boolean {
  if (entries.get(logicalKey)?.trim()) return true;
  for (const [key, value] of entries) {
    if (pluralBase(key) === logicalKey && value.trim()) return true;
  }
  return false;
}

function inferredJsonNamespaces(projectRoot: string, relative: string): string[] {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(projectRoot, relative), 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ['common'];
    const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => !key.startsWith('@'));
    const nested = entries
      .filter(([, child]) => child && typeof child === 'object' && !Array.isArray(child))
      .map(([key]) => key);
    return nested.length > 0 && nested.length === entries.length ? nested : ['common'];
  } catch {
    return ['common'];
  }
}

/**
 * Best-effort existing-project catalog contract used by ad-hoc delegation.
 * It never invents outputs: every returned catalog already exists on disk.
 */
export function detectExistingI18nContract(
  projectRoot: string,
): CompiledI18nContractV1 | undefined {
  const paths = discoverProjectFiles(projectRoot, (candidate) => (
    /\.(?:json|php|xlf|xcstrings|xml|arb)$/i.test(candidate)
    && (
      /(?:^|\/)(?:i18n|locales|messages|lang|l10n)\//i.test(candidate)
      || /(?:^|\/)Localizable\.xcstrings$/i.test(candidate)
      || /(?:^|\/)res\/values[^/]*\/strings\.xml$/i.test(candidate)
    )
  ));
  const catalogs: CompiledI18nCatalogV1[] = [];
  let xcstringsSourceLocale = '';
  for (const relative of paths) {
    let match = /(?:^|\/)locales\/([^/]+)\/([^/]+)\.json$/i.exec(relative);
    if (match) {
      catalogs.push({
        path: relative,
        format: 'json',
        locales: [match[1]!],
        namespaces: [match[2]!],
      });
      continue;
    }
    match = /(?:^|\/)(?:locales|messages)\/([^/]+)\.json$/i.exec(relative);
    if (match) {
      catalogs.push({
        path: relative,
        format: 'json',
        locales: [match[1]!],
        namespaces: inferredJsonNamespaces(projectRoot, relative),
      });
      continue;
    }
    match = /(?:^|\/)lang\/([^/]+)\/([^/]+)\.php$/i.exec(relative);
    if (match) {
      catalogs.push({ path: relative, format: 'php', locales: [match[1]!], namespaces: [match[2]!] });
      continue;
    }
    match = /(?:^|\/)messages\.([A-Za-z0-9-]+)\.xlf$/i.exec(relative);
    if (match) {
      catalogs.push({ path: relative, format: 'xlf', locales: [match[1]!], namespaces: ['common'] });
      continue;
    }
    match = /(?:^|\/)app_([A-Za-z0-9_]+)\.arb$/i.exec(relative);
    if (match) {
      catalogs.push({
        path: relative,
        format: 'arb',
        locales: [match[1]!.replace(/_/g, '-')],
        namespaces: ['common'],
      });
      continue;
    }
    match = /(?:^|\/)res\/values(?:-([A-Za-z0-9-]+))?\/strings\.xml$/i.exec(relative);
    if (match) {
      const qualifier = match[1];
      const locale = qualifier
        ? qualifier.replace(/-r([A-Z]{2})$/, '-$1')
        : 'en';
      catalogs.push({ path: relative, format: 'android-xml', locales: [locale], namespaces: ['common'] });
      continue;
    }
    if (/Localizable\.xcstrings$/i.test(relative)) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, relative), 'utf8')) as {
          sourceLanguage?: string;
          strings?: Record<string, { localizations?: Record<string, unknown> }>;
        };
        xcstringsSourceLocale = raw.sourceLanguage || 'en';
        const locales = new Set<string>([xcstringsSourceLocale]);
        for (const value of Object.values(raw.strings || {})) {
          for (const locale of Object.keys(value.localizations || {})) locales.add(locale);
        }
        catalogs.push({
          path: relative,
          format: 'xcstrings',
          locales: [...locales],
          namespaces: ['common'],
        });
      } catch {
        // Invalid existing catalog is left for the normal validator once a
        // parseable contract can be inferred from another file.
      }
    }
  }
  if (catalogs.length === 0) return undefined;
  const locales = [...new Set(catalogs.flatMap((catalog) => catalog.locales))].sort();
  const namespaces = [...new Set(catalogs.flatMap((catalog) => catalog.namespaces))].sort((a, b) => (
    a === 'common' ? -1 : b === 'common' ? 1 : a.localeCompare(b)
  ));
  return {
    sourceLocale: locales.includes('en') ? 'en' : (xcstringsSourceLocale || locales[0]!),
    locales,
    literalBrands: [],
    namespaces,
    reactCatalogLayout: catalogs.some((catalog) => /\/locales\/[^/]+\/[^/]+\.json$/i.test(catalog.path)),
    catalogs,
    runtimeOutputs: [],
  };
}

export function validateI18nCatalogs(
  projectRoot: string,
  i18n: CompiledI18nContractV1,
  options: {
    references?: readonly I18nReference[];
    namespaces?: readonly string[];
    requireAllCatalogs?: boolean;
    contentOverrides?: Readonly<Record<string, string>>;
  } = {},
): I18nEnforcementFinding[] {
  const findings: I18nEnforcementFinding[] = [];
  const requiredNamespaces = new Set(options.namespaces || i18n.namespaces);
  const relevant = i18n.catalogs.filter((catalog) => (
    catalog.namespaces.some((namespace) => requiredNamespaces.has(namespace))
  ));
  const parsed = new Map<string, Map<string, string>>();
  for (const catalog of relevant) {
    let missing = false;
    for (const locale of catalog.locales) {
      const entries = catalogEntries(projectRoot, catalog, locale, options.contentOverrides);
      if (!entries) {
        missing = true;
        continue;
      }
      if (entries.size === 0) {
        findings.push({
          id: 'STRUCT_I18N_CATALOG',
          file: catalog.path,
          message: 'i18n catalog is invalid or contains no translation entries.',
        });
      }
      parsed.set(`${catalog.path}\0${locale}`, entries);
    }
    if (missing) {
      if (options.requireAllCatalogs !== false) {
        findings.push({
          id: 'STRUCT_I18N_CATALOG',
          file: catalog.path,
          message: `Required i18n catalog is missing for ${catalog.locales.join(', ')} / ${catalog.namespaces.join(', ')}.`,
        });
      }
      continue;
    }
  }

  for (const namespace of requiredNamespaces) {
    const byLocale = new Map<string, Map<string, string>>();
    for (const locale of i18n.locales) {
      const catalog = relevant.find((candidate) => (
        candidate.locales.includes(locale) && candidate.namespaces.includes(namespace)
      ));
      const entries = catalog ? parsed.get(`${catalog.path}\0${locale}`) : undefined;
      if (catalog && entries) {
        byLocale.set(locale, entriesForNamespace(entries, catalog, namespace));
      } else if (!catalog && options.requireAllCatalogs !== false) {
        findings.push({
          id: 'STRUCT_I18N_CATALOG',
          file: '<catalog>',
          message: `Required i18n catalog is missing for ${locale} / ${namespace}.`,
        });
      }
    }
    const source = byLocale.get(i18n.sourceLocale);
    if (!source) continue;
    for (const [key, value] of source) {
      if (!value.trim()) {
        const sourceCatalog = relevant.find((catalog) => (
          catalog.locales.includes(i18n.sourceLocale) && catalog.namespaces.includes(namespace)
        ));
        findings.push({
          id: 'STRUCT_I18N_CATALOG',
          file: sourceCatalog?.path || '<catalog>',
          message: `Source-locale key \`${namespace}:${key}\` has an empty value.`,
        });
      }
      const keyPluralBase = pluralBase(key);
      for (const locale of i18n.locales) {
        const localized = byLocale.get(locale);
        if (!localized) continue;
        // A plural-form source key is satisfied by the locale's OWN forms of
        // the same logical key — locales legitimately need different CLDR
        // categories, so exact-key parity would deny correct catalogs.
        if (keyPluralBase !== null && pluralFamilySatisfied(localized, keyPluralBase)) continue;
        if (!localized.has(key) || !localized.get(key)?.trim()) {
          const target = relevant.find((catalog) => (
            catalog.locales.includes(locale) && catalog.namespaces.includes(namespace)
          ));
          findings.push({
            id: 'STRUCT_I18N_CATALOG',
            file: target?.path || '<catalog>',
            message: `Locale \`${locale}\` is missing a non-empty \`${namespace}:${key}\` value required for catalog parity.`,
            crossLocaleParity: true,
          });
        }
      }
    }
    for (const [locale, localized] of byLocale) {
      for (const [key, value] of localized) {
        if (!value.trim()) {
          const target = relevant.find((catalog) => (
            catalog.locales.includes(locale) && catalog.namespaces.includes(namespace)
          ));
          findings.push({
            id: 'STRUCT_I18N_CATALOG',
            file: target?.path || '<catalog>',
            message: `Locale \`${locale}\` has an empty \`${namespace}:${key}\` value.`,
          });
        } else if (!source.has(key)) {
          // A plural form whose logical key the source locale declares (in any
          // of ITS categories) is a required per-locale spelling, not an extra.
          const base = pluralBase(key);
          if (base !== null && pluralFamilySatisfied(source, base)) continue;
          const target = relevant.find((catalog) => (
            catalog.locales.includes(locale) && catalog.namespaces.includes(namespace)
          ));
          findings.push({
            id: 'STRUCT_I18N_CATALOG',
            file: target?.path || '<catalog>',
            message: `Locale \`${locale}\` has extra key \`${namespace}:${key}\`; declared locales must have identical key sets.`,
            crossLocaleParity: true,
          });
        }
      }
    }
  }

  for (const reference of options.references || []) {
    const sourceCatalog = relevant.find((catalog) => (
      catalog.locales.includes(i18n.sourceLocale)
      && catalog.namespaces.includes(reference.namespace)
    ));
    const entries = sourceCatalog
      ? parsed.get(`${sourceCatalog.path}\0${i18n.sourceLocale}`)
      : undefined;
    const namespaced = sourceCatalog && entries
      ? entriesForNamespace(entries, sourceCatalog, reference.namespace)
      : undefined;
    // `t('ns:key', { count })` resolves to the catalog's `key_<category>`
    // forms — a plural family satisfies the bare reference key.
    if (!namespaced || !pluralFamilySatisfied(namespaced, reference.key)) {
      findings.push({
        id: 'STRUCT_I18N_CATALOG',
        file: sourceCatalog?.path || '<catalog>',
        line: reference.line,
        message: `Translation key \`${reference.namespace}:${reference.key}\` is missing or empty in the source locale catalog.`,
      });
    }
  }
  return findings;
}

export function requiredI18nNamespacesForFiles(
  contract: CompiledArchitectureV1,
  files: readonly string[],
): string[] {
  const namespaces = new Set<string>();
  for (const file of files.map((value) => value.replace(/\\/g, '/'))) {
    // Extension freedom: the file may be any allowed variant of the module.
    const module = contract.modules.find((candidate) => moduleOutputVariants(candidate).includes(file));
    if (module?.kind === 'page') {
      const route = contract.routes.find((candidate) => candidate.moduleId === module.id && !candidate.redirect);
      namespaces.add(route?.id || module.id);
    } else if (module?.kind === 'feature') {
      namespaces.add(module.id);
    } else {
      namespaces.add('common');
    }
  }
  return [...namespaces];
}
