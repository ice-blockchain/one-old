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
4. State the component design brief: purpose, target user, primary action, visual direction, density, and required states
5. State the token plan: typography, spacing, color, radius, border, motion, and responsive behavior from `@app/design-tokens`
6. State the i18n namespace/key pattern and catalog location in `packages/i18n`
7. State whether copy uses `useTranslation`, `t`, or `<Trans>`
8. State the visual QA plan: Storybook states or screenshots for mobile/desktop, focus, loading, empty, error, and disabled states as applicable

Scaffold rules:
- All visible copy, placeholders, labels, alt text, ARIA labels, and loading/error/empty states use translation keys.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
- Use vanilla-extract sibling `.css.ts` files and existing design tokens; extend tokens before introducing ad hoc values.
- Avoid generic card shells. The component's layout, hierarchy, and state treatment must follow the design brief.
- Visual-heavy components include Storybook stories for default, hover/focus where practical, disabled, loading, empty, and error states.

<!-- TODO: full scaffold template goes here once structure is validated -->
