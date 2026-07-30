---
description: "Apply only when CompiledArchitectureV1 profileId=server-rendered: Laravel Blade/Inertia topology, PHP/JS ownership, formatting, and QA."
---

# New Project Profile — Laravel Server-Rendered UI

Apply only when `CompiledArchitectureV1.profile.profileId=server-rendered`.
Runtime distinguishes Blade from detected Inertia React/Vue through
`profile.router`; preserve that selection.

Inertia React resolves `shadcn` and Inertia Vue resolves `shadcn-vue` when no
other UI library is explicit or detected; their reusable primitives and
compositions live in `packages/ui` per
`rules/frontend/component-system.md`. A new compatible Inertia application is
rooted at `apps/web`; existing Laravel roots remain in place. Blade remains
framework-native and never receives a forced shadcn port. Add only compiled
`uiPrimitives`.

```
<repo-root>/
├── composer.json                         backend scaffold
├── artisan                               backend scaffold
├── package.json                          frontend scaffold
├── vite.config.ts
├── resources/css/app.css
├── resources/views/                      Blade pages/components/layout
├── resources/js/
│   ├── app.ts | app.tsx | app.js         selected Inertia entrypoint
│   ├── Pages/ | pages/                   Inertia pages
│   ├── Components/ | components/
│   ├── Features/ | features/
│   └── lib/
├── app/View/                             Blade-side library candidate
├── app/Services/                         backend-owned service/store modules
└── routes/web.php                        only when semantic routes compile it
```

The alternatives are immutable precedence candidates, not duplicate trees.
Blade pages compile under `resources/views` with route-derived
`.blade.php` paths. Inertia React pages/components use `.tsx`; Inertia Vue
uses `.vue`. Laravel route registration is frontend-owned only when the
semantic plan contains routes.

The common repository/tooling, `.env.example`, web-QA, and PHP backend/test
overlays from `rules/modes/new-project-architecture.md` apply. Use `API_URL`
for a server-only external API; expose `VITE_API_URL` only when browser code
truly needs the non-secret base URL.

## Prettier and Pint coexistence

Use Prettier for JavaScript, TypeScript, JSX/TSX, Vue, CSS, JSON, and Markdown.
Use Laravel Pint for PHP. Do not install a Prettier PHP plugin or run both
formatters over `.php`/`.blade.php`; `.prettierignore` excludes PHP and Blade
sources. Invoke Pint through the backend-owned Composer manifest/script and
its normal zero-config defaults unless an explicit Pint config path is
compiled. Their ownership must not overlap. Add or change formatter
configs/scripts only when their exact paths are compiled.
Each implementer runs write-mode formatting only over paths in its own active
allowlist. Full-tree or cross-role formatter execution is check-only and belongs
to tester verification; Pint must not rewrite frontend-owned Blade or route
files from a backend work unit.

The contract wins over this tree. Do not create controllers, middleware,
providers, Inertia/Blade alternatives, or formatter files outside the active
work unit.
