---
# Always loaded
---

# Project Core (framework-agnostic)

For any TypeScript project. Stack rules live in `frontend/<flavour>/core.md`.

## TypeScript baseline
- TypeScript ^5 only. `tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true
  }
}
```
- No `any`; treat caught errors and external/untrusted values as `unknown` until narrowed.
- Exported functions / hooks / public package APIs declare explicit parameter + return types; obvious locals can infer.
- `interface` for extensible object shapes and public DTOs; `type` for unions / intersections / tuples / mapped / utility types.
- String literal unions over `enum` (unless protocol or generated-code interop forces it).
- Schema-derived types via `z.infer<typeof Schema>` — never duplicate beside a schema.

## Workspace
- **Monorepo:** Turborepo + pnpm workspaces.
- Shared code in `packages/*`; cross-package imports via workspace names (`@app/ui`) — no deep relative paths.

## Validation & errors
- zod-validate every external input at the boundary.
- Map transport errors to a typed `AppError` discriminated union.

## Branching — Gitflow (overrides `common/git.md`)
- `main` / `develop` / `feature/*` / `release/*` / `hotfix/*`. PRs target `develop`.
- Releases merge to `main` via `release/x.y.z`. Hotfixes off `main` merge to both.
- Commit scope = ticket id: `feat(PROJ-123): add bet panel`.

## Stack selection
`.traffic-one.json` `stack` selects rules. Frontend flavours: `react/core.md`, `react-native/core.md`.
