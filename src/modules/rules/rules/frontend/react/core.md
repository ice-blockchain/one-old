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
- **UI:** react ^19 (.tsx/.ts only)
- **Routing:** react-router-dom ^7 (library mode — `BrowserRouter`/`Routes`,
  the drop-in v6 API; do not adopt framework mode)
- **Global state:** Redux Toolkit (slices + RTK Query)
- **Lightweight UI state:** zustand — ephemeral only, never server data
- **Real-time:** native `WebSocket` / `socket.io-client` behind a service singleton
- **HTTP:** axios in services or RTK Query — never axios directly in components
- **Forms:** react-hook-form + zod + @hookform/resolvers
- **i18n:** i18next + react-i18next; shared typed resources in `packages/i18n`.
  Translation-key policy lives in `rules/frontend/i18n.md`.
- **Animations:** framer-motion + CSS + lottie-react / @react-three/fiber
- **Hybrid mobile:** Ionic Framework + Capacitor. The recommended path is
  packaging the existing/generated React app with Capacitor. Detailed hybrid
  rules live in `rules/frontend/ionic/*`.

### Build
- Vite per-app; Turborepo orchestrates the workspace.

### Styling
- **Tailwind CSS v4** (CSS-first config) + **shadcn/ui**. Wire it with the
  `@tailwindcss/vite` plugin — no `tailwind.config.*`, no PostCSS/autoprefixer
  setup. (Ionic and React Native stacks stay on `^3.4` — see their core rules.)
- shadcn primitives live in `packages/ui/src/components/ui/` (monorepo) or
  `src/components/ui/` (single-app). Add via `npx shadcn@latest add <name>`;
  never hand-roll a button, dialog, dropdown, input, etc.
- Variants via `class-variance-authority` (cva). Merge classes with
  `cn()` (= `clsx` + `tailwind-merge`).
- Theme: design tokens as CSS variables (`--background`, `--foreground`,
  `--primary`, …) declared in the shared stylesheet's `@theme` block
  (`packages/tailwind-config/src/globals.css` in the monorepo, `src/styles/globals.css`
  single-app); apps import that stylesheet, not a JS preset.
- Animation utilities: `tw-animate-css` (the v4-native successor to
  `tailwindcss-animate`). Icons: `lucide-react`.
- No `.css.ts`, no vanilla-extract, no styled-components, no `@emotion`,
  no CSS modules. Inline `style={{}}` is reserved for dynamic/derived values
  (animation, computed positioning) — never for static styling.

### Testing
- jest + @testing-library/react + @testing-library/user-event
- @playwright/test (E2E)
- msw + in-memory WS fake
- Storybook (@storybook/react-vite)

## Page speed standard
- Lighthouse target and delivery defaults live in `rules/frontend/react/performance.md`.

## Mobile delivery
- Mobile variant of a React web product → Ionic Framework + Capacitor packaging by default. Detail rules in `rules/frontend/ionic/core.md`.
- Switch to React Native / Expo only when the user explicitly names RN / Expo / fully native — never for generic "mobile app" requests.

## Absolute rules
- Function components only; named exports only (no `export default` for reusable
  components). Route files are the exception: web page components under
  `src/pages/` and Expo Router files under `app/` may default-export — that is
  the `React.lazy` / router contract; do not wrap lazy imports in a
  `.then((m) => ({ default: m.X }))` shim just to keep a named export.
- Props have an explicit `ComponentNameProps` interface.
- All API calls via `services/` or RTK Query — never axios in components.
- Server state in RTK Query/Redux only — never duplicated in zustand or component state.
- WebSocket connections owned by a service singleton; components subscribe via hooks.
- Styling stack is forced: Tailwind utility classes on composed shadcn primitives, `cn()` to merge, `cva` for variants, design tokens via CSS variables (see Styling above). No inline `style={{}}` for static styling.
- i18n for all user-facing copy — see `rules/frontend/i18n.md`.
