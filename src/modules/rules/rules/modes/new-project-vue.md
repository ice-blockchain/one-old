---
description: "Apply only when CompiledArchitectureV1 profileId=vue: Vue/Vite source layers, scaffold, routing, and QA boundaries."
---

# New Project Profile — Vue

Apply only when `CompiledArchitectureV1.profile.profileId=vue`.

For a new project `<web-root>` is `apps/web`; Tailwind v4 resolves
`shadcn-vue` unless another UI library is explicit or detected.
`packages/ui` owns adapter-CLI primitives and reusable compositions per
`rules/frontend/component-system.md`. Add only compiled `uiPrimitives`.

```
<web-root>/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.ts | main.js                  selected entrypoint
│   ├── App.vue                            planned app shell
│   ├── pages/ | views/                    compiled pages
│   ├── components/                        compiled components
│   ├── features/<name>/index.vue
│   └── lib/ | composables/                UI-local service/store modules
└── public/                                 crawl/share asset set
```

`pages` versus `views`, and `main.ts` versus `main.js`, are frozen precedence
choices from baseline evidence. A semantic page compiles to
`<selected-pages-root>/<PascalName>.vue`; Vue Router registration belongs only
in a compiled module/entrypoint output. SFC-shaped modules default to `.vue`
and a headless entry may be delivered as `.ts` at the same base path — the
compiled base path is the contract, the build arbitrates the form.

The framework scaffold includes `package.json`, `vite.config.ts`,
`tsconfig.json`, and the catalog's public assets. Common repository/tooling,
backend, environment, and web-QA overlays apply. Use `VITE_API_URL` only for a
non-secret browser-visible external API base URL.

The contract wins over this illustrative shape. Do not add Pinia, a router
file, auto-import configuration, a second source root, or any other output
unless the compiled work unit owns it.
