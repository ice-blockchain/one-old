---
description: "Mandatory component-system resolution, catalog-first lookup, and shared packages/ui placement for every web UI profile."
globs:
  - "apps/**/*.{ts,tsx,js,jsx,vue,svelte,astro,css}"
  - "packages/ui/**/*"
  - "**/components.json"
  - "**/package.json"
---

# Shared UI and catalog-first components

The immutable capability profile selects exactly one UI system. Resolution
order is:

1. the user's explicit UI-library choice;
2. the component library already detected in the project;
3. the compatible shadcn adapter when Tailwind is selected or recommended and
   no other UI library was selected;
4. framework-native primitives when no compatible adapter exists.

The default adapters are:

| Profile | Adapter |
| --- | --- |
| React/Vite, Next.js, Ionic React, Laravel Inertia React | `shadcn` |
| Vue, Nuxt, Laravel Inertia Vue | `shadcn-vue` |
| Svelte, SvelteKit | `shadcn-svelte` |
| Astro with React, Vue, or Svelte renderer | that renderer's adapter |
| Angular, Blade, Astro without a renderer, unknown framework | framework-native |

Never introduce shadcn beside an explicit or detected external component
library. Never introduce a second UI system beside the resolved one.

## Mandatory lookup for every UI requirement

Before implementing UI:

1. Inventory every control and every reachable screen state: navigation,
   feedback, overlays, loading, empty, error, disabled, and responsive states
   as well as the obvious form/content components.
2. Inspect the public API and installed primitives in `packages/ui`.
3. Search the official catalog and CLI of the active adapter by both name and
   behavior, including synonyms. The live official catalog is the source of
   truth; do not copy a fixed component allowlist into a plan or rule.
4. When the catalog contains the component, add the exact catalog identifier
   through the active adapter's CLI if it is missing, export it from
   `packages/ui/src/index.*`, and consume it through `@app/ui`. Do not create a
   parallel implementation.
5. When no direct component exists, compose the behavior from installed or
   catalog-provided primitives before considering a new base primitive.
6. Create a custom base component only after the official lookup confirms
   there is no equivalent. Record the searched terms, catalog result, chosen
   composition, and reason in the frontend handoff digest.

Examples are semantic, not a closed list:

- progress bar → the adapter's `progress` / `Progress`;
- ordinary modal form or content → `dialog` / `Dialog`;
- destructive confirmation → `alert-dialog` / `AlertDialog`;
- lateral panel → `sheet` / `Sheet`;
- mobile bottom overlay → `drawer` / `Drawer`;
- date picker, data table, combobox, pagination, sidebar, skeleton, carousel,
  tooltip, and any other catalog match → the adapter component, not a generic
  element with hand-written behavior.

A user's generic word such as “modal”, “picker”, or “table” does not authorize a
custom `<div>` when the active official catalog provides the pattern.
Community registries are not searched or installed by default.

## Architecture contract and package boundary

`ArchitectureInputV1.uiPrimitives` contains the exact CLI identifiers required
by the planned product, deduplicated by runtime. It is demand-driven, not a
starter batch. Component modules may set `placement: "shared-ui"` only when the
component is reusable and domain-agnostic; omitted placement remains
application-local for compatibility.

For compatible new web projects, the application lives in `apps/web` and the
shared UI package is:

```text
packages/ui/
├── components.json
└── src/
    ├── components/
    │   ├── ui/        # adapter CLI output only
    │   └── ...        # reusable domain-agnostic compositions
    ├── lib/utils.*
    └── index.*
```

`components.json` is the canonical adapter configuration and must target
`packages/ui`. `src/components/ui/` is reserved for CLI-managed primitives.
Reusable compositions live in `src/components/`; page/feature-specific
components stay in the compiled application component root. `@app/ui` is the
only application-facing package API: export shared components there and do not
deep-import package internals.

Add exactly the compiled `uiPrimitives` with the active adapter CLI. If a later
feature needs another catalog component, amend semantic architecture intent and
recompile; do not install the whole catalog up front and do not manually copy
registry source. Existing projects adopt this boundary gradually: reuse what is
installed, add only missing requirements, and never perform an unrequested
mass migration.
