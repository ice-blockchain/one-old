---
# No path filter — always loaded
---

# Project Core (framework-agnostic)

Project-level conventions for any TypeScript project regardless of UI framework.
Code-quality basics live in `common/clean-code.md`; commit/PR conventions in
`common/git.md`. Stack-specific rules (forced libraries, framework absolutes)
live in `frontend/<flavour>/core.md` and load based on `.traffic-one.json`.

## TypeScript baseline

- TypeScript ^5 with strict settings — never plain JS for new files.

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

## Workspace

- **Monorepo:** Turborepo + pnpm workspaces (npm/yarn fallback only if pnpm unavailable).
- Shared code in `packages/*`. Never duplicate utilities across apps.
- Cross-package imports use workspace package names (`@app/ui`, `@app/utils`) — never deep relative paths (`../../../packages/...`).

## Validation & errors

- Validate every external input at the boundary with a typed schema (zod, valibot).
- Map transport errors to a typed `AppError` discriminated union — never leak raw transport types upstream.

## Branching — Gitflow (overrides the default in common/git.md)

- Branches: `main` (production), `develop` (integration), `feature/*`, `release/*`, `hotfix/*`.
- PRs target `develop`. Releases merge to `main` via `release/x.y.z`.
- Hotfixes branch off `main`, merge into both `main` and `develop`.
- Commit subjects include a ticket id: `feat(PROJ-123): add bet panel`.

## Stack selection

The `.traffic-one.json` `stack` field selects which framework rules load:
- `react-realtime-monorepo` / `react-frontend-only` → `frontend/react/core.md`
- `node-backend` → `backend/node.md` + `backend/postgres.md`
- `minimal` → only `common/*` baselines

Future flavours (`react-native`, `vue`, etc.) live under `frontend/<flavour>/core.md`.
