---
name: create-component
description: >
  Use PROACTIVELY whenever the user asks to create, add, build, make, scaffold, or generate
  a React component, UI element, card, modal, form, button, table, list, or any piece of UI.
  Triggers: "create a component", "add a X component", "make a form for", "build a modal",
  "I need a table", "scaffold a card", "new UI for".
---

# Skill: Create Component

Confirm placement and props before creating any files.

1. State where the file will go (common vs feature-scoped)
2. State the props interface name
3. State whether it needs a data hook
4. State the i18n namespace/key pattern and catalog location in `packages/i18n`
5. State whether copy uses `useTranslation`, `t`, or `<Trans>`
6. Ask: "Should I go ahead?"

Scaffold rules:
- All visible copy, placeholders, labels, alt text, ARIA labels, and loading/error/empty states use translation keys.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.

<!-- TODO: full scaffold template goes here once structure is validated -->
