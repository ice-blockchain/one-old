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
4. State the feature design brief: user goal, primary workflow, primary action, visual direction, density, and first-screen hierarchy
5. State responsive behavior for list/detail/form states on mobile, tablet, and desktop
6. State UI state coverage: loading, empty, error, stale/offline, disabled, optimistic/pending, and permission-denied where applicable
7. State the feature i18n namespace/key pattern and catalog location in `packages/i18n`
8. State how feature components consume translations with `useTranslation`, `t`, or `<Trans>`
9. State the visual QA plan: screenshots, Storybook states, and interaction checks

Scaffold rules:
- Feature UI copy, form labels, placeholders, validation errors, alt text, ARIA labels, and loading/error/empty states use translation keys.
- Keep server-provided/user-generated content unlocalized unless the UI supplies fallback copy.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
- Use `@app/design-tokens` and vanilla-extract for all feature UI styling; no hardcoded visual values.
- Feature surfaces should answer the user's workflow question first, then add polish. Do not scaffold vanity dashboard panels or decorative card grids.
- Preserve server state ownership in RTK Query/Redux; do not duplicate data into component state for presentation convenience.

<!-- TODO: full scaffold template goes here once structure is validated -->
