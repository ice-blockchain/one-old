---
# No path filter — always loaded
---

# Core Rules (always active)

Stack target: real-time React UI in a Turborepo monorepo, talking to back-end services
over both REST and WebSockets. Optimised for low-latency rendering, predictable state,
strict typing, and accessibility.

## Forced library stack — no exceptions

### Build & workspace
- **Monorepo**: Turborepo with pnpm workspaces (or npm/yarn workspaces if pnpm unavailable)
- **Per-app bundler**: Vite for libraries and standalone apps; Turborepo orchestrates
- **Language**: TypeScript ^5 with `"strict": true` and `"noUncheckedIndexedAccess": true`

### Runtime
- **UI**: React ^18 (.tsx/.ts only)
- **Routing**: react-router-dom v6
- **Global state**: Redux Toolkit (RTK) — slices + RTK Query for server state
- **Lightweight UI state**: zustand — only for ephemeral, non-server, non-shared-business state (e.g. modal open flags, hover state). Never duplicate server data here.
- **Real-time**: native `WebSocket` API or `socket.io-client`, wrapped in a service module — never opened directly from a component
- **HTTP**: axios in service functions, or RTK Query endpoints; never axios directly in a component
- **Forms**: react-hook-form + zod + @hookform/resolvers
- **Animations**: framer-motion for declarative motion; CSS for micro-interactions; lottie-react for pre-rendered; three.js / @react-three/fiber for 3D

### Styling
- **vanilla-extract** — `.css.ts` files generate static CSS at build time
- **Design tokens** — typed theme contracts in a shared `packages/design-tokens` package
- **No** tailwindcss, styled-components, @emotion, CSS modules, or inline `style={{}}`

### Testing
- **Unit + integration**: jest + @testing-library/react + @testing-library/user-event
- **E2E**: @playwright/test
- **Mocks**: msw for HTTP; a small in-memory WebSocket fake for real-time tests
- **Component dev**: Storybook with @storybook/react-vite

## Absolute rules — never break these

- Function components only. No class components.
- Named exports only — no `export default` for components.
- No `any` — use `unknown` and narrow.
- No inline `style={{}}` — vanilla-extract `.css.ts` only.
- Props always have an explicit `ComponentNameProps` interface.
- All API calls go through `services/` or RTK Query slices — never axios in a component.
- Server state lives in RTK Query (or Redux). Never duplicate it in zustand or component state.
- WebSocket connections are owned by a service singleton with reconnect + back-pressure logic. Components subscribe via hooks, never call `new WebSocket(...)` directly.
- Cross-package imports go through workspace package names (`@app/ui`, `@app/utils`), never deep relative paths (`../../../packages/...`).
- Shared logic belongs in `packages/`, not duplicated across `apps/`.

## Accessibility — non-negotiable

- Semantic HTML first. `<button>` for actions, `<a>` for navigation, `<dialog>` for modals.
- Every interactive element is keyboard-reachable; visible focus styles.
- ARIA only when semantic HTML doesn't cover it; never as a substitute for semantic markup.
- All images have `alt`; decorative images use `alt=""`.
- Forms: every input has an associated `<label>`; errors announced via `aria-describedby`.

## Strict TypeScript settings (tsconfig.json baseline)

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

## Git workflow — Gitflow

- Branches: `main` (production), `develop` (integration), `feature/*`, `release/*`, `hotfix/*`.
- PRs always target `develop`; releases merge to `main` via a `release/x.y.z` branch.
- Hotfixes branch off `main`, merge into both `main` and `develop`.
- Commits are granular and tied to a ticket id in the subject (e.g. `feat(PROJ-123): add bet panel`).
