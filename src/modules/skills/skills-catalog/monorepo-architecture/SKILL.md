---
name: monorepo-architecture
description: Design and maintain Turborepo + pnpm monorepos for Traffic One React/Vite. Package taxonomy, dependency direction, `turbo.json`, TS project references. Use when adding an app/package, splitting into `packages/*`, or auditing boundaries.
---

# Monorepo Architecture

Turborepo + pnpm workspaces is the only supported monorepo layout for Traffic One. This skill goes beyond `rules/core.md` with the concrete package taxonomy, dependency direction, `turbo.json` pipeline, TypeScript project references, and versioning conventions agents should follow when working in `apps/*` and `packages/*`.

## When to Activate

- Scaffolding a new monorepo or adding a new `apps/<name>` or `packages/<name>` workspace.
- Splitting a single-app project into shared `packages/*` because two or more apps need the same code.
- Configuring or auditing `turbo.json`, `pnpm-workspace.yaml`, root `package.json` scripts, or TypeScript `references`.
- Reviewing cross-package imports, circular dependencies, or version drift across workspaces.
- Setting up Changesets, remote build cache, or CI install/build matrices.

Skip this skill for single-app repos with no `packages/*` and no `pnpm-workspace.yaml`.

## Workspace Layout

```text
.
├─ apps/
│  ├─ web/                  # React + Vite SPA (one per delivery target)
│  └─ mobile/               # Ionic/Capacitor or RN/Expo shell (when applicable)
├─ packages/
│  ├─ ui/                   # shadcn primitives + shared components
│  ├─ tailwind-config/      # Tailwind preset (HSL tokens, plugins)
│  ├─ eslint-config/        # shared ESLint flat config
│  ├─ tsconfig/             # base + app/library tsconfig.json files
│  ├─ i18n/                 # shared i18next resources + typed keys
│  ├─ types/                # cross-cutting domain types / zod schemas
│  ├─ api/                  # RTK Query slices + service clients
│  └─ utils/                # framework-agnostic helpers (only if reused)
├─ turbo.json
├─ pnpm-workspace.yaml
├─ package.json             # root: scripts only, no app deps
└─ tsconfig.base.json
```

Add a package only when 2+ apps (or 2+ packages) need the same code. One-off helpers stay in the app that uses them — `YAGNI` beats premature extraction.

## Dependency Direction

```text
apps/*  ──►  packages/*  ──►  packages/*  (no cycles)
packages/* ─/►  apps/*    (forbidden)
```

- Apps depend on packages. Packages never depend on apps.
- Packages depend on other packages only when the dependency forms a DAG. Detect cycles in CI (`pnpm dlx madge --circular packages apps`).
- Every cross-workspace import uses the workspace name (`@app/ui`, `@app/i18n`) — never `../../packages/ui/src/...`.
- A package exports through its `package.json` `exports` field or a single `src/index.ts` barrel. Internal files are not part of the public API.

## `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Pin the package manager in the root `package.json` (use the locally installed
pnpm version — `pnpm@$(pnpm --version)` — never probe the registry for it):

```json
{
  "name": "monorepo-root",
  "private": true,
  "packageManager": "pnpm@10.12.1",
  "engines": { "node": ">=22" }
}
```

## `turbo.json` Pipeline

Minimal, deterministic pipeline. Outputs declared per task so remote cache hits are correct.

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": [".env.example", "tsconfig.base.json"],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "package.json", "tsconfig*.json", "vite.config.*"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tsconfig*.json", "package.json"],
      "outputs": []
    },
    "lint": {
      "inputs": ["src/**", ".eslintrc*", "eslint.config.*", "package.json"],
      "outputs": []
    },
    "test": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tests/**", "package.json", "jest.config.*"],
      "outputs": ["coverage/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

- `^build` runs the dependency's build before the consumer's task — required when packages emit `dist/`.
- Packages that ship raw TypeScript (no build step) drop `^build` from `typecheck`/`test` and resolve via TS project references (see below).
- Never list `node_modules/**` or `.turbo/**` in `inputs`.
- Add `globalDependencies` for files that should invalidate every task's cache (root tsconfig, lockfile is implicit).

## Root Scripts

```json
{
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "lint:fix": "turbo run lint -- --fix",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  }
}
```

Filter for a single workspace with `pnpm --filter @app/web dev` or `turbo run dev --filter=@app/web`.

## TypeScript Project References

Two valid patterns — pick one and stay consistent.

### Pattern A: Source-only packages (recommended for Traffic One)

Packages export `src/index.ts` directly; apps consume the source via path aliases and Vite handles transpile. No `dist/` in packages.

```json
// packages/ui/package.json
{
  "name": "@app/ui",
  "version": "0.0.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

App `tsconfig.json`:

```json
{
  "extends": "@app/tsconfig/app.json",
  "compilerOptions": {
    "paths": { "@app/*": ["../../packages/*/src"] }
  },
  "references": [
    { "path": "../../packages/ui" },
    { "path": "../../packages/i18n" }
  ]
}
```

Drop `^build` from turbo's `typecheck` task; project references handle order.

### Pattern B: Built packages

Packages emit `dist/` via `tsc -b` or `tsup`. Required when publishing to npm or consuming from a non-bundler runtime. Keep `^build` in turbo.

```json
{
  "name": "@app/api",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": { "build": "tsc -b" }
}
```

Never mix patterns within the same package — pick one based on consumer needs.

## Versioning

- Internal packages: keep `"version": "0.0.0"` and `"private": true`. No version bumps, no changelogs.
- Published packages (rare): use [Changesets](https://github.com/changesets/changesets) with `pnpm changeset` + `pnpm changeset version` + `pnpm -r publish`. Independent versioning per package.
- App versions live in `apps/<name>/package.json` and follow the release branch (`release/x.y.z`), not the root.

## CI Caching

GitHub Actions baseline:

```yaml
- uses: pnpm/action-setup@v4
  with: { version: 9 }
- uses: actions/setup-node@v4
  with: { node-version-file: .nvmrc, cache: pnpm }
- run: pnpm install --frozen-lockfile
- run: pnpm turbo run lint typecheck test build --cache-dir=.turbo
- uses: actions/cache@v4
  with:
    path: .turbo
    key: turbo-${{ github.sha }}
    restore-keys: turbo-
```

Remote cache (Turborepo Remote Cache or self-hosted) is opt-in: set `TURBO_TOKEN` + `TURBO_TEAM` in CI secrets, never commit them.

## Anti-Patterns

- Deep relative imports across workspaces (`../../packages/ui/src/Button`). Always import by workspace name.
- Packages depending on apps, or two packages forming an import cycle.
- A `packages/utils` dumping ground — split by concern (`packages/date`, `packages/format`) or keep the helper in its single consumer.
- Mixing source-only and built-output exports in the same package.
- Listing `node_modules/**`, `dist/**`, or `.turbo/**` in turbo `inputs`.
- Per-package ESLint / Prettier / TS configs that drift from `packages/eslint-config` and `packages/tsconfig`.
- App-specific code (routes, pages, brand assets) leaking into `packages/ui`.

## Audit Checklist

- [ ] `pnpm-workspace.yaml` lists `apps/*` and `packages/*` only.
- [ ] Root `package.json` has `private: true`, `packageManager`, and `engines.node`.
- [ ] Every package has `name: "@app/<name>"`, `private: true`, and explicit `exports`.
- [ ] `turbo.json` declares `inputs` and `outputs` per task; no `node_modules` in inputs.
- [ ] No circular package dependencies (`madge --circular`).
- [ ] No deep relative imports across workspaces (`grep -rE "from ['\"]\.\.\/\.\.\/packages\/"`).
- [ ] Shared `eslint-config`, `tsconfig`, and `tailwind-config` packages exist and are consumed by every app.
- [ ] CI uses `--frozen-lockfile` and caches `.turbo/`.
