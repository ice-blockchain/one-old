// src/modules/plan-guard/plan-static.ts
// The static layout/style half of the plan-write gate: deterministic
// checks on the target file path + content (no state/convergence deps). Ported
// 1:1 from the static checks in runCheckPlanWrite.
// Deny PROSE comes from skill/SKILL.md via skillBlock with verbatim fallbacks,
// so a missing block never disables a check.

import type { SkillBlockFn } from '../../core/types';
import { isTestScopePath } from '../../shared/feature-source';

export type Vars = Record<string, string | number | null | undefined>;
type Block = (name: string, fallback: string, vars?: Vars) => string;

// The runtime WebSocket-constructor token. Built by concatenation so this very
// source file does not trip the gate's own websocket-location rule.
const WS_CTOR = 'new ' + 'WebSocket(';

// Extract the object-literal text of every `style={{…}}` occurrence (the text
// between the inner braces), walking brace depth so nested objects/template
// literals stay inside their occurrence. Unterminated objects are skipped.
function inlineStyleObjectTexts(content: string, needle: string): string[] {
  const out: string[] = [];
  let idx = content.indexOf(needle);
  while (idx !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = idx + needle.length - 1; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break;
    out.push(content.slice(idx + needle.length, end));
    idx = content.indexOf(needle, end);
  }
  return out;
}

// A style object is STATIC when every `key: value` entry is a plain string or
// numeric literal — exactly what belongs in a Tailwind class instead. Anything
// else (identifier, template literal, call, ternary, spread, nested object) is
// a dynamic/derived value, which the web rule explicitly reserves inline style
// for (observed 5c/8c: `width: \`${clamped}%\`` was denied and forced a worse
// workaround). Ambiguous parses fall toward dynamic — this gate fails open.
function styleObjectIsStatic(objText: string): boolean {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < objText.length; i++) {
    const ch = objText[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      entries.push(objText.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(objText.slice(start));
  const LITERAL_VALUE = /^\s*(['"][^'"]*['"]|-?\d+(?:\.\d+)?)\s*$/;
  let sawEntry = false;
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) return false; // spread / shorthand identifier → dynamic
    sawEntry = true;
    if (!LITERAL_VALUE.test(trimmed.slice(colon + 1))) return false;
  }
  return sawEntry;
}

// File-integrity check, NOT an architecture opinion: SVG text in a bitmap path
// is a broken asset in every project. Split out so the existing-codebase
// stand-down in the plan-write dispatcher can keep it while the prescribed
// stack/layout checks below stand down.
export function assetExtensionMismatchViolations(filePath: string, content: string, block: Block): string[] {
  if (/\.(png|jpe?g|webp|avif)$/i.test(filePath) && /^\s*(?:<\?xml\b|<svg\b)/i.test(content)) {
    return [block('asset-extension-mismatch',
      'Asset gate: this write puts SVG/XML text into a bitmap image path such as `.png`, `.jpg`, `.webp`, or `.avif`. The bytes are markup rather than an encoded bitmap, so every consumer that decodes by extension — an image tag, an image pipeline, a favicon reader — reads a corrupt file, and no build or typecheck step in this run will report it. Re-issuing the same content draws the same refusal — the rule compares the extension against the leading bytes of the content, so reformatting or minifying the markup does not satisfy it. Save this content at a `.svg` path and update the references to it, or supply a real encoded bitmap for the bitmap path; this is a file-integrity check, so it holds on an existing codebase too.')];
  }
  return [];
}

// Collect plan gate violations for a single file write/edit. `isNative`
// selects React Native vs web style/placement rules.
export function planStaticViolations(filePath: string, content: string, isNative: boolean, block: Block): string[] {
  const violations: string[] = [];
  const INLINE_STYLE = 'style={' + '{';

  violations.push(...assetExtensionMismatchViolations(filePath, content, block));

  if (/(apps\/[^/]+\/)?src\/pages\/.*\.(service|store|hook|query|slice|api)\.(ts|tsx)$/.test(filePath)) {
    violations.push(block('pages-service-files',
      'Route-page placement gate: `src/pages/` holds route components, and this write puts a `.service`/`.store`/`.hook`/`.query`/`.slice`/`.api` module inside it. Data access and state parked next to one route is the shape that later forces a second route to import across the pages tree, which is the coupling this layout exists to prevent. Re-issuing the same path draws the same refusal — the rule reads the path, so renaming the export or shrinking the file changes nothing. Write the module at `src/services/`, `src/features/<name>/`, or a `packages/*` workspace instead and import it from the page; if none of those is in your compiled allowlist, name this path in your digest with verdict `BLOCKED` so the architect can compile a home for it.'));
  }

  if (/(apps\/[^/]+\/)?app\/.*\.(service|store|hook|query|slice|api)\.(ts|tsx)$/.test(filePath)) {
    violations.push(block('expo-route-service-files',
      'Expo Router placement gate: every file under `app/` is part of the route tree and must stay thin, and this write puts a `.service`/`.store`/`.hook`/`.query`/`.slice`/`.api` module there. Expo Router derives navigation from that directory, so a service module placed in it joins the route surface instead of staying a module the routes import. Re-issuing the same path draws the same refusal — the rule reads the `app/` path shape and not the project platform, so it fires on an `app/` directory in a web workspace too. Move the module to `src/features/<name>/`, `src/services/`, or a `packages/*` workspace and import it from the thin route file; if none of those is in your compiled allowlist, name this path in your digest with verdict `BLOCKED`.'));
  }

  // `src/App.tsx` is exempt: it is the canonical root component of every Vite
  // (and src-layout RN/Expo) template — index.html → main.tsx → App. Denying it
  // forces a non-standard `src/components/App.tsx` relocation (observed
  // 8c-codex). Every other capitalized module directly in src/ stays gated.
  //
  // `packages/**` is exempt too: this is an APP-source placement rule, and a
  // workspace package root is where the message itself points ("or
  // packages/ui/*"). Unanchored, the pattern denied both the destination it
  // recommends (`packages/ui/src/Button.tsx`) and the backend service modules
  // the RUNTIME compiles into an assignment — observed 1cu-cursor:
  // `packages/api-client/src/AuthAPIService.ts` was in senior-backend's
  // compiled `assignments.json` scope and denied 4× by this line, which ended
  // the run with zero backend files. A gate must never deny a path runtime
  // itself owns.
  //
  // A `.ts` module cannot contain JSX, so a PascalCase `.ts` directly in `src/`
  // is a service/store/type module far more often than a component — and both
  // supabase (`packages/api-client/src/AuthAPIService.ts`) and the generic TS
  // backend (`services/api/src/AuthAPIService.ts`) compile exactly that shape.
  // Require a real component signal there; `.tsx` stays gated on path alone.
  const componentSignal = /\.tsx$/.test(filePath) || /(?:React\.)?createElement\s*\(/.test(content);
  if (componentSignal
    && !/(?:^|\/)packages\//.test(filePath)
    && /(apps\/[^/]+\/)?src\/[A-Z][a-zA-Z]+\.(tsx|ts)$/.test(filePath)
    && !/(?:^|\/)src\/App\.(?:tsx|ts)$/.test(filePath)) {
    const target = isNative
      ? 'src/components/, src/features/<name>/components/, or packages/ui-native/*'
      : 'src/components/, src/features/<name>/components/, or packages/ui/*';
    violations.push(block('component-placement',
      `Components must live in ${target} — not directly in src/.`, { TARGET: target }));
  }

  const featureMatch = filePath.match(/src\/features\/([^/]+)/);
  if (featureMatch) {
    const current = featureMatch[1];
    const cross = Array.from(content.matchAll(/from ['"]@\/features\/([^/'"]+)/g))
      .map((match) => match[1])
      .filter((feature) => feature !== current);
    if (cross.length > 0) {
      // Remedies must be writable in the run's compiled scope: packages/utils
      // does not exist in most compiled profiles (observed 3co — the message
      // recommended it while the only frontend-writable shared homes were
      // packages/ui and src/components/), and domain types/state usually live
      // in the backend-owned api-client package that any feature may import.
      violations.push(block('cross-feature-import',
        `Cross-feature import detected (${current} -> ${cross}). Never import one feature from another. Import shared domain types/data contracts from the api-client workspace package; put shared UI in src/components/ or packages/ui (packages/ui-native for native) when your allowlist includes it. If the shared piece has no writable home in your compiled scope, ask for the owning \`service\`/\`store\`/\`component\` module via ArchitectureInputV1 instead of widening imports.`,
        { CURRENT: current, CROSS: String(cross) }));
    }
  }

  if (/from ['"]\.\.\/\.\.\/\.\.\/packages\//.test(content)) {
    violations.push(block('deep-relative-package',
      'Workspace import gate: this file reaches into another workspace package through a `../../../packages/…` relative path instead of importing that package by name. A deep relative path bypasses the package entry point, breaks the moment either side moves, and hides the dependency from the workspace resolver the build and the package graph read. Re-issuing the same import draws the same refusal — the rule reads the specifier, so adding or removing a `../` level does not satisfy it. Replace the specifier with the workspace package name (`@app/ui`, `@app/ui-native`, `@app/utils`) in this same file — the fix is an edit to the import line, never a relocation.'));
  }

  // Route files are exempt from the named-export rule: Expo Router files live
  // under app/ (never matched here), and web page components under src/pages/
  // are loaded via React.lazy, whose contract is a default export — denying
  // them forces the `.then((m) => ({ default: m.X }))` shim (observed 8c).
  //
  // The compiled FEATURE entry (`features/<kebab>/index.tsx`, .tsx since the
  // kind stopped compiling to a JSX-illegal `.ts`) is deliberately NOT a third
  // exemption. Nothing lazy-loads it by the default-export contract — routes
  // compile to the pages root — and every other `.tsx` under `features/` has
  // always required a named export, so exempting exactly the entry would be
  // the inconsistency. The remedy is a one-token rename inside the same file,
  // never a relocation, and the mode rules state the convention next to the
  // path they print. See `rules/frontend/react/core.md` ("Absolute rules").
  if (
    filePath.endsWith('.tsx')
    && /(src|packages\/(ui|ui-native))\/(components|features)\//.test(filePath)
    && /^export default /m.test(content)
  ) {
    violations.push(block('default-export',
      'Use named exports only for reusable components — this file declares a default export, and the compiled feature entry `features/<name>/index.tsx` is a module entry rather than a route file, so it is covered too. A default export carries no name across the import boundary, so each consumer may spell it differently and a later rename never propagates to any of them. Re-issuing the file unchanged draws the same refusal — the rule reads the default-export declaration itself, so moving it down the file or wrapping it changes nothing. Route files — Expo Router files under `app/` and web page components under `src/pages/` — are the stated exception; everywhere else the fix is a one-token rename inside this same file plus the matching change at each import site, never a relocation.'));
  }

  if (isNative) {
    if (filePath.endsWith('.tsx') && content.includes(INLINE_STYLE)) {
      violations.push(block('native-inline-style',
        'No inline object styles on React Native — this `.tsx` passes an inline style object, and NativeWind `className` is where a static style belongs on this stack. A style object literal is allocated again on every render and sits outside the class system the rest of the UI is themed through, so the same constant is restated per component instead of resolving to one utility. Re-issuing the file unchanged draws the same refusal — unlike the web rule, this one denies derived values too, so making a value computed does not satisfy it. Express the constant styles as a `className` string on the same element and keep `StyleSheet.create` for values that genuinely animate or are measured at runtime; both edits stay inside this same file.'));
    }
    if (filePath.endsWith('.tsx') && /\b(div|span|button|a|input)\b/.test(content)) {
      violations.push(block('native-dom-tags',
        'React Native has no DOM — this `.tsx` uses one of the `div`, `span`, `button`, `a`, or `input` tags, which the React Native renderer has no component for. The bundle still builds and typechecks, so this fails on the device at runtime rather than in any verification command this run will execute, which is why it is refused at write time. Re-issuing the file unchanged draws the same refusal — the rule matches the tag names in the source, so re-exporting them from a shim module does not satisfy it. Replace each one with its native primitive in this same file: `View` for `div`, `Text` for `span`, `Pressable` for `button` and `a`, and `TextInput` for `input`.'));
    }
  } else {
    // Web: only STATIC inline styles are denied — a style object whose every
    // value is a plain literal belongs in Tailwind classes. Dynamic/derived
    // values (computed width, transform from state) are the rule's own stated
    // exception and pass.
    if (filePath.endsWith('.tsx')
      && inlineStyleObjectTexts(content, INLINE_STYLE).some(styleObjectIsStatic)) {
      violations.push(block('web-inline-style',
        'No static inline styles — this `.tsx` passes an inline style object whose every value is a plain string or numeric literal, which is exactly what a Tailwind utility class already expresses. A constant inline style leaves the design tokens behind: it cannot be themed through the HSL CSS variables, it carries no breakpoint or dark-mode variant, and it outranks any class a consumer later tries to override it with. Re-issuing the file unchanged draws the same refusal — the rule inspects the values inside the object rather than the element or the file, so moving the same literal object elsewhere does not satisfy it. Convert those entries to `className` utilities, reaching for a shadcn primitive where one exists, in this same file; an inline style stays allowed for a value computed at runtime, so a genuinely derived width or transform may remain.'));
    }
    if ((filePath.endsWith('.tsx') || filePath.endsWith('.ts')) && /from ['"]@vanilla-extract\//.test(content)) {
      violations.push(block('vanilla-extract-import',
        'vanilla-extract is no longer in the active stack — this file imports from the `@vanilla-extract` scope. The active stack styles with Tailwind and shadcn, so nothing installs that package or runs its build plugin, and the import has nothing to resolve to once the write lands. Re-issuing the file unchanged draws the same refusal — the rule reads the import specifier, so aliasing the package or importing it lazily does not satisfy it. Express the same styling with Tailwind utility classes and the shadcn primitives in `packages/ui/src/components/ui/`, editing the imports and the markup in this same file.'));
    }
    if ((filePath.endsWith('.tsx') || filePath.endsWith('.ts')) && /from ['"][^'"]+\.css\.ts['"]/.test(content)) {
      violations.push(block('css-ts-import',
        '`.css.ts` (vanilla-extract) imports are no longer permitted — this file imports a generated vanilla-extract stylesheet module. Those modules mean something only under the vanilla-extract build plugin this stack does not run, so without it the import resolves to plain TypeScript whose class names were never emitted into a stylesheet and the component renders unstyled instead of failing loudly. Re-issuing the file unchanged draws the same refusal — the rule reads the import specifier, so renaming the stylesheet module while keeping the import does not satisfy it. Replace the imported style references with Tailwind utility classes in this same file and theme them through the HSL CSS variables in `globals.css`.'));
    }
  }

  // Test files are exempt from the no-any rule (B12): coarse typing of mocks,
  // fixtures, and harness plumbing is idiomatic in tests and blocking it stalls
  // the tester role over style, not correctness.
  if ((filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && /:\s*any\b/.test(content)
    && !isTestScopePath(filePath)) {
    violations.push(block('no-any',
      'Avoid `any` — this non-test `.ts`/`.tsx` annotates a value with the `any` type, which turns off type checking for every downstream use of that value. An `any` spreads silently through assignments and return types, so the errors it hides surface later in a sibling role build instead of in your own, where they cost a fix cycle just to attribute. Re-issuing the file unchanged draws the same refusal — the rule reads the annotation, so widening it to an array of `any` or casting through it does not satisfy it. Replace the annotation with `unknown` plus a narrowing check, a precise interface, or a discriminated union in this same file; files in test scope are exempt, so a mock or fixture may keep its coarse typing.'));
  }

  const allowedWsPaths = /(packages\/ws-client|src\/services\/ws)/;
  if ((filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && content.includes(WS_CTOR) && !allowedWsPaths.test(filePath)) {
    violations.push(block('websocket-location',
      'WebSocket construction belongs to the transport layer — this file constructs a WebSocket outside `packages/ws-client/` and `src/services/ws/`. A socket opened next to the UI is created and abandoned with the component that opened it, so reconnect, backoff, and fan-out to other subscribers have nowhere to live and every remount opens another connection. Re-issuing the file unchanged draws the same refusal — the rule reads the constructor call together with the path, so wrapping the call in a local helper does not satisfy it. Move the connection into `packages/ws-client/` or `src/services/ws/` and subscribe to it from here through a hook; if neither path is in your compiled allowlist, name this file and the transport module you need in your digest with verdict `BLOCKED`.'));
  }

  return violations;
}

// Bind a SkillBlockFn to the plan-guard module with a verbatim fallback.
export function makePlanBlock(skillBlock: SkillBlockFn): Block {
  return (name, fallback, vars = {}) => skillBlock('plan-guard', name, vars, fallback);
}
