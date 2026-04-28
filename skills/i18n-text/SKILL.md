---
name: i18n-text
description: >
  Use PROACTIVELY whenever the user asks to add, change, review, extract, translate, localize,
  internationalize, or audit user-facing copy in React or React Native. Triggers: "i18n",
  "translation", "translate text", "localize", "hardcoded strings", "copy keys",
  "accessibility labels", "placeholder text".
---

# Skill: i18n Text

Use this for React web and Expo/React Native localization work.

Before changing UI copy, state:
1. Namespace and key pattern, defaulting to feature namespaces in `packages/i18n`.
2. Catalog files that will receive source-language entries.
3. Whether the component uses `useTranslation`, `t`, or `<Trans>`.
4. Any allowed hardcoded exceptions: brand names, user-generated/server-provided content, technical IDs, or test fixtures.

Implementation rules:
- Use `i18next` + `react-i18next` for React and React Native.
- Use `expo-localization` in React Native setup to read the device locale.
- Translate visible text, placeholders, form labels, validation errors, loading/error/empty copy, alt text, ARIA labels, accessibility labels, and accessibility hints.
- Prefer complete translation phrases with interpolation values over concatenated fragments.
- Keep route params, enum values, analytics names, and technical IDs unlocalized unless they are displayed to users.
- In tests, assert accessible names/labels from the rendered UI; do not couple tests to private translation internals unless testing the i18n package itself.
