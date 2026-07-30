---
description: "Apply only when CompiledArchitectureV1 profileId=nuxt: Nuxt source-directory, file-router, scaffold, and QA boundaries."
---

# New Project Profile — Nuxt

Apply only when `CompiledArchitectureV1.profile.profileId=nuxt`. Runtime
preserves the configured Nuxt `srcDir` and web package root and selects the first
baseline-backed candidate rather than assuming the repository root.

For a new project the web package root is `apps/web`; Tailwind v4 resolves
`shadcn-vue` unless another UI library is explicit or detected.
`packages/ui` owns adapter-CLI primitives and reusable compositions per
`rules/frontend/component-system.md`. Add only compiled `uiPrimitives`.

```
<web-root>/
├── package.json
├── nuxt.config.ts
├── tsconfig.json
├── public/                                 crawl/share asset set
└── <nuxt-source-root>/
    ├── app/
    │   ├── app.vue                         preferred app-shell/entrypoint
    │   ├── pages/<route>.vue
    │   ├── components/
    │   ├── features/<name>/index.ts
    │   └── composables/
    ├── app.vue                             alternate entrypoint when selected
    ├── pages/                              alternate file-router root
    ├── components/ | features/
    └── composables/ | utils/
```

`<nuxt-source-root>` is the compiled `srcDir` (the web root when unset), not a
literal directory name. The alternatives are precedence candidates, not
duplicate trees. Route
parameters compile to `[name]`; `/` uses `index.vue`. Nuxt file routing owns
registration, so do not create a parallel router.

The framework scaffold includes `package.json`, `nuxt.config.ts`,
`tsconfig.json`, and the public crawl/share assets from the architecture
catalog. Common repository/tooling, backend, environment, and web-QA overlays
also apply. Use `NUXT_PUBLIC_API_BASE` for browser-visible external API
configuration and `NUXT_API_BASE` server-side.

Use the exact compiled roots, entrypoint, module outputs, and allowlist. Do not
create an uncompiled plugin, middleware, server route, module, or alternate
source tree.
