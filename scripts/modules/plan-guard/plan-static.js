"use strict";
// src/modules/plan-guard/plan-static.ts
// The static layout/style half of the plan-write gate: deterministic
// checks on the target file path + content (no state/convergence deps). Ported
// 1:1 from the static checks in runCheckPlanWrite.
// Deny PROSE comes from skill/SKILL.md via skillBlock with verbatim fallbacks,
// so a missing block never disables a check.
Object.defineProperty(exports, "__esModule", { value: true });
exports.planStaticViolations = planStaticViolations;
exports.makePlanBlock = makePlanBlock;
// The runtime WebSocket-constructor token. Built by concatenation so this very
// source file does not trip the gate's own websocket-location rule.
const WS_CTOR = 'new ' + 'WebSocket(';
// Collect plan gate violations for a single file write/edit. `isNative`
// selects React Native vs web style/placement rules.
function planStaticViolations(filePath, content, isNative, block) {
    const violations = [];
    const INLINE_STYLE = 'style={' + '{';
    if (/(apps\/[^/]+\/)?src\/pages\/.*\.(service|store|hook|query|slice|api)\.(ts|tsx)$/.test(filePath)) {
        violations.push(block('pages-service-files', 'Service/store/hook/slice files belong in src/services/, src/features/<name>/, or packages/* — not in src/pages/.'));
    }
    if (/(apps\/[^/]+\/)?app\/.*\.(service|store|hook|query|slice|api)\.(ts|tsx)$/.test(filePath)) {
        violations.push(block('expo-route-service-files', 'Expo Router route files must stay thin. Service/store/hook/slice files belong in src/features/, src/services/, or packages/*.'));
    }
    if (/(apps\/[^/]+\/)?src\/[A-Z][a-zA-Z]+\.(tsx|ts)$/.test(filePath)) {
        const target = isNative
            ? 'src/components/, src/features/<name>/components/, or packages/ui-native/*'
            : 'src/components/, src/features/<name>/components/, or packages/ui/*';
        violations.push(block('component-placement', `Components must live in ${target} — not directly in src/.`, { TARGET: target }));
    }
    const featureMatch = filePath.match(/src\/features\/([^/]+)/);
    if (featureMatch) {
        const current = featureMatch[1];
        const cross = Array.from(content.matchAll(/from ['"]@\/features\/([^/'"]+)/g))
            .map((match) => match[1])
            .filter((feature) => feature !== current);
        if (cross.length > 0) {
            violations.push(block('cross-feature-import', `Cross-feature import detected (${current} -> ${cross}). Share via packages/ui, packages/ui-native, packages/utils, or a feature-agnostic store slice.`, { CURRENT: current, CROSS: String(cross) }));
        }
    }
    if (/from ['"]\.\.\/\.\.\/\.\.\/packages\//.test(content)) {
        violations.push(block('deep-relative-package', 'Use the workspace package name (`@app/ui`, `@app/ui-native`, `@app/utils`) instead of a deep relative path across packages.'));
    }
    if (filePath.endsWith('.tsx')
        && /(src|packages\/(ui|ui-native))\/(components|features|pages)\//.test(filePath)
        && /^export default /m.test(content)) {
        violations.push(block('default-export', 'Use named exports only for reusable components. Expo Router route files under app/ are the default-export exception.'));
    }
    if (isNative) {
        if (filePath.endsWith('.tsx') && content.includes(INLINE_STYLE)) {
            violations.push(block('native-inline-style', 'No inline object styles — use NativeWind `className` for static styles. `StyleSheet.create` is reserved for dynamic/animated values.'));
        }
        if (filePath.endsWith('.tsx') && /\b(div|span|button|a|input)\b/.test(content)) {
            violations.push(block('native-dom-tags', 'React Native UI must use native primitives (`View`, `Text`, `Pressable`, `TextInput`, etc.), not DOM tags.'));
        }
    }
    else {
        if (filePath.endsWith('.tsx') && content.includes(INLINE_STYLE)) {
            violations.push(block('web-inline-style', 'No inline styles — use Tailwind utility `className` and shadcn primitives. Inline style is reserved for dynamic/derived values.'));
        }
        if ((filePath.endsWith('.tsx') || filePath.endsWith('.ts')) && /from ['"]@vanilla-extract\//.test(content)) {
            violations.push(block('vanilla-extract-import', 'vanilla-extract is no longer in the active stack. Use Tailwind utility classes and shadcn primitives in `packages/ui/src/components/ui/`.'));
        }
        if ((filePath.endsWith('.tsx') || filePath.endsWith('.ts')) && /from ['"][^'"]+\.css\.ts['"]/.test(content)) {
            violations.push(block('css-ts-import', 'css.ts (vanilla-extract) imports are no longer permitted. Use Tailwind utility classes; theme via the HSL CSS variables in globals.css.'));
        }
    }
    if ((filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && /:\s*any\b/.test(content)) {
        violations.push(block('no-any', 'Avoid the any type — use unknown and narrow types, or define a discriminated union.'));
    }
    const allowedWsPaths = /(packages\/ws-client|src\/services\/ws)/;
    if ((filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && content.includes(WS_CTOR) && !allowedWsPaths.test(filePath)) {
        violations.push(block('websocket-location', 'Open WebSocket connections only inside packages/ws-client/ or src/services/ws/. Components must subscribe via hooks.'));
    }
    return violations;
}
// Bind a SkillBlockFn to the plan-guard module with a verbatim fallback.
function makePlanBlock(skillBlock) {
    return (name, fallback, vars = {}) => skillBlock('plan-guard', name, vars, fallback);
}
