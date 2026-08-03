// src/modules/plan-guard/plan-static.ts
// The static layout/style half of the plan-write gate: deterministic
// checks on the target file path + content (no state/convergence deps). Ported
// 1:1 from the static checks in runCheckPlanWrite.
// Deny PROSE comes from skill/SKILL.md via skillBlock with verbatim fallbacks,
// so a missing block never disables a check.

import type { SkillBlockFn } from '../../core/types';
import { isTestScopePath } from '../../shared/feature-source';

type Vars = Record<string, string | number | null | undefined>;
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
      'Asset gate: do not write SVG/XML text into a bitmap image path such as `.png`, `.jpg`, `.webp`, or `.avif`. Save SVG content with a `.svg` extension, or generate/provide a real bitmap asset for bitmap extensions.')];
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
      'Service/store/hook/slice files belong in src/services/, src/features/<name>/, or packages/* — not in src/pages/.'));
  }

  if (/(apps\/[^/]+\/)?app\/.*\.(service|store|hook|query|slice|api)\.(ts|tsx)$/.test(filePath)) {
    violations.push(block('expo-route-service-files',
      'Expo Router route files must stay thin. Service/store/hook/slice files belong in src/features/, src/services/, or packages/*.'));
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
      'Use the workspace package name (`@app/ui`, `@app/ui-native`, `@app/utils`) instead of a deep relative path across packages.'));
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
      'Use named exports only for reusable components — including the compiled feature entry `features/<name>/index.tsx`, which is a module entry, not a route file. Route files — Expo Router files under app/ and web page components under src/pages/ — are the default-export exception.'));
  }

  if (isNative) {
    if (filePath.endsWith('.tsx') && content.includes(INLINE_STYLE)) {
      violations.push(block('native-inline-style',
        'No inline object styles — use NativeWind `className` for static styles. `StyleSheet.create` is reserved for dynamic/animated values.'));
    }
    if (filePath.endsWith('.tsx') && /\b(div|span|button|a|input)\b/.test(content)) {
      violations.push(block('native-dom-tags',
        'React Native UI must use native primitives (`View`, `Text`, `Pressable`, `TextInput`, etc.), not DOM tags.'));
    }
  } else {
    // Web: only STATIC inline styles are denied — a style object whose every
    // value is a plain literal belongs in Tailwind classes. Dynamic/derived
    // values (computed width, transform from state) are the rule's own stated
    // exception and pass.
    if (filePath.endsWith('.tsx')
      && inlineStyleObjectTexts(content, INLINE_STYLE).some(styleObjectIsStatic)) {
      violations.push(block('web-inline-style',
        'No static inline styles — use Tailwind utility `className` and shadcn primitives. Inline `style={{}}` is allowed only when a value is dynamic/derived (computed at runtime), never for constant values.'));
    }
    if ((filePath.endsWith('.tsx') || filePath.endsWith('.ts')) && /from ['"]@vanilla-extract\//.test(content)) {
      violations.push(block('vanilla-extract-import',
        'vanilla-extract is no longer in the active stack. Use Tailwind utility classes and shadcn primitives in `packages/ui/src/components/ui/`.'));
    }
    if ((filePath.endsWith('.tsx') || filePath.endsWith('.ts')) && /from ['"][^'"]+\.css\.ts['"]/.test(content)) {
      violations.push(block('css-ts-import',
        'css.ts (vanilla-extract) imports are no longer permitted. Use Tailwind utility classes; theme via the HSL CSS variables in globals.css.'));
    }
  }

  // Test files are exempt from the no-any rule (B12): coarse typing of mocks,
  // fixtures, and harness plumbing is idiomatic in tests and blocking it stalls
  // the tester role over style, not correctness.
  if ((filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && /:\s*any\b/.test(content)
    && !isTestScopePath(filePath)) {
    violations.push(block('no-any',
      'Avoid the any type — use unknown and narrow types, or define a discriminated union.'));
  }

  const allowedWsPaths = /(packages\/ws-client|src\/services\/ws)/;
  if ((filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && content.includes(WS_CTOR) && !allowedWsPaths.test(filePath)) {
    violations.push(block('websocket-location',
      'Open WebSocket connections only inside packages/ws-client/ or src/services/ws/. Components must subscribe via hooks.'));
  }

  return violations;
}

// Bind a SkillBlockFn to the plan-guard module with a verbatim fallback.
export function makePlanBlock(skillBlock: SkillBlockFn): Block {
  return (name, fallback, vars = {}) => skillBlock('plan-guard', name, vars, fallback);
}
