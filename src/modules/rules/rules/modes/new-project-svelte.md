---
description: "Apply only when CompiledArchitectureV1 profileId=svelte: plain Svelte/Vite source layers, scaffold, routing, and QA boundaries."
---

# New Project Profile — Svelte

Apply only when `CompiledArchitectureV1.profile.profileId=svelte`.

For a new project `<web-root>` is `apps/web`; Tailwind v4 resolves
`shadcn-svelte` unless another UI library is explicit or detected.
`packages/ui` owns adapter-CLI primitives and reusable compositions per
`rules/frontend/component-system.md`. Add only compiled `uiPrimitives`.

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
Page modules compile as `<PascalName>.svelte`. Component/feature modules
default to `.svelte` and a headless entry may be delivered as `.ts` at the
same base path — the compiled base path is the contract, the build arbitrates
the form.

The framework scaffold includes `package.json`, `vite.config.ts`,
`tsconfig.json`, and the catalog's public assets. Common repository/tooling,
backend, environment, and web-QA overlays apply. Use `VITE_API_URL` only for a
non-secret browser-visible external API base URL.

The immutable contract decides entrypoint and outputs. Do not add SvelteKit,
duplicate layer roots, a router registry, stores, or configuration outside the
active work unit.
