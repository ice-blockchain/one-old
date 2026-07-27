---
name: vite-patterns
description: Vite build-tool patterns for Traffic One React apps and packages. Use when editing vite.config.*, debugging Vite dev/build behavior, configuring env variables, proxies, HMR, monorepo imports, library mode, chunking, or Vite performance.
metadata:
  source: everything-claude-code
  source_path: skills/vite-patterns/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Vite Patterns

Use this skill for Vite configuration, build problems, dev-server performance,
and monorepo/package output.

## Workflow

1. Read the app/package `vite.config.*`, root `package.json`, `tsconfig*.json`,
   and workspace config.
2. Identify whether this is an app build, library build, dev-server issue, env
   issue, or deployment smoke issue.
3. Apply the smallest config change consistent with `rules/frontend/react/vite.md`.
4. Verify with separate build and type checks; do not treat `vite build` as a
   type checker.

## React defaults

- New React apps prefer `@vitejs/plugin-react-swc`.
- Use `@vitejs/plugin-react` only when a required Babel plugin makes SWC
  unsuitable.
- Use `vite-tsconfig-paths` instead of duplicating TypeScript aliases in Vite.
- Add `vite-plugin-checker` or a root `typecheck` script so type errors cannot
  ship through a successful Vite build.

## Env safety

- Only public browser config uses `VITE_`.
- Never expose service-role keys, database URLs, payment keys, private API
  tokens, or secrets through `VITE_`, `define`, or broad `loadEnv`.
- Do not set `envPrefix: ""`.
- Use `loadEnv(mode, root, ["VITE_"])` or a similarly explicit public-prefix
  list when config needs env values.

## Dev server

- Use `server.proxy` for local API routing; add `ws: true` for WebSocket routes.
- For Docker/remote dev, set `server.host: true` and configure HMR ports
  deliberately.
- In monorepos, keep `server.fs.allow` narrow and limited to the workspace
  folders the app imports.

## Performance and chunks

- Dynamic-import route-only heavy libraries: charts, maps, editors, PDF, video,
  3D, and analytics widgets.
- Use a small object-form `manualChunks` map for stable vendor groups. Avoid
  one-chunk-per-package heuristics.
- Prefer direct imports for hot-path internal modules when profiling shows
  broad barrels slow Vite. Public package barrels remain acceptable.
- Use Vite profiling before changing plugin order or removing plugins.

## Library mode

- Library packages need declaration output via `vite-plugin-dts` or
  `tsc --emitDeclarationOnly`.
- Externalize peer dependencies, especially `react`, `react-dom`, and
  `react/jsx-runtime`.

## Verification

Use the project package manager:

```bash
pnpm typecheck
pnpm build
```

For `behavioral` or `visual` page work, smoke the built preview with the local
Playwright adapter. Run the Traffic One Lighthouse runner only when the
compiled performance contract requires it.
