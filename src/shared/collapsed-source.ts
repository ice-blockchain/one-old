// src/shared/collapsed-source.ts
// Collapsed-source detection, shared by the structural write gate
// (modules/plan-guard/react-structure) and the OpenCode delegation runner. Both
// need the same answer to "did this land as one-line code?", and the runner may
// not import from modules/, so the lexer + detector live here.

/**
 * Blank comment bodies, and optionally string/template bodies, preserving every
 * newline and offset so callers can still index into the original text.
 */
export function lexicalMask(text: string, maskStrings: boolean): string {
  const chars = [...text];
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let escaped = false;
  for (let i = 0; i < chars.length; i += 1) {
    const current = chars[i]!;
    const next = chars[i + 1] || '';
    if (state === 'line') {
      if (current === '\n') state = 'code';
      else chars[i] = ' ';
      continue;
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 1;
        state = 'code';
      } else if (current !== '\n') chars[i] = ' ';
      continue;
    }
    if (state !== 'code') {
      const closing = state === 'single' ? '\'' : state === 'double' ? '"' : '`';
      if (maskStrings && current !== '\n') chars[i] = ' ';
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === '\\') {
        escaped = true;
        continue;
      }
      if (current === closing) state = 'code';
      continue;
    }
    if (current === '/' && next === '/') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 1;
      state = 'line';
      continue;
    }
    if (current === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 1;
      state = 'block';
      continue;
    }
    if (current === '\'') {
      state = 'single';
      if (maskStrings) chars[i] = ' ';
      continue;
    }
    if (current === '"') {
      state = 'double';
      if (maskStrings) chars[i] = ' ';
      continue;
    }
    if (current === '`') {
      state = 'template';
      if (maskStrings) chars[i] = ' ';
      continue;
    }
  }
  return chars.join('');
}

// Measured on CODE characters after masking string, template, and comment
// bodies — so a 200-char Tailwind `className`, a `data:` URI, or a long message
// literal never counts, only real code does.
//
// Two arms, because the two shapes have very different natural line widths:
//   A. Packed JSX, counted by CLOSING tags only. An element that opens and
//      closes around children on one line, three times over, is packing. Self
//      closing elements are leaves and legitimately sit inline — a formatted
//      `{items.map((i) => <Route path={i.p} element={<Page />} />)}` carries two
//      of them and must stay clean.
//   B. Statement-dense code. This needs a high bar AND executable syntax on the
//      line, because a one-line TS type/interface body is legitimately
//      `;`-dense and is not collapsed code.
//
// Calibrated on real corpora: catches every collapsed 7co module (App.tsx 418
// code chars/9 signals, LearnerNavigation 453/10, CourseCard's packed JSX) with
// ZERO hits across 6co's prettier-formatted React and this plugin's own src/.
const COLLAPSED_LINE_CODE_CHARS = 140;
const COLLAPSED_JSX_CODE_CHARS = 80;
const COLLAPSED_LINE_SIGNALS = 3;
const EXECUTABLE_LINE_RE = /\bfunction\b|=>|\breturn\b/;
// Declaration/generated modules are not authored, and test files are the
// tester's own style domain.
const COLLAPSE_EXEMPT_RE =
  /\.(?:d|types|generated)\.[cm]?[jt]sx?$|\.(?:test|spec|stories?)\.[^.]+$|(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)/i;
const COLLAPSE_SOURCE_RE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;

/**
 * Blank `${…}` spans. `lexicalMask` does not track interpolation nesting, so a
 * template containing an inner template (`` `${xs.map((x) => `\`${x}\``)}` ``)
 * makes it leave template state early and report the remainder as code. Real
 * collapse is unaffected — a JSX expression container is `{x}`, not `${x}`.
 */
function blankInterpolations(line: string): string {
  if (!line.includes('${')) return line;
  let out = '';
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (depth === 0 && line[i] === '$' && line[i + 1] === '{') {
      depth = 1;
      out += '  ';
      i += 1;
      continue;
    }
    if (depth > 0) {
      if (line[i] === '{') depth += 1;
      else if (line[i] === '}') depth -= 1;
      out += ' ';
      continue;
    }
    out += line[i];
  }
  return out;
}

/** True when this path is analyzable source that collapse rules apply to. */
export function isCollapseCandidate(file: string): boolean {
  return COLLAPSE_SOURCE_RE.test(file) && !COLLAPSE_EXEMPT_RE.test(file);
}

/** 1-based line number of the first collapsed line, or null. */
export function collapsedLineNumber(file: string, text: string): number | null {
  if (!isCollapseCandidate(file)) return null;
  const lines = lexicalMask(text, true).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = blankInterpolations(lines[i]!);
    const codeChars = line.replace(/\s+/g, '').length;
    if (codeChars <= COLLAPSED_JSX_CODE_CHARS) continue;
    const statements = (line.match(/;/g) || []).length;
    const jsxClose = (line.match(/<\//g) || []).length;
    const jsx = jsxClose + (line.match(/\/>/g) || []).length;
    if (jsxClose >= COLLAPSED_LINE_SIGNALS) return i + 1;
    if (EXECUTABLE_LINE_RE.test(line)
      && statements + jsx >= COLLAPSED_LINE_SIGNALS
      && codeChars > COLLAPSED_LINE_CODE_CHARS) return i + 1;
  }
  return null;
}
