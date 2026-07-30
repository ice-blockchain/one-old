---
description: "Apply only when CompiledArchitectureV1 profileId=vite-react: React/Vite topology for managed workspace, flat-root, or detected custom web roots."
---

# New Project Profile — React + Vite

Apply only when `CompiledArchitectureV1.profile.profileId=vite-react`.
This rule covers every React/Vite topology; it is not limited to the default
stack and is not a fallback for other web frameworks.

The complete cross-stack index and overlays are in
`rules/modes/new-project-architecture.md`.
Eligible implementer(s), not the architect, create only paths in their active
`WorkUnitContractV1`.

## Runtime-selected topology

Use `<web-root>` from the compiled profile. Exactly one shape applies:

- **Managed workspace:** `<web-root>` is `apps/web` for a new default/legacy
  React realtime stack, or for an explicitly selected React/Vite frontend with
  an owned backend. Root workspace manifests are then compiled.
- **Flat frontend:** `<web-root>` is `.` for a frontend-only project without a
  detected workspace root.
- **Detected/custom workspace:** `<web-root>` is the frozen detected root such
  as `web`, `frontend`, `client`, or another workspace. Preserve it.

Never move a flat/custom Vite project into `apps/web`, and never flatten the
managed workspace. `profile.sourceRoots`, not stack folklore, is authoritative.

## Compiled shape

```
<web-root>/
├── package.json
├── index.html
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── vite-env.d.ts
│   ├── main.tsx | main.jsx         selected entrypoint
│   ├── App.tsx                     when an app-shell module is planned
│   ├── pages/                      compiled page modules
│   ├── components/                 compiled app components
│   ├── features/<name>/index.ts    compiled feature modules
│   └── lib/                        UI-local service/store modules
└── public/
    ├── robots.txt
    ├── sitemap.xml
    ├── manifest.webmanifest
    ├── favicon.ico
    ├── favicon.svg
    ├── apple-touch-icon.png
    ├── icons/icon-192.png
    ├── icons/icon-512.png
    └── og-image.png

packages/
├── ui/package.json
├── ui/src/index.ts
├── i18n/package.json
├── i18n/src/index.ts
├── i18n/src/locales/<lang>/common.json
├── i18n/src/locales/<lang>/<route-id>.json
├── i18n/src/locales/<lang>/<feature-id>.json
├── tailwind-config/package.json
└── tailwind-config/src/globals.css
```

The compiler also adds the common repository/tooling, backend, environment,
and QA overlays from the catalog. Root `vitest.config.ts`,
`playwright.config.ts`, and `tests/e2e/smoke.spec.ts` remain tester-owned even
when `<web-root>` is nested. Backend-owned `service`/`store` modules follow the
backend overlay instead of `src/lib`.

This tree describes deterministic scaffold and conventional module locations;
the selected entrypoint, `modules[].output`, `scaffoldOutputs`, and
`allowedOutputs` decide the exact files. Do not create uncompiled route,
store, style, config, package, or platform files.

## Default managed-workspace checklist

`rules/modes/new-project-setup.md` is the ordered implementation checklist only
for the default stack (or legacy `react-realtime-monorepo`) whose compiled
React/Vite root is `apps/web`. Read only the checklist sections relevant to
the active outputs. Flat-root and custom-root React/Vite projects do not inherit
that playbook or its Supabase assumptions.

When the capability profile also contains the `ionic-capacitor` skill bucket,
apply the Ionic overlay in `rules/modes/new-project-architecture.md`; it does
not change this profile id or widen the allowlist.
