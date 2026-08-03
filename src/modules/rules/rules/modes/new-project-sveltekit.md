---
description: "Apply only when CompiledArchitectureV1 profileId=sveltekit: SvelteKit file-router roots, scaffold, and QA boundaries."
---

# New Project Profile — SvelteKit

Apply only when `CompiledArchitectureV1.profile.profileId=sveltekit`.

For a new project `<web-root>` is `apps/web`; Tailwind v4 resolves
`shadcn-svelte` unless another UI library is explicit or detected.
`packages/ui` owns adapter-CLI primitives and reusable compositions per
`rules/frontend/component-system.md`. Add only compiled `uiPrimitives`.

```
<web-root>/
├── package.json
├── svelte.config.js
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── routes/
    │   ├── +layout.svelte                  app-shell/entrypoint
    │   └── <route segments>/+page.svelte   compiled pages
    └── lib/
        ├── components/                     compiled components
        ├── features/<name>/index.svelte
        └── ...                             UI-local service/store modules
```

Route parameters compile to `[name]`; `/` uses `src/routes/+page.svelte`.
SvelteKit owns route discovery, so do not add a parallel registry.
`+page`/`+layout` filenames stay pinned; a feature entry defaults to
`index.svelte` and a headless entry may be delivered as `index.ts` — the
compiled base path is the contract, the build arbitrates the form. The framework
scaffold includes only `package.json`, `svelte.config.js`, `vite.config.ts`, and
`tsconfig.json`; this profile does not itself promise public crawl/share assets.

The common repository/tooling, backend, environment, and web-QA overlays in
`rules/modes/new-project-architecture.md` apply when compiled. Use
`PUBLIC_API_URL` for browser-visible external API configuration and `API_URL`
server-side.

Follow the selected entrypoint, `modules[].output`, `scaffoldOutputs`, and
`allowedOutputs`. Do not invent hooks, server endpoints, adapters, static
assets, or alternate roots.
