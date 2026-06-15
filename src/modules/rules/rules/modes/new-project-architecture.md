---
description: "Apply when scaffolding a new Traffic One monorepo and you need the full target tree: workspace layout, package boundaries, and the turbo pipeline."
---

# New Project — Target Architecture

Read-on-demand slice of `rules/modes/new-project.md`: the full target monorepo
tree and package boundaries the setup checklist scaffolds.

```
<repo-root>/
├── package.json                   "private": true, workspaces declared
├── pnpm-workspace.yaml            apps/*  packages/*
├── turbo.json                     pipeline: build / dev / lint / test / typecheck / storybook
├── tsconfig.base.json             strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
├── .eslintrc.cjs                  shared rules; package overrides allowed
├── .prettierrc
├── .nvmrc                         pin Node major
├── .env.example                   documented env var names only, no secrets
├── .traffic-one/                  memory baseline (product/stack/coding/
│   │                              security/known-issues/agent-log/.agentignore/
│   │                              deployments.jsonl/schema.sql/decisions/) +
│   │                              generated rules/ and skills/ — canonical file
│   │                              inventory in rules/common/project-memory.md
├── .gitignore                     dist, node_modules, .turbo, coverage, playwright-report
├── .github/
│   └── workflows/                 CI/CD: verify, preview deploy, production deploy
├── vercel.json | netlify.toml | wrangler.toml
│                                    exactly one static-host manifest when deploying
├── supabase/
│   └── migrations/                SQL schema + RLS policies for Supabase-backed apps
│
├── apps/
│   └── web/                       primary React app (Vite)
│       ├── package.json
│       ├── vite.config.ts
│       ├── tsconfig.json          extends ../../tsconfig.base.json
│       ├── index.html
│       ├── src/
│       │   ├── main.tsx           ReactDOM.createRoot + Provider chain
│       │   ├── App.tsx            top-level routes + Suspense boundary
│       │   ├── routes.tsx         react-router-dom v6 routes config
│       │   ├── store/             Redux store + middleware wiring
│       │   │   ├── index.ts
│       │   │   └── hooks.ts       useAppDispatch, useAppSelector
│       │   ├── features/          feature slices: each owns components, hooks, slice, services
│       │   │   └── <name>/
│       │   │       ├── components/
│       │   │       ├── hooks/
│       │   │       ├── slice.ts
│       │   │       ├── api.ts     (RTK Query if needed)
│       │   │       └── index.ts
│       │   ├── pages/             thin route wrappers — no business logic
│       │   ├── services/
│       │   │   ├── ws/            app-specific WS bridges (if not shared in packages)
│       │   │   └── ...
│       │   ├── components/        app-only components not promoted to packages/ui yet
│       │   │   └── Seo.tsx        route-aware title/meta/canonical/JSON-LD layer
│       │   ├── lib/
│       │   │   ├── seo.ts         route metadata + JSON-LD helpers
│       │   │   └── utils.ts        cn() helper (= clsx + tailwind-merge)
│       │   └── styles/
│       │       └── globals.css     imports @app/tailwind-config/globals.css
│       ├── public/                robots, sitemap, manifest, favicon, icons, OG image
│       ├── vite.config.ts          includes the @tailwindcss/vite plugin (v4 —
│       │                           no tailwind.config.*, no postcss.config)
│       ├── components.json         shadcn/ui CLI config
│       └── e2e/                    Playwright specs
│
└── packages/
    ├── ui/                        shadcn/ui primitives (Storybook)
    │   ├── package.json           "exports": { ... }
    │   ├── src/
    │   │   ├── components/
    │   │   │   └── ui/             shadcn-installed primitives (button, input,
    │   │   │       │               card, dialog, dropdown-menu, form, sheet,
    │   │   │       │               tabs, select, sonner, badge, separator, …)
    │   │   │       └── button.tsx
    │   │   ├── lib/
    │   │   │   └── utils.ts        cn() helper (re-exported by app)
    │   │   └── index.ts            barrel: re-export public components
    │   ├── components.json         shadcn config (root for monorepo init)
    │   └── tsconfig.json
    │
    ├── tailwind-config/            shared Tailwind v4 stylesheet (CSS-first; no JS preset)
    │   ├── package.json
    │   └── src/
    │       └── globals.css         @import "tailwindcss" + design tokens in
    │                               @theme/:root blocks (light + .dark)
    │
    ├── i18n/                      shared typed i18next resources and locale config
    │   ├── package.json
    │   └── src/
    │       ├── index.ts           exports provider, resources, namespace helpers
    │       └── locales/
    │           └── en/            source-language feature namespaces
    │
    ├── api-client/                Supabase client + axios/RTK Query baseQuery
    │   └── src/
    │       ├── supabase.ts        typed Supabase browser client
    │       ├── instance.ts
    │       ├── errors.ts          AppError discriminated union
    │       └── index.ts
    │
    ├── ws-client/                 WebSocket transport + protocol layer
    │   └── src/
    │       ├── transport.ts       reconnect, heartbeat, backoff
    │       ├── protocol.ts        zod schemas + decoders
    │       ├── hooks.ts           useChannel(...) etc.
    │       └── test-fake.ts       in-memory fake for tests
    │
    ├── utils/                     pure utilities, no React imports
    │
    ├── tsconfig/                  shared TS configs (base, react, node)
    │
    └── eslint-config/             shared ESLint config
```
