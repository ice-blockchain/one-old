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
4. State the feature i18n namespace/key pattern and catalog location in `packages/i18n`
5. State how feature components consume translations with `useTranslation`, `t`, or `<Trans>`
6. Ask: "Should I go ahead?"

Scaffold rules:
- Feature UI copy, form labels, placeholders, validation errors, alt text, ARIA labels, and loading/error/empty states use translation keys.
- Keep server-provided/user-generated content unlocalized unless the UI supplies fallback copy.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.

<!-- TODO: full scaffold template goes here once structure is validated -->
