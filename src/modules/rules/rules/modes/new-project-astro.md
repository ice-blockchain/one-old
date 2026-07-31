---
description: "Apply only when CompiledArchitectureV1 profileId=astro: Astro layouts, file routes, scaffold, and QA boundaries."
---

# New Project Profile — Astro

Apply only when `CompiledArchitectureV1.profile.profileId=astro`.

Astro uses the shadcn adapter of a detected React, Vue, or Svelte renderer and,
for a compatible new project, `<web-root>` is `apps/web`. Renderer-free Astro
keeps native primitives and is not forced into a UI-package port. Follow
`rules/frontend/component-system.md` and add only compiled `uiPrimitives`.

```
<web-root>/
├── package.json
├── astro.config.mjs
├── tsconfig.json
└── src/
    ├── layouts/Layout.astro                app-shell/entrypoint
    ├── pages/<route>.astro                 compiled pages
    ├── components/                         compiled components
    ├── features/<name>/index.astro
    └── lib/                                UI-local service/store modules
```

Route parameters compile to `[name]`; `/` uses `src/pages/index.astro`. Astro
file routing owns registration. Page filenames stay `.astro`; a feature entry
defaults to `index.astro` and a headless entry may be delivered as `index.ts`
— the compiled base path is the contract, the build arbitrates the form. The framework scaffold includes only
`package.json`, `astro.config.mjs`, and `tsconfig.json`; this profile does not
itself promise public crawl/share assets.

The catalog's repository/tooling, backend, environment, and web-QA overlays
apply when compiled. Use `PUBLIC_API_URL` for browser-visible external API
configuration and `API_URL` server-side. Keep secrets out of hydrated client
islands.

The exact compiled entrypoint, module paths, scaffold outputs, and allowlist
win. Do not invent integrations, content collections, endpoints, adapters,
static assets, or alternate layouts.
