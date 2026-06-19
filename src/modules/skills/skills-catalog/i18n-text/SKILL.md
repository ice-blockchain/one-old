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

Traffic One generation rule: apply this skill automatically for generated or
changed frontend UI whenever the project already has an i18n module, and for
new Traffic One frontend projects where `packages/i18n` is part of the
scaffold. Do not wait for the user to mention i18n, translation, localization,
or copy keys.

Before changing UI copy, state:
1. Namespace and key pattern, defaulting to feature namespaces in `packages/i18n`.
2. Catalog files that will receive source-language entries.
3. Whether the component uses `useTranslation`, `t`, or `<Trans>`, preferring
   `<Trans>` for rich copy with links, emphasis, line breaks, nested elements,
   or React components.
4. Any allowed hardcoded exceptions: brand names, user-generated/server-provided content, technical IDs, or test fixtures.

Implementation rules:
- Use `i18next` + `react-i18next` for React and React Native.
- Use `expo-localization` in React Native setup to read the device locale.
- Detect existing i18n modules before writing UI: `packages/i18n`, `src/i18n*`,
  `app/i18n*`, `locales/`, `public/locales/`, `messages/`, catalog JSON/TS
  files, `i18next`, `react-i18next`, or an existing provider wrapper.
- Extend the existing catalog/provider shape when one exists; do not create a
  parallel i18n system.
- Add source-language catalog entries in the same change for every key used.
- Translate visible text, placeholders, form labels, validation errors, loading/error/empty copy, alt text, ARIA labels, accessibility labels, and accessibility hints.
- Use `<Trans>` over `t()` when copy contains links, React elements, emphasis,
  line breaks, nested components, or rich interpolation. Use `t()` only for simple
  scalars — labels, attributes, validation strings, and a whole link/button whose
  text is one scalar (`<Link to="/x">{t('nav.x')}</Link>`).
- **The most common rich case = a sentence with an inline link.** Do NOT split it
  into `t()` fragments: `{t('login.noAccount')} <Link>{t('login.signupLink')}</Link>`
  ❌ → `<Trans i18nKey="login.noAccount" components={{ signup: <Link to="/signup" /> }}>Don't have an account? <signup>Sign up</signup></Trans>` ✅.
  Tell: a `{t(...)}` fragment next to an inline `<Link>`/`<a>`/`<strong>`/`<em>` in the
  same text node is a split sentence — make it one `<Trans>` (with source-language children).
- Prefer complete translation phrases with interpolation values over concatenated fragments.
- Keep route params, enum values, analytics names, and technical IDs unlocalized unless they are displayed to users.
- In tests, assert accessible names/labels from the rendered UI; do not couple tests to private translation internals unless testing the i18n package itself.
