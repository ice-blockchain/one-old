---
name: create-feature
description: >
  Use PROACTIVELY whenever the user asks to create, add, build, or scaffold a feature, module,
  domain, or slice of functionality. Triggers: "create a feature", "add a [name] feature",
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
12. State the visual QA plan: screenshots, Storybook states, interaction checks, and anti-AI-slop checks
13. State the Lighthouse QA plan for page-level feature output: built production preview, mobile audit, primary route, optimize for the best practical Performance score with 100 as ideal

Scaffold rules:
- Feature UI copy, form labels, placeholders, validation errors, alt text, ARIA labels, and loading/error/empty states use translation keys.
- Keep server-provided/user-generated content unlocalized unless the UI supplies fallback copy.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
- Use Tailwind utility classes + shadcn primitives from `packages/ui/src/components/ui/` for all feature UI styling. Pull values from Tailwind tokens (`bg-primary`, `text-muted-foreground`, `rounded-lg`, …) backed by the shadcn HSL CSS variables in `globals.css`; extend the Tailwind preset in `packages/tailwind-config` before introducing new tokens. No hardcoded visual values.
- Feature surfaces should answer the user's workflow question first, then add polish. Do not scaffold vanity dashboard panels, decorative card grids, or generic AI-generated website layouts.
- Design-led feature surfaces include purposeful animation and interactive feedback using the active stack's approved motion library, while respecting reduced-motion preferences.
- Preserve server state ownership in RTK Query/Redux; do not duplicate data into component state for presentation convenience.
- Keep feature-only heavy UI and dependencies out of root app imports; dynamic-import route-specific charts, maps, 3D, video, editors, and analytics widgets.
- Optimize and reserve dimensions for feature media, and defer below-the-fold content that is not needed for the first interaction.
- For page-level feature output, optimize Lighthouse mobile Performance on a built preview as much as practical; if not run, state page speed as unverified and list risks.

<!-- TODO: full scaffold template goes here once structure is validated -->
