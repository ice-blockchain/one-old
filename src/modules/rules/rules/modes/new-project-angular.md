---
description: "Apply only when CompiledArchitectureV1 profileId=angular: Angular application layers, scaffold, router, and QA boundaries."
---

# New Project Profile — Angular

Apply only when `CompiledArchitectureV1.profile.profileId=angular`.

```
<web-root>/
├── package.json
├── angular.json
├── tsconfig.json
└── src/
    ├── main.ts                             selected entrypoint
    └── app/
        ├── app.component.ts                planned app shell
        ├── pages/<name>/<name>.component.ts
        ├── components/ | shared/components/
        ├── features/<name>/index.ts
        └── core/ | shared/                 UI-local service/store modules
```

Candidate layer roots are precedence lists. Angular pages and components use
kebab-case directories and `.component.ts`; route registration must stay in an
explicit compiled module/entrypoint output.

The framework scaffold includes only `package.json`, `angular.json`, and
`tsconfig.json`; it does not itself promise public crawl/share assets. Common
repository/tooling, backend, environment, and web-QA overlays from the catalog
apply when compiled. Document a non-secret external `API_URL` and use the
project's selected runtime configuration mechanism; do not bake credentials
into a browser bundle.

Use the compiled paths, not assumptions about standalone versus NgModule
applications. Do not create environment files, modules, route registries,
assets, or alternate layer roots unless explicitly allowlisted.
