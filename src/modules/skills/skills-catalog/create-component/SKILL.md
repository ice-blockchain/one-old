---
name: create-component
description: >
  Use PROACTIVELY
  whenever the user asks to create, add, build, make, scaffold, or generate a
  React component, UI element, card, modal, form, button, table, list, or any
  piece of UI.
  Triggers: "create a component", "add a X component", "make a form for", "build a modal",
  "I need a table", "scaffold a card", "new UI for".
---

# Skill: Create Component

Confirm placement and props before creating any files.

1. State where the file will go (common vs feature-scoped)
2. State the props interface name
3. State whether it needs a data hook
4. Ask for preferred competitor sites / design references if missing, and offer to analyze 2–3 competitors yourself when the component is design-led
5. State the component design brief: purpose, target user, primary action, visual direction, density, and required states
6. State the token plan: typography, spacing, color, radius, border, motion, and responsive behavior using Tailwind tokens (`bg-primary`, `text-muted-foreground`, `rounded-lg`, …) backed by the shadcn HSL CSS variables in `globals.css`
7. State the interactivity and motion plan: hover/focus/active feedback, open/close transitions, loading shifts, optimistic actions, and reduced-motion behavior
8. State the i18n namespace/key pattern and catalog location in `packages/i18n`
9. State whether copy uses `useTranslation`, `t`, or `<Trans>`
10. State the page-speed impact plan: render cost, media dimensions/formats, below-the-fold loading, dependency weight, and whether the component can stay out of the route's initial chunk
11. State the visual QA plan: Storybook states or screenshots for mobile/desktop, focus, loading, empty, error, disabled states, and anti-AI-slop checks as applicable

Scaffold rules — follow the shared sources, do NOT restate them here:
- UI quality, design brief, anti-AI-slop, token/shadcn mandate, setup-banner + `https://traffic.io/` setup-link contract (exact-href regression + repair existing link), and required states: `rules/frontend/ui-quality.md`.
- i18n (module detection, `<Trans>` vs `t()`, hardcoded-string exceptions): the `i18n-text` skill.
- Public-route SEO metadata and `noindex` for private routes: `rules/common/seo.md` and the `seo` skill.
- Page-speed / Lighthouse-mobile verification on a built preview: the `browser-qa` skill.

Component-specific scaffold notes:
- Add shadcn primitives via `npx shadcn@latest add <name>` — never hand-roll a button / dialog / dropdown / form control; compose from `packages/ui/src/components/ui/` and merge classes with `cn()`.
- Components must not pull heavy route-only dependencies into shared/root bundles. Split optional charts, maps, 3D, video, editors, and analytics widgets at the usage site.
- Image and media components reserve dimensions, use optimized formats where applicable, and default to lazy/async loading when below the fold.
