---
description: "Apply only when CompiledArchitectureV1 profileId=react-native: Expo Router roots, native scaffold, services, and Maestro QA."
---

# New Project Profile — React Native / Expo

Apply only when `CompiledArchitectureV1.profile.profileId=react-native`. This
profile is selected only for explicit React Native/Expo work; an
Ionic/Capacitor wrapper remains a web profile.

```
<repo-root>/
├── package.json
├── app.json
├── .maestro/flows/smoke.yaml             tester-owned smoke flow
└── <native-root>/
    ├── app/
    │   ├── _layout.tsx                   selected Expo Router entrypoint
    │   └── ...                           compiled screen/page modules
    └── src/
        ├── screens/
        ├── components/
        ├── features/<name>/index.tsx
        ├── lib/
        └── services/
```

`app` and `src` are profile source candidates; `app` then `src/screens` are
page candidates. Component candidates are `src/components` then
`packages/ui-native/src`. These are precedence lists, not permission to create
all roots. Semantic page names compile to the selected page root; Expo Router
registration remains in the selected `_layout.tsx` entrypoint.

A `feature` module compiles to a `.tsx` entry by default so its section can
hold JSX; the compiled base path is the contract, and a headless entry with no
JSX may be delivered as `index.ts` instead — `tsc`/build arbitrates the form.
Export that entry and its helpers by NAME — a feature entry is a module entry,
not a route file, and only Expo Router files under `app/` may `export default`.

The native scaffold is repository-relative `package.json` and `app.json`;
`<native-root>` applies only to detected source/entrypoint candidates. Common repository and
Node-tooling outputs from `rules/modes/new-project-architecture.md` also apply;
the QA adapter is Maestro. Use `EXPO_PUBLIC_API_URL` only for a non-secret
external base URL. Native secrets belong in platform secret storage.

The selected entrypoint, module outputs, scaffold outputs, and allowlist are
authoritative. Do not add `ios/`, `android/`, native plugins, EAS config, a
second router, or a shared package unless its exact output is compiled.
