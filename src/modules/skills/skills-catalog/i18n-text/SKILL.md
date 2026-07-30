---
name: i18n-text
description: >
  Implement, change, review, extract, translate, localize, or audit user-facing
  copy in any web or native frontend. Apply automatically to every new Traffic
  One UI project and to changed UI in an existing project with localization.
  Triggers include i18n, translations, hardcoded strings, copy keys, labels,
  placeholders, accessibility text, screens, pages, and components.
---

# i18n Text

Before editing UI:

1. Read the compiled i18n contract or detect the existing provider/catalog.
2. State the source locale, supported locales, namespace, keys, and catalog
   files changed.
3. Reuse the current framework mechanism; never create a parallel i18n system.
4. Treat only contract-declared exact brands, dynamic user/server data,
   technical IDs, and test fixtures as literal exceptions.

For every new UI project, wire the profile-native runtime/provider before
rendering feature UI. React uses `i18next` + `react-i18next`; Expo also reads the
device locale with `expo-localization`. Other stacks keep their native
localization mechanism and resource format.

Add every new key with a non-empty value to every declared locale in the same
change. Keep locale key parity, use complete phrases and named interpolation,
and never concatenate translated fragments.

For React:

- Render every static child string with
  `<Trans ns="…" i18nKey="…">source fallback</Trans>`, including simple text.
- Require literal `ns`, literal `i18nKey`, and non-empty fallback children.
- Use one `<Trans>` with named component placeholders for links, emphasis,
  line breaks, and nested components.
- Never render `{t(...)}` as a child. Use `t()` only for string props and
  attributes, validation, metadata, or imperative APIs.

```tsx
<Trans ns="common" i18nKey="welcome">Welcome</Trans>

<input
  aria-label={t("common:searchLabel")}
  placeholder={t("common:searchPlaceholder")}
/>
```

In tests, assert visible behavior through accessible names and labels. Test
catalog parsing/key parity only when testing the i18n package itself.
