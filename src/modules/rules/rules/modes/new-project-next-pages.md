---
description: "Apply only when CompiledArchitectureV1 profileId=next-pages: Next.js Pages Router roots, file routes, scaffold, and QA boundaries."
---

# New Project Profile — Next.js Pages Router

Apply only when `CompiledArchitectureV1.profile.profileId=next-pages`. The
compiled profile preserves `<web-root>/pages` or `<web-root>/src/pages` from
the immutable baseline.

```
<web-root>/
├── package.json
├── next.config.ts
├── tsconfig.json
├── pages/ | src/pages/
│   ├── _app.tsx                           app-shell/entrypoint
│   └── <route segments>.tsx               compiled page modules
├── components/ | src/components/          compiled components
├── features/ | src/features/              <name>/index.ts
├── lib/ | src/lib/                        UI-local service/store modules
└── public/                                 crawl/share asset set
```

Route parameters compile from `:id` or `{id}` to `[id]`; the root route uses
`index.tsx`. Preserve Pages Router semantics. Do not introduce an App Router
tree, duplicate `pages` and `src/pages`, or add a manual route registry.

The framework scaffold includes `package.json`, `next.config.ts`,
`tsconfig.json`, and the public crawl/share assets listed in
`rules/modes/new-project-architecture.md`. The catalog's repository/tooling,
environment, backend, and web-QA overlays also apply. Browser-visible external
API configuration uses `NEXT_PUBLIC_API_URL`; server-only code uses `API_URL`.

The compiled entrypoint, module outputs, scaffold outputs, and `allowedOutputs`
are the closed contract. Create no uncompiled API route, middleware, provider,
configuration, or asset.
