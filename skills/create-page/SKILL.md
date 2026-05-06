---
name: create-page
description: >
  Use PROACTIVELY whenever the user asks to create, add, or build a page, route, screen, or view.
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
13. State the visual QA plan: Playwright screenshots or Storybook/page states at representative breakpoints, including an anti-AI-slop check
14. State the Lighthouse QA plan: built production preview, mobile audit, primary route, optimize for the best practical Performance score with 100 as ideal

Scaffold rules:
- Route titles, headings, empty/loading/error states, navigation labels, and ARIA copy use translation keys.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
- The first screen is the actual usable app/tool experience unless the user explicitly asks for a landing page.
- Avoid generic AI-generated website tells: centered stock-gradient heroes, generic hero + 3-card-grid layouts, decorative card piles, timid typography, and workflow-free dashboard panels. Layout must express the product workflow and primary action.
- Design-led pages include purposeful animation and interactive feedback using the active stack's approved motion library, while respecting reduced-motion preferences.
- Use Tailwind utility classes + shadcn primitives from `packages/ui/src/components/ui/`. Pull values from Tailwind tokens (`bg-primary`, `text-muted-foreground`, `rounded-lg`, …) backed by the shadcn HSL CSS variables in `globals.css`. No inline `style={{}}` for static styling, no `.css.ts` / vanilla-extract, no hardcoded visual values, no ad hoc decorative shells.
- Page routes are lazy-loaded with Suspense; do not import route-only heavy components, charts, maps, 3D, video, editors, analytics widgets, or demo data in the app root.
- All page media reserves dimensions, uses optimized formats where applicable, and defers below-the-fold loading.
- For page-level output, optimize Lighthouse mobile Performance on a built preview as much as practical; if not run, state page speed as unverified and list risks.

<!-- TODO: full scaffold template goes here once structure is validated -->
