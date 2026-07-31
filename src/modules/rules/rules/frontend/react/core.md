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
- shadcn primitives live only in `packages/ui/src/components/ui/`. For every UI
  need, search the current official catalog and add the exact compiled
  identifier through the CLI; never use a fixed batch or hand-roll a catalog
  match. The full cross-framework contract is
  `rules/frontend/component-system.md`.
- Variants via `class-variance-authority` (cva). Merge classes with
  `cn()` (= `clsx` + `tailwind-merge`).
- Theme: design tokens as CSS variables (`--background`, `--foreground`,
  `--primary`, …) declared in the shared stylesheet's `@theme` block
  (`packages/tailwind-config/src/globals.css`); apps import that stylesheet, not
  a JS preset.
- Animation utilities: `tw-animate-css` (the v4-native successor to
  `tailwindcss-animate`). Icons: `lucide-react`.
- No `.css.ts`, no vanilla-extract, no styled-components, no `@emotion`,
  no CSS modules. Inline `style={{}}` is reserved for dynamic/derived values
  (animation, computed positioning) — never for static styling.

### Testing
- Vitest + @testing-library/react + @testing-library/user-event, with
  `environment: 'jsdom'` — the runtime compiles `vitest.config.ts` for this stack,
  so Vitest is the runner. A `node` environment cannot render a component, and a
  suite that cannot render falls back to asserting on source text, which proves
  nothing. See `frontend/react/testing.md` for the full recipe.
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
  A compiled feature entry (`features/<name>/index.tsx`) is a module entry, not
  a route file: export its section component and its helpers by name. That
  entry is the feature's barrel — split components/hooks/types into sibling
  files in the same feature folder as it grows; the folder is the feature's
  scope and sibling files verify.
- Props have an explicit `ComponentNameProps` interface.
- All API calls via `services/` or RTK Query — never axios in components.
- Server state in RTK Query/Redux only — never duplicated in zustand or component state.
- WebSocket connections owned by a service singleton; components subscribe via hooks.
- Styling stack is forced: Tailwind utility classes on composed shadcn primitives, `cn()` to merge, `cva` for variants, design tokens via CSS variables (see Styling above). No inline `style={{}}` for static styling.
- i18n for all user-facing copy — see `rules/frontend/i18n.md`.
