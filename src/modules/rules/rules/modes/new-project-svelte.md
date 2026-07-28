---
description: "Apply only when CompiledArchitectureV1 profileId=svelte: plain Svelte/Vite source layers, scaffold, routing, and QA boundaries."
---

# New Project Profile — Svelte

Apply only when `CompiledArchitectureV1.profile.profileId=svelte`.

```
<web-root>/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.ts | main.js                  selected entrypoint
│   ├── App.svelte                         planned app shell
│   ├── pages/ | routes/                   compiled pages
│   ├── components/ | lib/components/
│   ├── features/ | lib/features/
│   └── lib/                               UI-local service/store modules
└── public/                                 crawl/share asset set
```

Each pair is a precedence list; create only the selected compiled path. Plain
Svelte uses its selected router integration, not SvelteKit file conventions.
Page modules compile as `<PascalName>.svelte`.

The framework scaffold includes `package.json`, `vite.config.ts`,
`tsconfig.json`, and the catalog's public assets. Common repository/tooling,
backend, environment, and web-QA overlays apply. Use `VITE_API_URL` only for a
non-secret browser-visible external API base URL.

The immutable contract decides entrypoint and outputs. Do not add SvelteKit,
duplicate layer roots, a router registry, stores, or configuration outside the
active work unit.
