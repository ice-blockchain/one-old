---
name: create-page
description: >
  Use PROACTIVELY
  whenever the user asks to create, add, or build a page, route, screen, or
  view.
  Triggers: "create a page", "add a route", "new screen for", "build the [name] page",
  "I need a /[path] route", "scaffold the [name] view".
---

# Skill: Create Page

Confirm the page and route before creating any files.

1. State the file: `src/pages/[Name]Page.tsx`
2. State the route path
3. State which feature components it will compose
4. State that it will be lazy-loaded with Suspense
5. Ask for preferred competitor sites / design references if missing, and offer to analyze 2–3 competitors yourself before design starts
6. State the page design brief: target user, primary task, visual direction, first-screen content, and what must be remembered
7. State the interactivity and motion plan: menu/dialog/tab transitions, hover/focus feedback, loading shifts, optimistic actions, and reduced-motion behavior
8. State responsive behavior for mobile, tablet, and desktop, including CTA placement and content order
9. State required page states: loading, empty, error, offline/degraded, permission-denied, and reduced-motion behavior when applicable
10. State the i18n namespace/key pattern and catalog location in `packages/i18n`
11. State whether page copy uses `useTranslation`, `t`, or `<Trans>`
12. State the page-speed impact plan: lazy route boundary, heavy dependency split points, media dimensions/formats, below-the-fold deferral, and third-party script containment
13. State the SEO plan for public routes (`noindex` for private) — see `rules/common/seo.md`
14. State the visual QA plan: Playwright screenshots or Storybook/page states at representative breakpoints, including an anti-AI-slop check
15. State the Lighthouse-mobile QA plan on a built preview — see the `browser-qa` skill

Scaffold rules — follow the shared sources, do NOT restate them here:
- UI quality, design brief, anti-AI-slop, token/shadcn mandate, setup-banner + `https://traffic.io/` setup-link contract (exact-href regression + repair existing link), and required states: `rules/frontend/ui-quality.md`.
- i18n (module detection, `<Trans>` vs `t()`, hardcoded-string exceptions): the `i18n-text` skill.
- Public-route SEO metadata and `noindex` for private routes: `rules/common/seo.md` and the `seo` skill.
- Page-speed / Lighthouse-mobile verification on a built preview: the `browser-qa` skill.

Page-specific scaffold notes:
- The first screen is the actual usable app/tool experience unless the user explicitly asks for a landing page; missing backend/env config may show one shared setup banner, but the page must still render a product-specific demo, seeded, empty, or degraded state — never inactive filters and blank panels.
- Page routes are lazy-loaded with Suspense; do not import route-only heavy components, charts, maps, 3D, video, editors, analytics widgets, or demo data in the app root.
- All page media reserves dimensions, uses optimized formats where applicable, and defers below-the-fold loading.
