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
5. State the page design brief: target user, primary task, visual direction, first-screen content, and what must be remembered
6. State responsive behavior for mobile, tablet, and desktop, including CTA placement and content order
7. State required page states: loading, empty, error, offline/degraded, permission-denied, and reduced-motion behavior when applicable
8. State the i18n namespace/key pattern and catalog location in `packages/i18n`
9. State whether page copy uses `useTranslation`, `t`, or `<Trans>`
10. State the visual QA plan: Playwright screenshots or Storybook/page states at representative breakpoints

Scaffold rules:
- Route titles, headings, empty/loading/error states, navigation labels, and ARIA copy use translation keys.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
- The first screen is the actual usable app/tool experience unless the user explicitly asks for a landing page.
- Avoid generic hero + 3-card-grid layouts. Layout must express the product workflow and primary action.
- Use vanilla-extract and `@app/design-tokens`; no inline styles, Tailwind, hardcoded visual values, or ad hoc decorative shells.

<!-- TODO: full scaffold template goes here once structure is validated -->
