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
  // Brace depth of each open `${…}` inside the template being masked, innermost
  // last. Without it a template holding an inner template put the backtick count
  // out of phase, the file ended inside an unterminated template, and EVERY
  // later line came back fully masked — which silently blinded both
  // `collapsedLineNumber` and `logicalLoc` for the whole remainder of the file.
  // One nested template above collapsed code was enough to bypass the gate.
  const interpolations: number[] = [];
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
      // Interpolation bodies stay masked exactly as before — only the state
      // tracking changes — so the collapse calibration is untouched. Braces
      // balance, so an inner template's own `${…}` cancels out and a nested
      // backtick needs no separate state.
      if (state === 'template') {
        const open = interpolations.length - 1;
        if (open >= 0) {
          if (current === '{') interpolations[open] = interpolations[open]! + 1;
          else if (current === '}') {
            if (interpolations[open] === 0) interpolations.pop();
            else interpolations[open] = interpolations[open]! - 1;
          }
          continue;
        }
        if (current === '$' && next === '{') {
          interpolations.push(0);
          if (maskStrings) chars[i + 1] = ' ';
          i += 1;
          continue;
        }
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
 * Collapse-resistant size measure: the max of physical non-blank lines,
 * statement count, and closing-JSX count over MASKED text. Minifying a module
 * onto a handful of lines therefore cannot shrink it below the real figure.
 *
 * Lives here, beside `lexicalMask`, because both the structural write gate and
 * the OpenCode delegation runner must reach the identical number and the runner
 * may not import from `modules/`. Step-0 previously had no size rule at all, so
 * it accepted a module the write gate then refused every edit to.
 */
export function logicalLoc(segment: string): number {
  const withoutWhitespace = segment.trim();
  if (!withoutWhitespace) return 0;
  const physical = withoutWhitespace.split(/\r?\n/).filter((line) => line.trim()).length;
  const statements = (withoutWhitespace.match(/;/g) || []).length + 1;
  const jsxNodes = (withoutWhitespace.match(/<\/[A-Za-z][^>]*>/g) || []).length;
  return Math.max(physical, statements, jsxNodes);
}

/**
 * The one numeric size threshold that BLOCKS, shared by the write gate
 * (`STRUCT_MODULE_LOC`) and the delegation runner so the two can never disagree
 * about the same file. Calibrated on 6co: `pages/Catalog.tsx` 515 logical lines,
 * next-largest module 307.
 */
export const BLOCKING_MODULE_LOC = 400;

/**
 * Blank `${…}` spans. Real collapse is unaffected — a JSX expression container
 * is `{x}`, not `${x}` — but interpolation content is not the line's own code.
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
