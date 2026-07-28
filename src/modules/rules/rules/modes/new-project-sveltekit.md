---
description: "Apply only when CompiledArchitectureV1 profileId=sveltekit: SvelteKit file-router roots, scaffold, and QA boundaries."
---

# New Project Profile — SvelteKit

Apply only when `CompiledArchitectureV1.profile.profileId=sveltekit`.

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
        ├── features/<name>/index.ts
        └── ...                             UI-local service/store modules
```

Route parameters compile to `[name]`; `/` uses `src/routes/+page.svelte`.
SvelteKit owns route discovery, so do not add a parallel registry. The framework
scaffold includes only `package.json`, `svelte.config.js`, `vite.config.ts`, and
`tsconfig.json`; this profile does not itself promise public crawl/share assets.

The common repository/tooling, backend, environment, and web-QA overlays in
`rules/modes/new-project-architecture.md` apply when compiled. Use
`PUBLIC_API_URL` for browser-visible external API configuration and `API_URL`
server-side.

Follow the selected entrypoint, `modules[].output`, `scaffoldOutputs`, and
`allowedOutputs`. Do not invent hooks, server endpoints, adapters, static
assets, or alternate roots.
