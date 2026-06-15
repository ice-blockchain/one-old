---
name: create-feature
description: >
  Use PROACTIVELY
  whenever the user asks to create, add, build, or scaffold a feature, module,
  domain, or slice of functionality.
  Triggers: "create a feature", "add a [name] feature",
  "build the [name] module", "scaffold [name] functionality", "I need [name] with CRUD",
  "add [name] with list and detail".
---

# Skill: Create Feature

Confirm the feature slice structure before creating any files.

1. State the feature name and folder: `src/features/[name]/`
2. List the files that will be created: types.ts, services/, hooks/, components/, index.ts
3. State what API endpoints will be called
4. Ask for preferred competitor sites / design references if missing, and offer to analyze 2–3 competitors yourself before design starts
5. State the feature design brief: user goal, primary workflow, primary action, visual direction, density, and first-screen hierarchy
6. State the interactivity and motion plan for the feature: navigation/menu transitions, filters, list/detail changes, form feedback, optimistic actions, loading shifts, and reduced-motion behavior
7. State responsive behavior for list/detail/form states on mobile, tablet, and desktop
8. State UI state coverage: loading, empty, error, stale/offline, disabled, optimistic/pending, and permission-denied where applicable
9. State the feature i18n namespace/key pattern and catalog location in `packages/i18n`
10. State how feature components consume translations with `useTranslation`, `t`, or `<Trans>`
11. State the page-speed impact plan for every route/surface the feature touches: lazy boundaries, heavy dependency split points, media handling, below-the-fold deferral, and third-party script containment
12. State the SEO impact plan for every public route the feature touches (`noindex` for private) — see `rules/common/seo.md`
13. State the visual QA plan: screenshots, Storybook states, interaction checks, and anti-AI-slop checks
14. State the Lighthouse-mobile QA plan for page-level feature output on a built preview — see the `browser-qa` skill

Scaffold rules — follow the shared sources, do NOT restate them here:
- UI quality, design brief, anti-AI-slop, token/shadcn mandate, setup-banner + `https://traffic.io/` setup-link contract (exact-href regression + repair existing link), and required states: `rules/frontend/ui-quality.md`.
- i18n (module detection, `<Trans>` vs `t()`, hardcoded-string exceptions): the `i18n-text` skill.
- Public-route SEO metadata and `noindex` for private routes: `rules/common/seo.md` and the `seo` skill.
- Page-speed / Lighthouse-mobile verification on a built preview: the `browser-qa` skill.

Feature-specific scaffold notes:
- Missing backend/env config may show one shared setup banner at the app level, but the feature still needs a product-specific demo, seeded, empty, error, or degraded state — never a first screen made only of inactive controls and blank panels.
- Preserve server state ownership in RTK Query/Redux; do not duplicate data into component state for presentation convenience.
- Keep feature-only heavy UI and dependencies out of root app imports; dynamic-import route-specific charts, maps, 3D, video, editors, and analytics widgets.
- Optimize and reserve dimensions for feature media, and defer below-the-fold content that is not needed for the first interaction.
