---
paths:
  - "apps/**/src/**"
  - "packages/ui/**"
  - "src/**"
---

# React (web) — Stack Core

Forced library list and absolute rules for React in the browser. For TypeScript /
monorepo / Gitflow conventions see `rules/core.md`. Detail rules live in
`rules/frontend/*`, `rules/frontend/react/*`, and `rules/frontend/ionic/*` when
delivering mobile with Ionic/Capacitor.

## Forced library stack — no exceptions

### Runtime
- **UI:** react ^18 (.tsx/.ts only)
- **Routing:** react-router-dom v6
- **Global state:** Redux Toolkit (slices + RTK Query)
- **Lightweight UI state:** zustand — ephemeral only, never server data
- **Real-time:** native `WebSocket` / `socket.io-client` behind a service singleton
- **HTTP:** axios in services or RTK Query — never axios directly in components
- **Forms:** react-hook-form + zod + @hookform/resolvers
- **i18n:** i18next + react-i18next; shared typed resources in `packages/i18n`
- **Animations:** framer-motion + CSS + lottie-react / @react-three/fiber
- **Hybrid mobile:** Ionic Framework + Capacitor. The recommended path is
  packaging the existing/generated React app with Capacitor. Detailed hybrid
  rules live in `rules/frontend/ionic/*`.

### Build
- Vite per-app; Turborepo orchestrates the workspace.

### Styling
- **vanilla-extract** — `.css.ts` static CSS at build time.
- Design tokens in `packages/design-tokens`.
- No tailwindcss, styled-components, @emotion, CSS modules, inline `style={{}}`.

### Testing
- jest + @testing-library/react + @testing-library/user-event
- @playwright/test (E2E)
- msw + in-memory WS fake
- Storybook (@storybook/react-vite)

## Page speed standard
- Generated React web pages optimize Lighthouse Performance on mobile against a built production preview, with 100 as the ideal score.
- Treat route splitting, optimized media, lean fonts, contained third-party scripts, and low main-thread work as default delivery work.
- If Lighthouse cannot be run, state page speed as unverified and list the likely remaining risks.

## Mobile delivery
- Mobile variant of a React web product → Ionic Framework + Capacitor packaging by default. Detail rules in `rules/frontend/ionic/core.md`.
- Switch to React Native / Expo only when the user explicitly names RN / Expo / fully native — never for generic "mobile app" requests.

## Absolute rules
- Function components only. Named exports only — no `export default` for components.
- No inline `style={{}}`, no Tailwind classes — vanilla-extract `.css.ts` only.
- Props have an explicit `ComponentNameProps` interface.
- All API calls via `services/` or RTK Query — never axios in components.
- User-facing text, placeholders, labels, loading/error/empty copy, alt text, ARIA labels come from i18n translation keys. Hardcoded strings only for brand names, user/server-provided content, technical IDs, test fixtures.
- Server state in RTK Query/Redux only — never duplicated in zustand or component state.
- WebSocket connections owned by a service singleton; components subscribe via hooks.
- New apps use `packages/i18n`; existing apps with a mature i18n package may keep it but new UI copy still uses `i18next`/`react-i18next`.
