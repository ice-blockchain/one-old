---
name: traffic-one-architecture-guard
description: Wording source for the Traffic One architecture-write gate deny reasons. Read at runtime via skillBlock(); the deny conditions live in TS.
---

# Traffic One Architecture Guard

Deny-reason wording for the PreToolUse file-write/file-edit architecture gate.
Enforcement (the actual conditions + `permissionDecision:"deny"`) lives in
`src/modules/architecture-guard/`. `{{PLACEHOLDER}}` tokens are filled by the gate.
Each block has a verbatim fallback in code, so a missing block never disables a gate.

<!-- T1BLOCK:BEGIN pages-service-files -->
Service/store/hook/slice files belong in src/services/, src/features/<name>/, or packages/* — not in src/pages/.
<!-- T1BLOCK:END pages-service-files -->

<!-- T1BLOCK:BEGIN expo-route-service-files -->
Expo Router route files must stay thin. Service/store/hook/slice files belong in src/features/, src/services/, or packages/*.
<!-- T1BLOCK:END expo-route-service-files -->

<!-- T1BLOCK:BEGIN component-placement -->
Components must live in {{TARGET}} — not directly in src/.
<!-- T1BLOCK:END component-placement -->

<!-- T1BLOCK:BEGIN cross-feature-import -->
Cross-feature import detected ({{CURRENT}} -> {{CROSS}}). Share via packages/ui, packages/ui-native, packages/utils, or a feature-agnostic store slice.
<!-- T1BLOCK:END cross-feature-import -->

<!-- T1BLOCK:BEGIN deep-relative-package -->
Use the workspace package name (`@app/ui`, `@app/ui-native`, `@app/utils`) instead of a deep relative path across packages.
<!-- T1BLOCK:END deep-relative-package -->

<!-- T1BLOCK:BEGIN default-export -->
Use named exports only for reusable components. Expo Router route files under app/ are the default-export exception.
<!-- T1BLOCK:END default-export -->

<!-- T1BLOCK:BEGIN native-inline-style -->
No inline object styles — use NativeWind `className` for static styles. `StyleSheet.create` is reserved for dynamic/animated values.
<!-- T1BLOCK:END native-inline-style -->

<!-- T1BLOCK:BEGIN native-dom-tags -->
React Native UI must use native primitives (`View`, `Text`, `Pressable`, `TextInput`, etc.), not DOM tags.
<!-- T1BLOCK:END native-dom-tags -->

<!-- T1BLOCK:BEGIN web-inline-style -->
No inline styles — use Tailwind utility `className` and shadcn primitives. Inline `style={{}}` is reserved for dynamic/derived values.
<!-- T1BLOCK:END web-inline-style -->

<!-- T1BLOCK:BEGIN vanilla-extract-import -->
vanilla-extract is no longer in the active stack. Use Tailwind utility classes and shadcn primitives in `packages/ui/src/components/ui/`.
<!-- T1BLOCK:END vanilla-extract-import -->

<!-- T1BLOCK:BEGIN css-ts-import -->
`.css.ts` (vanilla-extract) imports are no longer permitted. Use Tailwind utility classes; theme via the HSL CSS variables in `globals.css`.
<!-- T1BLOCK:END css-ts-import -->

<!-- T1BLOCK:BEGIN no-any -->
Avoid `any` — use `unknown` and narrow types, or define a discriminated union.
<!-- T1BLOCK:END no-any -->

<!-- T1BLOCK:BEGIN websocket-location -->
Open WebSocket connections only inside packages/ws-client/ or src/services/ws/. Components must subscribe via hooks.
<!-- T1BLOCK:END websocket-location -->
