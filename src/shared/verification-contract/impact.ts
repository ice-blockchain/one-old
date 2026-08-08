// src/shared/verification-contract-impact.ts
// UI-impact derivation: the path/regex heuristics, JSX visual projection,
// planned floors, changed routes, and required checks.

import * as path from 'path';
import {
  moduleOutputVariants,
  stableContractJson,
  type ArchitectureBaselineV1,
  type CompiledArchitectureV1,
} from '../architecture-contract';
import {
  profileHasNativeUi,
  profileHasWebUi,
  type CapabilityProfileV1,
} from '../capabilities';
import { sha256 } from '../text';

import {
  type LighthouseThresholdsV1,
  type UiImpact,
} from './types';
import {
  changedHunkEvidence,
  gitTextAtBaseline,
  normalizeRel,
  safeRead,
  unique,
  type ChangedHunkEvidence,
} from './git';

const VISUAL_RE = /\.(?:css|scss|sass|less|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf)$/i;
// Extensions that MEAN markup. The file's own type is the whole evidence here,
// which is why this arm sits above the content probes and is untouched by their
// module bound — and why the vocabulary has to be COMPLETE per stack, since a
// class covered for some of its extensions is covered by whichever one a project
// happens to pick. Grouped by where the product meets each:
//   frontends it detects   tsx jsx vue svelte astro mdx marko gjs gts
//     (detection/artifacts.ts): React/Solid/Qwik/Stencil/Preact `.tsx`, Vue and
//     Nuxt `.vue`, Svelte `.svelte`, Astro `.astro`, MDX pages in Next, Astro,
//     Gatsby and Remix, Marko `.marko`, Ember/Glimmer template-tag `.gjs`/`.gts`
//   server-rendered views  blade.php php erb haml slim twig jsp jspx razor cshtml
//     (the view languages of the php, laravel, java and dotnet backends, plus
//     Rails, whose three are `.erb`, `.haml` and `.slim`)
//   template languages     html htm xhtml pug jade njk liquid ejs hbs handlebars gohtml templ
// Absent on purpose, and it is the same test in both directions — does the
// extension mean MARKUP, or merely templating?
//   `.tmpl`/`.tpl`/`.gotmpl`/`.j2`/`.jinja`/`.mustache`/`.eex`/`.vm`/`.ftl` name
//   an ENGINE, and their commonest output is not a page: Helm values, an Ansible
//   nginx.conf, a systemd unit, a codegen'd model class. `.md` is absent for the
//   mirror reason — markdown becomes a page only when a site generator says so,
//   and this repo alone holds 219 tracked `.md` paths that are documentation.
//   `.mdx` is the deliberate opposite call: it exists ONLY to be compiled into a
//   component, so its own extension is the generator's declaration.
const MARKUP_RE = /\.(?:tsx|jsx|vue|svelte|astro|mdx|marko|gjs|gts|html|htm|xhtml|pug|jade|njk|liquid|ejs|hbs|handlebars|gohtml|templ|blade\.php|php|erb|haml|slim|twig|jsp|jspx|razor|cshtml)$/i;
// The subset of MARKUP_RE whose structure is the INDENT rather than a bracket,
// so `jsxTags` finds nothing in it and the visual projection has to read lines.
// It is a whitelist, not a shape test, and that is the whole safeguard: asked of
// content, "does this look indentation-structured?" is true of every Markdown
// document, which would make each `.mdx` prose edit structural and collapse the
// discrimination that bounds reading `.mdx` as markup at all. `.marko` is here
// AND in the tag pass because it accepts both syntaxes and may mix them by line.
const INDENTED_MARKUP_RE = /\.(?:pug|jade|haml|slim|marko)$/i;
// One vocabulary, two anchors. The names are shared so the planned arm and the
// changed-path arm below cannot drift into disagreeing about what a
// presentational path is called; the ANCHOR is the whole of the difference
// between them, which is why it is the only thing spelled separately.
const PRESENTATION_NAMES = 'styles?|theme|tokens?|assets?|layout';
// A name arm, and the ONLY place a name is the whole of the available evidence:
// a scaffold output is a path the plan has not created yet, so there are no
// bytes to read and no intrinsic answer to prefer. Its `[.-]` branch claims
// filename PREFIXES too, which is affordable here because the planner NAMED
// this path — `token-report/summary.ts` is not something a plan declares as an
// output and then does not mean.
const PLANNED_VISUAL_PATH_RE = new RegExp(`(?:^|/)(?:${PRESENTATION_NAMES})(?:/|[.-])`, 'i');
// The same vocabulary asked of a path that already EXISTS, where the name is no
// longer the whole evidence and a wrong answer is expensive. THREE bounds, each
// removing a measured false-positive class rather than a hypothesised one:
//
//   - DIRECTORY SEGMENTS ONLY, no `[.-]` branch. Over this repo's 1323 tracked
//     paths the full spelling claimed 27 and every one arrived through that
//     branch — 24 token ACCOUNTING modules (`runners/token-report/**`,
//     `token-logger.ts`, `override/token.ts`) and 3 docs. As a directory
//     segment it claims ZERO. So the reason the arm was deleted wholesale — no
//     bound separates victim from beneficiary, since both are `.ts` — is true
//     of the EXTENSION and false of the ANCHOR: `styles/colors.ts` and
//     `token-logger.ts` differ in shape, not merely in spelling.
//   - WEB MODULES ONLY. A stylesheet, image or font under one of these
//     directories is already VISUAL_RE's by extension and a component is
//     MARKUP_RE's, so the paths left over are exactly the residual this exists
//     for: CSS-in-JS under a presentational directory, a `theme/tokens.ts` or
//     `styles/colors.ts`, invisible to every intrinsic probe because its bytes
//     are ordinary object literals.
//   - UNDER THE PROFILE'S OWN `sourceRoots`. The extension bound alone says
//     only "a browser COULD load this", which is not the same as "this is the
//     web app": a monorepo's `packages/cli/src/theme/colors.ts` is terminal
//     theming and answers the spelling perfectly. `sourceRoots` is the
//     project's own declaration of where its web code lives, so like
//     `profile.entrypoints` — and unlike any widening of the regex — it cannot
//     claim a sibling package that merely shares a directory name. Empty
//     `sourceRoots` disarms the arm, which is the fail-toward-not-claiming
//     direction the rest of this classifier takes.
//
// `visual` rather than `behavioral` because a design token is the one edit
// whose blast radius IS every screen at once, and no changed-hunk
// discrimination applies to a module holding no template.
//
// This corpus cannot vouch for the arm in either direction — the repo owns no
// stylesheet and no such directory, which is equally why DELETING it measured
// as free here. That silence is the reason the arm is bounded this tightly,
// not a reason to leave it out.
const PRESENTATION_DIR_RE = new RegExp(`(?:^|/)(?:${PRESENTATION_NAMES})/`, 'i');
const VISUAL_CONFIG_RE = /(?:^|\/)(?:tailwind|uno|windi)\.config\.(?:[cm]?[jt]s|ts)$/i;
const BEHAVIOR_RE = /(?:^|\/)(?:routes?|router|navigation|forms?|state|stores?|features?)(?:\/|[.-])|(?:route|router|navigation|handler|controller)\.[^.]+$/i;
// The client-side APIs that MAKE a module drive the browser, as identifiers in
// code. Every one of them is also ordinary backend vocabulary — `router` is the
// commonest identifier in Go's HTTP layer (chi, gin, mux), FastAPI spells its
// own `router = APIRouter()`, Spring WebFlux names a `router` bean — so, like
// the declaration probe below, it may only be asked of a file a browser loads.
const BEHAVIOR_CODE_RE = /\b(?:onClick|onSubmit|navigate|router|hydrateRoot|createBrowserRouter)\b/;
// `768` on its own matched any unrelated literal — a port, a byte size, an id in
// backend code — and every match forced a third viewport through the whole sweep.
// Require it to look like a breakpoint.
const TABLET_RISK_RE = /(?:tablet|breakpoint|@media|\bmd:|min-width|max-width|\b768px\b|\bmd\b\s*:\s*['"]?768)/i;
export const IMPORTANT_VISUAL_PATH_RE =
  /(?:^|\/)(?:packages\/ui|design-system|theme|tokens?|layouts?)(?:\/|[.-])|(?:^|\/)(?:globals?|app|styles?)\.(?:css|scss|sass|less)$|(?:^|\/)(?:tailwind|uno|windi)\.config\.(?:[cm]?[jt]s|ts)$/i;

// Every framework's handler-attribute syntax, not only React's. When only these
// are recognized as behavior, a handler-only edit in a Vue SFC or a Blade
// template reads as VISUAL and pays for the full three-viewport screenshot sweep
// plus Lighthouse — pure token and wall-clock cost on every non-React run.
//   React     onClick={…}          Svelte   on:click={…}
//   Vue       @click="…"  v-on:…   Alpine   x-on:click="…"  @click="…"
//   Livewire  wire:click="…"       Angular  (click)="…"
//   HTML      onclick="…"
// The plain-HTML form is the one the camelCase arm cannot reach, and it was
// stripped NOWHERE — not even in `.html`, where it is the native spelling — so
// `<button onclick="save(1)">` read `visual` while its React equivalent read
// `behavioral`. It gets its own arm rather than a relaxed `on[A-Za-z]` because
// lowercase collides with ordinary words, and every real collision found is a
// SUFFIX one: Astro's `client:only="react"`, a `data-only` attribute. A handler
// attribute is a name in its own right, never the tail of a namespaced or
// hyphenated one, which is the whole of the extra guard. A bare `only=`
// attribute would still be stripped, and that residual is accepted rather than
// papered over with a word list: it costs the screenshot sweep, never the
// browser, because an edit confined to a stripped attribute still leaves
// changed text and so still settles `behavioral`. Leaving the camelCase arm
// untouched keeps the change one-directional — nothing stripped before stops
// being.
const EVENT_ATTR_RE = new RegExp([
  '\\bon[A-Z][A-Za-z0-9_$]*\\s*=',
  '(?<![-:.])\\bon[a-z][A-Za-z0-9_$]*\\s*=',
  '\\b(?:v-on|x-on|on|wire|hx):[A-Za-z][A-Za-z0-9_.:|-]*\\s*=',
  '@[A-Za-z][A-Za-z0-9_.:-]*\\s*=',
  '\\([A-Za-z][A-Za-z0-9_.]*\\)\\s*=',
].join('|'));

// A module file a browser can load. Not evidence of anything on its own — it
// only bounds WHERE the name and code probes are allowed to look.
const WEB_MODULE_RE = /\.(?:[cm]?[jt]sx?)$/i;

// Each framework's own component-declaration API — the call or decorator that
// MAKES a thing a component. `@Injectable`, `@NgModule`, `@Directive` and
// `@Pipe` are deliberately absent: they are not UI, so the service beside the
// component keeps falling through.
//   Angular, Stencil  the @Component({…}) decorator   Lit      @customElement
//   Vue               defineComponent                 vanilla  customElements.define
const UI_COMPONENT_RE = new RegExp([
  '@Component\\s*\\(',
  '@customElement\\s*\\(',
  '\\bdefineComponent\\s*\\(',
  '\\bcustomElements\\s*\\.\\s*define\\s*\\(',
  '\\bclass\\s+[\\w$]*\\s*extends\\s+(?:Lit|HTML[A-Za-z]*)Element\\b',
].join('|'));

// The same class of evidence for the OTHER thing a browser-driving module can
// declare: not a component, but client state. Svelte 5 runes are compiler
// keywords rather than functions — you cannot import them, assign them or pass
// them — and Svelte accepts them in exactly three file types, rejecting them
// anywhere else with `rune_outside_svelte` ("the %rune% rune is only available
// inside .svelte and .svelte.js/ts files"). `.svelte` is MARKUP_RE's
// already, so the module extensions are the whole of what is left, and they are
// the bound: a stricter one than WEB_MODULE_RE deliberately, because `$state(`
// in a plain `.ts` is not a rune at all but an identifier collision the
// compiler would reject — AngularJS spells its ui-router service `$state`, and
// asking there would raise on code no Svelte compiler ever sees.
// `$props`/`$bindable`/`$host` are component-only runes that cannot appear in a
// module, and `$inspect` is a debug read rather than a declaration.
const SVELTE_RUNE_MODULE_RE = /\.svelte\.[jt]s$/i;
const SVELTE_RUNE_RE = /\$(?:state(?:\.(?:raw|snapshot))?|derived(?:\.by)?|effect(?:\.(?:pre|root))?)\s*\(/;

// Where a `/` opens a regular expression rather than dividing: the operators and
// openers a literal may follow. Guessing wrong in the other direction — reading
// a literal as division — leaves its body in the projection, so a miss here can
// only over-report, never hide a handler.
const REGEX_POSITION = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
]);

function regexLiteralEnd(source: string, start: number): number {
  let characterClass = false;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const current = source[cursor]!;
    // A literal cannot span a line, so an unterminated scan is a division.
    if (current === '\n') return -1;
    if (current === '\\') { cursor += 1; continue; }
    if (characterClass) {
      if (current === ']') characterClass = false;
      continue;
    }
    if (current === '[') { characterClass = true; continue; }
    if (current !== '/') continue;
    if (cursor === start + 1) return -1;
    let end = cursor + 1;
    while (end < source.length && /[dgimsuvy]/.test(source[end] || '')) end += 1;
    return /[\w$]/.test(source[end] || '') ? -1 : end;
  }
  return -1;
}

/**
 * The file with everything that is not executable code blanked out: comment
 * text, string and template-literal bodies, and regular-expression bodies.
 *
 * The probes that read CONTENT are looking for a client-side API call, and a
 * token inside a comment, a message or a pattern is not one. Left unprojected
 * they answer on prose, which this very file demonstrated: its own explanation
 * of the component decorator classified `impact.ts` as `visual`, its own copy of
 * `BEHAVIOR_CODE_RE` classified it `behavioral`, and the workaround was to
 * reword the comment — a classifier whose verdict depends on how its comments
 * are phrased is not measuring the code. Measured over this repo's 868 tracked
 * JS/TS paths, `BEHAVIOR_CODE_RE` claimed 44 files raw and 15 as code: 29 were
 * claimed by prose alone.
 *
 * Template SUBSTITUTIONS survive, because `${navigate(to)}` is code; only the
 * literal text around them is dropped.
 */
function codeProjection(source: string): string {
  let output = '';
  let previous = '';
  const contexts: Array<'code' | 'template'> = ['code'];
  const substitutionBraces: number[] = [];
  let braces = 0;
  const emit = (text: string): void => {
    output += text;
    previous = text[text.length - 1] || previous;
  };
  for (let cursor = 0; cursor < source.length;) {
    const current = source[cursor]!;
    const following = source[cursor + 1];
    if (contexts[contexts.length - 1] === 'template') {
      if (current === '\\') { cursor += 2; continue; }
      if (current === '`') { contexts.pop(); emit('`'); cursor += 1; continue; }
      if (current === '$' && following === '{') {
        contexts.push('code');
        substitutionBraces.push(braces);
        braces += 1;
        emit('${');
        cursor += 2;
        continue;
      }
      cursor += 1;
      continue;
    }
    if (current === '/' && following === '/') {
      while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
      output += ' ';
      continue;
    }
    if (current === '/' && following === '*') {
      cursor += 2;
      while (cursor < source.length && !(source[cursor] === '*' && source[cursor + 1] === '/')) cursor += 1;
      cursor = Math.min(cursor + 2, source.length);
      output += ' ';
      continue;
    }
    if (current === '\'' || current === '"') {
      cursor += 1;
      while (cursor < source.length && source[cursor] !== current) {
        if (source[cursor] === '\\') cursor += 1;
        cursor += 1;
      }
      cursor += 1;
      emit(current + current);
      continue;
    }
    if (current === '`') { contexts.push('template'); emit('`'); cursor += 1; continue; }
    if (current === '/' && REGEX_POSITION.has(previous)) {
      const end = regexLiteralEnd(source, cursor);
      if (end > 0) { cursor = end; emit('//'); continue; }
    }
    if (current === '{') braces += 1;
    if (current === '}') {
      if (contexts.length > 1 && braces - 1 === substitutionBraces[substitutionBraces.length - 1]) {
        substitutionBraces.pop();
        contexts.pop();
      }
      braces = Math.max(0, braces - 1);
    }
    if (/\s/.test(current)) output += current;
    else emit(current);
    cursor += 1;
  }
  return output;
}

function stripEventHandlers(tag: string): string {
  let output = '';
  for (let cursor = 0; cursor < tag.length;) {
    const event = EVENT_ATTR_RE.exec(tag.slice(cursor));
    if (!event) {
      output += tag.slice(cursor);
      break;
    }
    const start = cursor + event.index;
    output += tag.slice(cursor, start);
    let valueStart = start + event[0].length;
    while (valueStart < tag.length && /\s/.test(tag[valueStart] || '')) valueStart += 1;
    const opener = tag[valueStart];
    // Quoted values are the norm outside JSX and may contain spaces
    // (`@click="save(a, b)"`). Skipping to the next whitespace left the tail of
    // the expression in the tag, where it read as visual content.
    if (opener === '"' || opener === '\'') {
      cursor = valueStart + 1;
      while (cursor < tag.length && tag[cursor] !== opener) cursor += 1;
      cursor += 1;
      continue;
    }
    if (opener !== '{') {
      cursor = valueStart;
      while (cursor < tag.length && !/[\s>]/.test(tag[cursor] || '')) cursor += 1;
      continue;
    }
    let depth = 0;
    cursor = valueStart;
    for (; cursor < tag.length; cursor += 1) {
      if (tag[cursor] === '{') depth += 1;
      else if (tag[cursor] === '}') {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      }
    }
  }
  return output;
}

function jsxTags(source: string): Array<{ start: number; end: number; value: string }> {
  const tags: Array<{ start: number; end: number; value: string }> = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '<' || !/(?:[A-Za-z]|\/[A-Za-z]|>|\/>)/.test(source.slice(start + 1, start + 3))) {
      continue;
    }
    let curly = 0;
    let quote: '\'' | '"' | '`' | null = null;
    let escaped = false;
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      const current = source[cursor]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === quote) quote = null;
        continue;
      }
      if (current === '\'' || current === '"' || current === '`') {
        quote = current;
        continue;
      }
      if (current === '{') curly += 1;
      else if (current === '}' && curly > 0) curly -= 1;
      else if (current === '>' && curly === 0) {
        tags.push({ start, end: cursor + 1, value: source.slice(start, cursor + 1) });
        start = cursor;
        break;
      }
    }
  }
  return tags;
}

// A node line's own name and classes: `%h1.title`, `div.container`, `.card`,
// `#app`, `h1`. Anything else on the line — piped text `|`, Marko's `--`, HAML's
// `= expression`, a bare paragraph — leaves this empty, which is correct: the
// whole line is then content.
const INDENTED_TAG_RE = /^(?:%[A-Za-z][\w:-]*|[A-Za-z_][\w:-]*|[.#][\w-]+)(?:[.#][\w-]+)*/;
// Lines a browser never paints, so an edit confined to one cannot be structural:
// Pug and Marko `//`, Pug `//-`, HAML `-#`, HAML `/`, Slim `/` and `/!`. The
// forms that survive to the DOM as an HTML comment are in here too — invisible
// is invisible. `- if user` is deliberately NOT one: Ruby control flow decides
// which elements exist, so it is structure.
const INDENTED_SILENT_RE = /^(?:\/|-#)/;
// Marko's concise mode carries the component's JavaScript in a top-level brace
// block. Its body is script, not markup, and none of the five has an element by
// these names.
const INDENTED_SCRIPT_BLOCK_RE = /^(?:class|static|\$)\s*\{$/;

/**
 * Where a node's attribute list ends. Bracketed only — Pug's `(…)`, HAML's `{…}`
 * and `(…)`, Slim's `[…]` — because this bound exists solely to say how far
 * `stripEventHandlers` may reach, and reaching into rendered text is the one
 * mistake that matters: deleting a handler-shaped run of PROSE would hide a real
 * copy change. Slim's and Marko's unbracketed `key=value` attributes therefore
 * stay in the text, where a handler-only edit reads as structural — the paying
 * direction, not the silent one.
 */
function indentedAttributesEnd(line: string, from: number): number {
  const closers: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  let cursor = from;
  for (;;) {
    let scan = cursor;
    while (scan < line.length && /\s/.test(line[scan] || '')) scan += 1;
    const opener = line[scan];
    const closer = opener ? closers[opener] : undefined;
    if (!opener || !closer) return cursor;
    let depth = 0;
    let quote: string | null = null;
    let end = scan;
    for (; end < line.length; end += 1) {
      const current = line[end]!;
      if (quote) {
        if (current === '\\') { end += 1; continue; }
        if (current === quote) quote = null;
        continue;
      }
      if (current === '"' || current === '\'') { quote = current; continue; }
      if (current === opener) depth += 1;
      else if (current === closer) {
        depth -= 1;
        if (depth === 0) { end += 1; break; }
      }
    }
    // Both HAML and Pug let an attribute list wrap, so an unterminated group
    // runs to the end of the line rather than spilling into the text.
    if (depth > 0) return line.length;
    cursor = end;
  }
}

/**
 * The same projection the tag walk produces, for languages that spell nesting
 * with whitespace. One part per rendered line, carrying the indent (re-nesting
 * IS the structural edit these languages express), the node with its event
 * handlers stripped, and the text.
 *
 * The parts are prefixed `line:` so that nothing this pass emits can be mistaken
 * for something the tag walk emitted once the two are joined into one string to
 * be compared. That is what makes APPENDING them monotone as a matter of shape
 * rather than of luck — it can turn "same" into "different" but never the
 * reverse — which is the whole reason teaching the projection a second syntax
 * could not lower any file's impact. No test distinguishes it, and none can
 * cheaply: forging the boundary shift it forecloses takes a hand-built pair.
 */
function indentedNodeParts(source: string): string[] {
  const parts: string[] = [];
  let silentAbove = -1;
  for (const raw of source.split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    if (silentAbove >= 0) {
      // A comment or script block owns everything indented under it.
      if (indent > silentAbove) continue;
      silentAbove = -1;
    }
    const line = raw.trim();
    // All five accept inline HTML, and those lines are the tag walk's already.
    if (line.startsWith('<')) continue;
    if (INDENTED_SILENT_RE.test(line) || INDENTED_SCRIPT_BLOCK_RE.test(line)) {
      silentAbove = indent;
      continue;
    }
    const tag = INDENTED_TAG_RE.exec(line);
    const end = tag ? indentedAttributesEnd(line, tag[0].length) : 0;
    const node = stripEventHandlers(line.slice(0, end)).replace(/\s+/g, ' ').trim();
    const text = line.slice(end).replace(/\s+/g, ' ').trim();
    parts.push(`line:${indent}:${[node, text].filter(Boolean).join(' ')}`);
  }
  return parts;
}

function visualProjection(source: string, relPath: string): string {
  const parts: string[] = [];
  const tags = jsxTags(source);
  let depth = 0;
  let previousEnd = 0;
  for (const tag of tags) {
    if (depth > 0) {
      const childText = source.slice(previousEnd, tag.start).replace(/\s+/g, ' ').trim();
      if (childText) parts.push(`text:${childText}`);
    }
    parts.push(`tag:${stripEventHandlers(tag.value).replace(/\s+/g, ' ').trim()}`);
    const closing = /^<\//.test(tag.value);
    const selfClosing = /\/>$/.test(tag.value);
    if (closing) depth = Math.max(0, depth - 1);
    else if (!selfClosing) depth += 1;
    previousEnd = tag.end;
  }
  if (INDENTED_MARKUP_RE.test(relPath)) parts.push(...indentedNodeParts(source));
  return parts.join('\n');
}

function changedCodeIsVisual(evidence: ChangedHunkEvidence, relPath: string): boolean {
  if (visualProjection(evidence.before, relPath) !== visualProjection(evidence.after, relPath)) return true;
  return /\b(?:className|style|css|theme|token|palette|color|background|font|spacing|gap|grid|flex|width|height|margin|padding|asset|icon|image|layout)\b/i
    .test(evidence.changedText);
}

function baseImpact(profile: CapabilityProfileV1): UiImpact {
  if (profile.architectureTarget === 'web-ui') return 'nonvisual';
  if (profile.architectureTarget === 'native-ui') return 'native-ui';
  if (profileHasNativeUi(profile)) return 'native-ui';
  if (!profileHasWebUi(profile)) return 'none';
  return 'nonvisual';
}

export function rank(impact: UiImpact): number {
  if (impact === 'none') return 0;
  if (impact === 'nonvisual') return 1;
  if (impact === 'behavioral') return 2;
  if (impact === 'visual') return 3;
  return 4;
}

export function raiseImpact(current: UiImpact, candidate: UiImpact): UiImpact {
  if (current === 'native-ui' || candidate === 'native-ui') return 'native-ui';
  return rank(candidate) > rank(current) ? candidate : current;
}

export function validateAgentRaisedImpact(
  profile: CapabilityProfileV1,
  candidate: UiImpact | undefined,
): void {
  if (!candidate) return;
  const domain = baseImpact(profile);
  if (domain === 'none' && candidate !== 'none') {
    throw new Error(`agentRaisedImpact ${candidate} is invalid for a project without a UI surface`);
  }
  if (domain === 'native-ui' && candidate !== 'native-ui') {
    throw new Error(`agentRaisedImpact ${candidate} is invalid for a native-ui profile`);
  }
  if (domain === 'nonvisual' && !['none', 'nonvisual', 'behavioral', 'visual'].includes(candidate)) {
    throw new Error(`agentRaisedImpact ${candidate} is invalid for a web-ui profile`);
  }
}

function baselineContainsPath(
  projectRoot: string,
  baseline: ArchitectureBaselineV1,
  relPath: string,
): boolean {
  if (baseline.kind === 'git-head' && baseline.identity.startsWith('git:')) {
    return gitTextAtBaseline(projectRoot, baseline.identity.slice(4), relPath).exists;
  }
  return (baseline.files || []).some((entry) => entry.path === relPath);
}

export function plannedUiImpactFloor(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
): UiImpact {
  if (!profileHasWebUi(architecture.profile)) return baseImpact(architecture.profile);
  let floor: UiImpact = 'nonvisual';
  for (const module of architecture.modules) {
    // Extension freedom: a module pre-existing at ANY allowed variant is not new.
    if (moduleOutputVariants(module).some((variant) => (
      baselineContainsPath(projectRoot, architecture.baseline, variant)
    ))) continue;
    if (['app-shell', 'page', 'component'].includes(module.kind)) return 'visual';
    if (module.kind === 'feature') floor = raiseImpact(floor, 'behavioral');
  }
  for (const output of architecture.scaffoldOutputs || []) {
    if (output.ownerRole === 'senior-tester'
      || baselineContainsPath(projectRoot, architecture.baseline, output.path)) continue;
    if (VISUAL_RE.test(output.path)
      || PLANNED_VISUAL_PATH_RE.test(output.path)
      || MARKUP_RE.test(output.path)) return 'visual';
    if (BEHAVIOR_RE.test(output.path)) floor = raiseImpact(floor, 'behavioral');
  }
  return floor;
}

export function plannedImportantVisualChange(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
): boolean {
  return architecture.modules.some((module) => (
    ['app-shell', 'page'].includes(module.kind)
    && !moduleOutputVariants(module).some((variant) => (
      baselineContainsPath(projectRoot, architecture.baseline, variant)
    ))
  )) || (architecture.scaffoldOutputs || []).some((output) => (
    output.ownerRole !== 'senior-tester'
    && IMPORTANT_VISUAL_PATH_RE.test(output.path)
    && !baselineContainsPath(projectRoot, architecture.baseline, output.path)
  ));
}

/**
 * What the CHANGED PATHS are evidence of. The arms below are ordered and
 * exhaustive in one direction only: each raises on evidence that the file is
 * visual, is markup, or drives behavior, and a file none of them recognize
 * leaves the impact where `baseImpact` put it.
 *
 * That last clause is the load-bearing one. The chain used to end in two more
 * arms: `NONVISUAL_RE` (types/mappers/schemas/data/config/constants/utils/lib,
 * `.d.ts`, `*.config.*`) raising to `nonvisual`, and then a bare
 * `/\.(?:tsx?|jsx?|mjs|cjs)$/` raising to BEHAVIORAL. The first could never
 * change an answer — the loop is reachable only when `baseImpact` already said
 * `nonvisual`, so its entire function was to shield a path from the second — and
 * the second made the most expensive answer the default: any JS/TS file whose
 * directory nobody had listed became the class `browserRequired` answers true
 * for. Measured over this repo's own 867 tracked JS/TS paths, 787 classified
 * `behavioral` and 664 of those (76.6% of every JS/TS path) held no visual,
 * markup or behavior evidence at all — their extension was the whole case. Among
 * them was `tests/<module>.test.ts`, the unit test EVERY plan compiles, a
 * service-only one included, so a run that planned no UI escalated itself into
 * needing a Chromium the machine may not have, on evidence it manufactured for
 * itself.
 *
 * Non-recognition is not evidence. This classifier cannot tell "this affects the
 * UI" from "I do not recognise this path", so it must not spend a browser on the
 * second, and it must not spend one on TypeScript that it would not spend on the
 * `.go`, `.py` or `.sql` file beside it, which always fell through here. What is
 * left over is answered where the evidence actually lives: `nonvisual` still owes
 * stack-build/format/test, `plannedUiImpactFloor` raises the contract whenever
 * the PLAN holds UI, and `agentRaisedImpact` exists for a role that knows
 * something the paths do not say.
 *
 * The visual name arm went for that reason and no other. `VISUAL_PATH_RE`
 * (`styles?|theme|tokens?|assets?|layout`) answered from a path's SPELLING in
 * the same way the bare extension arm did, and it answered in the most
 * expensive class there is — first arm in the chain, straight to `visual`, so
 * the three-viewport sweep with no changed-hunk discrimination underneath it.
 * Its alternation ends `(?:\/|[.-])`, which claims filename PREFIXES as
 * readily as directories. Measured over this repo's 1323 tracked paths it
 * claimed 27, and not one of them is a stylesheet, an image or a design token:
 * 24 are the token ACCOUNTING code (everything under `runners/token-report`,
 * `token-logger.ts`, `override/token.ts` — `token` before a `-` or a `.`) and 3
 * are documentation (two `rules/frontend/<framework>/styles.md`, and the
 * `token-usage-report/` skill, a directory segment read as a design token).
 * That was every `visual` verdict this corpus produced.
 *
 * What it could genuinely see, something intrinsic already sees better:
 * stylesheets, images and fonts are VISUAL_RE's by extension, a component or
 * layout under any of those directories is MARKUP_RE's, and the utility-CSS
 * configs are VISUAL_CONFIG_RE's by exact filename. The residual is real and
 * narrow — a CSS-in-JS `theme/index.ts`, a `tokens/colors.ts` — and it is NOT
 * left standing: `PRESENTATION_DIR_RE` readmits exactly that class on three
 * bounds. The argument for leaving it, that no bound separates victim from
 * beneficiary because both are `.ts`, holds for a WEB_MODULE_RE bound on the
 * full spelling (3 moved, 24 kept) and fails for the ANCHOR: all 24 arrive
 * through the `[.-]` branch and not one is a directory segment.
 *
 * Why it is worth readmitting at all, when "non-recognition is not evidence"
 * argues the other way: the two authorities named below do not in fact cover
 * this case. `plannedUiImpactFloor` skips every module and output already in
 * the baseline — it is a NEW-work instrument — so on an existing codebase
 * editing an existing token file it raises nothing, leaving `agentRaisedImpact`
 * as the only guard, i.e. a role volunteering what the product could not tell
 * it. CSS-in-JS is not an exotic shape to leave there. So a theme module is now
 * answered three ways: that arm, the floor on the plan that ADDS it, and an
 * agent that knows what the path does not say.
 *
 * `profile.entrypoints` is the one member of that fallback that carried real
 * evidence rather than a spelling: on vue/svelte/angular/generic-web and
 * non-React Laravel-Inertia the mount point is `main.ts`/`app.js`, invisible to
 * every markup and style pattern, and installing a router or a global plugin
 * there IS browser-observable. It matches the profile's own declaration exactly,
 * so unlike a widened regex it cannot claim a backend file that merely shares a
 * name.
 *
 * A framework's own component API is a declaration in that same sense, and it
 * closes the mirror hole the deletion left. MARKUP_RE is a list of extensions
 * that mean markup, which is why it recognizes React, Vue, Svelte and Astro and
 * cannot recognize Angular at all: the canonical Angular component IS
 * `hero.component.ts` — naming.ts pins `.component.ts` for every Angular module
 * kind — and it carries its template inline. Measured on the working tree,
 * `hero.component.ts` derived `nonvisual` while the same bytes saved as
 * `hero.component.tsx` derived `visual`; Lit and vanilla custom elements
 * (profileId `generic-web`) and Vue render-function components are the same
 * shape. So the arm joins MARKUP_RE's changed-hunk block rather than taking a
 * flat class: a template edit is `visual` and a handler-only edit `behavioral`,
 * as for the `.tsx` or `.vue` beside it. It is unconditional on the profile
 * because Lit reaches here as `generic-web` and a monorepo holds more than one
 * framework, and extension-guarded because Spring spells a backend bean
 * `@Component` too.
 *
 * That guard is the whole principle, and the two arms below it were the last
 * places without it. `BEHAVIOR_RE` and `BEHAVIOR_CODE_RE` were asked of every
 * changed path in any language, so they claimed the backend by SPELLING: Go names
 * its HTTP layer `router.go` and `handler.go`, Rails mandates
 * `invoices_controller.rb`, Spring `InvoiceController.java`, ASP.NET
 * `InvoicesController.cs`; `internal/routes`, `internal/store`, `internal/state`
 * and `crates/api/src/state.rs` are packages, not layers of a UI; and a
 * migration naming a `router_audit` table, a `routes.yaml` gateway table, a
 * `router-smoke.sh` script and `docs/architecture/router.md` all matched too.
 * Measured on a 58-file polyglot corpus (Go, Python, Ruby, PHP, Java, Rust, C#,
 * SQL beside a React app), 42 paths were browser-requiring and 21 of them —
 * exactly half — could not be observed in a browser at all. Bounding both arms
 * to WEB_MODULE_RE took that to 5.
 *
 * A browser-loadable extension is a WEAKER bound than the arms that ran before
 * it, and it had to be checked rather than assumed: every markup extension the
 * behavior arms could plausibly have been covering — `.php`, `.blade.php`,
 * `.erb`, `.twig`, `.hbs`, `.html`, `.astro`, `.vue`, `.svelte` — is in
 * MARKUP_RE, so control never reaches here for one, and all eleven such rows in
 * that corpus kept their class. What the bound dropped was the token LOTTERY over
 * template languages MARKUP_RE had never listed: `.mdx` and `.pug` raised only
 * because they happened to contain `onClick`/`navigate`, while `.htm`, `.haml`,
 * `.njk`, `.liquid` and `.gohtml` were already `nonvisual`. Two of seven, by
 * which token a template happened to hold — so the class was never covered, and
 * removing the accidental half only exposed what was already true for the other
 * five. It is answered where it can be answered on evidence: all seven are in
 * MARKUP_RE now, with the siblings that would have repeated the same partial
 * coverage (`.slim` beside `.erb`/`.haml`, `.jade` beside `.pug`, `.jsp`/`.jspx`
 * and `.xhtml` for the java backend, `.marko` and `.gjs`/`.gts` for two detected
 * frontends).
 *
 * `.mdx` is the one row the path genuinely cannot settle, so it is settled by
 * DIRECTION: an `.mdx` file is a compiled page component in Next, Astro, Gatsby
 * and Remix, and it is also how a docs site writes prose, and nothing about the
 * path says which. Read as markup, a docs edit overpays — `behavioral` for a
 * prose-only hunk, since the tag projection sees no change. Read as
 * documentation, an interactive page ships with nothing asking for a browser.
 * The second is the failure this whole contract exists to prevent, so `.mdx`
 * classifies as markup here while `isDocumentationPath` in
 * shared/opencode-queue/policy.ts keeps treating it as documentation — a
 * different question (may this work unit run a package manager?) with no bearing
 * on whether a browser saw the result.
 *
 * The indentation-based templates were in that list on evidence but not yet on
 * COST, and the gap ran through one framework: Rails ships three view languages
 * and `visualProjection` read only one of them, because it walked angle
 * brackets. An `.erb` structural edit bought the screenshot sweep while the same
 * edit in the `.haml` or `.slim` beside it produced an identical (empty)
 * projection on both sides and settled for `behavioral` — so whether a visual
 * regression was looked at depended on which view language the team picked, in
 * the under-escalation direction. `visualProjection` now reads lines as well as
 * tags for `.pug`, `.jade`, `.haml`, `.slim` and `.marko`'s concise syntax, and
 * it discriminates by the same rule the tag walk uses: handlers are stripped, so
 * a handler-only edit is still `behavioral`, and a comment carries no part at
 * all, so neither is a prose-only edit to one.
 *
 * What it does NOT do is invent a softer rule for these five than their
 * angle-bracket siblings get. Rendered TEXT is part of the projection here
 * exactly as `<h1>Invoices</h1>`'s text is part of it in the `.erb` next door,
 * so retitling a heading is `visual` in both — a longer label wraps, and that is
 * what a screenshot is for. Excluding it would have closed the asymmetry this
 * paragraph exists to close and reopened it one edit shape to the left.
 *
 * Svelte 5 rune modules are the same shape of hole one layer down, and they are
 * closed in the BEHAVIOR arm rather than the component one: `cart.svelte.ts`
 * declares client state, not a component, so the changed-hunk discrimination
 * above would answer `visual` for `let width = $state(0)` on the word `width`
 * alone. `behavioral` is what a state module can actually owe. The residual it
 * leaves is narrow: rune modules are imported BY `.svelte` components that
 * MARKUP_RE claims, so only an edit that touches the rune module and nothing
 * else was ever escaping — and Svelte and SvelteKit are first-class profiles.
 *
 * Server-side URL maps are the one browser-observable class the bound lowers, and
 * they show the same lottery: Rails' `config/routes.rb` was claimed only because
 * Rails spells it `routes`, while Django's identical `urls.py` never was. So the
 * class was already half-uncovered, and it is covered where it can be answered
 * properly — a plan that adds a reachable page declares a page module, which
 * `plannedUiImpactFloor` raises independently of any path scan.
 */
export function deriveUiImpact(
  projectRoot: string,
  profile: CapabilityProfileV1,
  changedPaths: readonly string[],
  baseline?: ArchitectureBaselineV1,
): { impact: UiImpact; tabletRisk: boolean; reason?: string } {
  let impact = baseImpact(profile);
  let tabletRisk = false;
  const fallbackReasons: string[] = [];
  if (impact === 'none' || impact === 'native-ui') return { impact, tabletRisk };
  // The project's OWN declared mount points, not a name-shaped guess at them.
  // Extension-guarded because a profile may name a DIRECTORY here (`generic-web`
  // lists the app root alongside `src/main.ts`): only a module file can be the
  // thing that changed, and a bare `app`/`web/app` entry would otherwise claim
  // any same-named build artifact as the web entrypoint.
  const entrypoints = new Set(
    profile.entrypoints
      .map((entry) => normalizeRel(entry))
      .filter((entry): entry is string => entry !== null && WEB_MODULE_RE.test(entry)),
  );
  // The web surface's own declared extent, for PRESENTATION_DIR_RE's third
  // bound. Normalized here rather than per path so the containment test below
  // is a prefix compare on already-canonical strings.
  const webSourceRoots = profile.sourceRoots
    .map((root) => normalizeRel(root))
    .filter((root): root is string => root !== null);
  const underWebSource = (file: string): boolean => webSourceRoots.some(
    (root) => file === root || file.startsWith(`${root}/`),
  );
  for (const file of changedPaths) {
    const normalized = normalizeRel(file);
    if (!normalized) continue;
    const content = safeRead(projectRoot, normalized);
    const webModule = WEB_MODULE_RE.test(normalized);
    // Both content probes read this instead of the file. A file a browser cannot
    // load has no projection at all, which is the bound; within one, a token has
    // to be code rather than prose.
    const code = webModule ? codeProjection(content) : '';
    let changedContent = content;
    if (VISUAL_RE.test(normalized) || VISUAL_CONFIG_RE.test(normalized)
      || (webModule && underWebSource(normalized) && PRESENTATION_DIR_RE.test(normalized))) {
      impact = raiseImpact(impact, 'visual');
    } else if (MARKUP_RE.test(normalized) || UI_COMPONENT_RE.test(code)) {
      const evidence = changedHunkEvidence(projectRoot, baseline, normalized);
      changedContent = evidence.changedText;
      if (!evidence.available) {
        impact = raiseImpact(impact, 'visual');
        fallbackReasons.push(`${normalized}: ${evidence.reason || 'changed-hunk evidence unavailable'}`);
      } else if (changedCodeIsVisual(evidence, normalized)) {
        impact = raiseImpact(impact, 'visual');
      } else if (evidence.changedText.trim()) {
        impact = raiseImpact(impact, 'behavioral');
      }
    } else if (entrypoints.has(normalized)
      || (webModule && (BEHAVIOR_RE.test(normalized) || BEHAVIOR_CODE_RE.test(code)))
      || (SVELTE_RUNE_MODULE_RE.test(normalized) && SVELTE_RUNE_RE.test(code))) {
      impact = raiseImpact(impact, 'behavioral');
    }
    if (TABLET_RISK_RE.test(changedContent) || /(?:^|[-_.])tablet(?:[-_.]|$)/i.test(normalized)) tabletRisk = true;
  }
  return {
    impact,
    tabletRisk,
    ...(fallbackReasons.length > 0
      ? { reason: `Conservative visual classification because diff evidence was unavailable (${fallbackReasons.join('; ')}).` }
      : {}),
  };
}

/**
 * The one rule that composes the two authorities, stated in the only place that
 * gets to compose them. It is TWO-SIDED, and both sides are failure modes that
 * have to be closed together:
 *
 *   - The planned floor is a LOWER BOUND that no scan outcome may reduce. A scan
 *     that fails, times out, exceeds its file bound, or simply sees nothing
 *     yields `baseImpact` — and a run that planned three pages must not publish a
 *     contract saying "no UI impact", because that ships UI nobody verified.
 *   - The scan's own IGNORANCE is not evidence that may raise it. `deriveUiImpact`
 *     raises only on visual, markup or behavior evidence; unrecognized paths
 *     leave the floor standing. Pinning the impact literally AT the floor would
 *     close the first hole and open the mirror one, because an unplanned `.tsx`
 *     or stylesheet edit could then never escalate the run that made it.
 *
 * So: a maximum, never an assignment, and the scan side earns its raises. Neither
 * half is safe alone — `deriveUiImpact`'s ignorance-as-behavior default was the
 * over-escalation that made runs unsettleable, and a floor applied as `=` instead
 * of `max` is the under-escalation that lets unverified UI ship.
 */
export function uiImpactWithPlannedFloor(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
  scanned: UiImpact,
): UiImpact {
  return raiseImpact(scanned, plannedUiImpactFloor(projectRoot, architecture));
}

export function changedRoutes(
  architecture: CompiledArchitectureV1,
  paths: readonly string[],
  impact: UiImpact,
): string[] {
  const changed = new Set(paths);
  const globalVisualChange = impact === 'visual' && paths.some((file) => (
    VISUAL_RE.test(file)
    || VISUAL_CONFIG_RE.test(file)
    || /(?:^|\/)(?:styles?|theme|tokens?|assets?|layouts?|components?|packages\/ui)(?:\/|[.-])/i.test(file)
  ));
  if (globalVisualChange) {
    const allRoutes = architecture.routes
      .filter((route) => !route.redirect)
      .map((route) => route.path);
    if (allRoutes.length > 0) return unique(allRoutes);
  }
  const routes = architecture.routes
    .filter((route) => route.redirect || changed.has(route.moduleOutput))
    .map((route) => route.path);
  if (routes.length > 0) return unique(routes);
  return architecture.profile.surfaces.includes('web-ui') ? ['/'] : [];
}

/**
 * Does this impact drive a real browser? The ONE authority — it decides which
 * producer a contract gets, so a second reader that answered differently would
 * silently point requiredChecks at a runner that cannot serve it. The contract
 * publishes `browserRequired` from here, the `stack` runner refuses a contract
 * that answers true, and the producible-check invariant reads it to pick the
 * producer to hold each impact's required list against.
 */
export function browserRequired(impact: UiImpact): boolean {
  return impact === 'behavioral' || impact === 'visual';
}

/**
 * Every id published here must be one some producer can emit as `passed`.
 *
 * The list and the producer set were two independent authorities that nobody
 * cross-checked, and that produced BOTH failure directions at once:
 *
 *   - `unit-or-component-tests` (was on `nonvisual`) was a second NAME for the
 *     evidence `stack-test` already resolves — the project's own `test` script,
 *     `go test`, `pytest`, `cargo test`, `php artisan test`, the JVM wrappers.
 *     Nothing had an arm for the second name, so it resolved `not-applicable`
 *     with no justification and validateQaReportV2 rejected
 *     `required-check-failed` on EVERY nonvisual run — the base impact of any
 *     project with a web surface, i.e. the commonest change shape there is
 *     (types, utils, config, schemas, data). Those runs could never settle. It
 *     now requires the id that HAS a resolver.
 *   - `axe-when-dom` (was on `nonvisual`, absent from the two impacts that
 *     actually drive a browser) had no producer anywhere and no path to
 *     `passed`: not `resolveStackCommand`, not `computeBrowserCheckStatuses`.
 *     The product owns no axe integration at all — Lighthouse's accessibility
 *     category is a separate dimension — so requiring it was decoration that
 *     only ever deadlocked. It is required by nothing until a producer exists;
 *     qa-report-v2/dimensions.ts keeps the accessibility dimension wired to the
 *     id so adding that producer is the only step left.
 *
 * `tests/…/required-checks-producible.test.ts` now proves the subset invariant
 * by EXECUTING each producer, so a new id cannot rejoin this list without one.
 */
export function requiredChecks(impact: UiImpact, stackPerformanceRisk = false): string[] {
  // `stack-format` rides EVERY impact level: unformatted source is a defect on a
  // web app exactly as much as on an api-only service, and configuration-only
  // verification let two runs ship with format:check red end to end. A project
  // that declares no format script reports `not-applicable` with its reason,
  // which validateQaReportV2 accepts for non-build stack checks.
  const withStackPerformance = (checks: string[]): string[] => (
    stackPerformanceRisk ? [...checks, 'stack-format', 'stack-performance'] : [...checks, 'stack-format']
  );
  if (impact === 'none') return withStackPerformance(['stack-build', 'stack-test', 'stack-lint']);
  if (impact === 'nonvisual') return ['stack-build', 'stack-format', 'stack-test'];
  if (impact === 'behavioral') {
    return [
      'stack-build', 'stack-format', 'playwright-local', 'dom-assertions', 'actions', 'routing',
      'hydration', 'console-errors', 'network-errors',
    ];
  }
  if (impact === 'visual') {
    return [
      'stack-build', 'stack-format', 'playwright-local', 'dom-assertions', 'actions', 'routing',
      'hydration', 'console-errors', 'network-errors', 'responsive-screenshots',
    ];
  }
  return withStackPerformance(['stack-build', 'native-unit-tests', 'simulator-or-emulator']);
}

export function thresholdsValid(thresholds: LighthouseThresholdsV1 | undefined): boolean {
  if (!thresholds) return true;
  for (const [key, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || Number(value) < 0) return false;
    if (key.endsWith('Min') && Number(value) > 100) return false;
  }
  return true;
}

export function verificationHash(value: unknown): string {
  return sha256(stableContractJson(value));
}
