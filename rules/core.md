---
# No path filter — always loaded
---

# Project Core (framework-agnostic)

Project-level conventions for any TypeScript project. Code-quality basics in
`common/clean-code.md`; commit/PR conventions in `common/git.md`. Stack rules
(forced libraries) live in `frontend/<flavour>/core.md`.

## TypeScript baseline
- TypeScript ^5 only. `tsconfig.json` baseline:

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
- No `any` — use `unknown` and narrow. Infer types from zod / valibot schemas.

## Workspace
- **Monorepo:** Turborepo + pnpm workspaces.
- Shared code in `packages/*`; never duplicate utilities across apps.
- Cross-package imports use workspace package names (`@app/ui`) — never deep relative paths.

## Validation & errors
- Validate every external input with a typed schema at the boundary.
- Map transport errors to a typed `AppError` discriminated union.

## Branching — Gitflow (overrides `common/git.md`)
- `main` / `develop` / `feature/*` / `release/*` / `hotfix/*`.
- PRs target `develop`. Releases merge to `main` via `release/x.y.z`. Hotfixes branch off `main`, merge to both.
- Commit scope = ticket id: `feat(PROJ-123): add bet panel`.

## Stack selection
`.traffic-one.json` `stack` field selects rules. Future flavours (`react-native`, `vue`) live under `frontend/<flavour>/core.md`.
