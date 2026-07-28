---
description: "Apply only when CompiledArchitectureV1 profileId=generic-web: conservative custom-web roots and contract-first scaffold boundaries."
---

# New Project Profile — Generic Web

Apply only when `CompiledArchitectureV1.profile.profileId=generic-web`. This is
a conservative custom-web profile, not permission to reinterpret an unknown
framework as React/Vite.

Runtime freezes precedence candidates under `<web-root>`:

- source roots: `src`, `app`, then `pages`;
- entrypoints: `src/main.ts`, `src/main.js`, then `app`;
- pages: `src/pages`, `pages`, then `app`;
- components: `src/components`, then `components`;
- features: `src/features`, then `features`;
- libraries: `src/lib`, then `lib`.

The compiler selects baseline-backed roots and emits only semantic module
paths. Its deterministic framework scaffold is `<web-root>/package.json`;
repository/tooling, environment, backend, and web-QA overlays from
`rules/modes/new-project-architecture.md` may add exact outputs.

Use the framework and router named by the immutable profile. Do not add a Vite,
Next, Nuxt, React, or monorepo scaffold; do not create every candidate root.
If the framework requires a config, entrypoint, environment adapter, route
registry, or static asset absent from `allowedOutputs`, return a planning
blocker and recompile.
