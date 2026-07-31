# AST lint-layer corpus — real-install verification still pending

The WRITE-TIME half of the Part-7 corpus is implemented and permanent:
`src/test-environment/core/lint-corpus/` feeds known-good idiomatic fixtures
(and one known-bad per gate family) through every blocking write-time gate —
`npm test` runs it on every change, and `npm run test:env -- --category=lint-corpus`
runs it as a release case with a persisted per-fixture report.

What this file tracks remains OPEN: fixtures whose enforcement moved from the
retired lexical Phase-5 scanners to the compiled AST lint layer
(`eslint-plugin-i18next` / stylelint — see
`src/shared/architecture-contract/scaffold-content.ts`). This repo's hook
runtime is dependency-free, so unit tests only assert the compiled config
CONTAINS the owning rule; each fixture below is **marked for corpus
verification**: a follow-up must run the scaffolded `eslint.config.js` /
`.stylelintrc.json` against these sources in a real install (network + npm
install, so outside the deterministic `npm test` tier) and confirm the stated
verdict.

Every fixture is the exact source of a removed lexical test
(`src/shared/__tests__/i18n-enforcement.test.ts` pre-retirement, plus the
collapse/tailwind createElement cases). Bug classes covered by construction
(no fixture needed):

- **createElement UI hidden in `.ts`** (`STRUCT_UI_IN_NON_JSX_MODULE`): no
  compiled module kind emits UI to `.ts` anymore (feature entries compile to
  `.tsx`), tsc rejects JSX in `.ts`, and the lint layer's `files` glob covers
  `.ts` anyway — copy handed to `createElement()` there is still validated by
  `i18next/no-literal-string` with `mode: 'all'`.

## 1. createElement `<Trans>` with ns/key/fallback — expected: clean

Owning rule: `i18next/no-literal-string` must NOT flag the fallback literals
(`jsx-components`/callee handling of `Trans`); `common:welcome`/`common:browse`
catalog presence stays owned by `STRUCT_I18N_CATALOG` (still blocking).

```tsx
import { createElement as h } from 'react';
import { Trans } from 'react-i18next';
export function Welcome() {
  return h('main', null,
    h('h1', null, h(Trans, { ns: 'common', i18nKey: 'welcome' }, 'Welcome')),
    h('p', null, h(Trans, { ns: 'common', i18nKey: 'browse' }, h('strong', null, 'Browse'), ' courses')),
  );
}
```

## 2. createElement hardcoded copy — expected: flagged

Owning rule: `i18next/no-literal-string` with `mode: 'all'` must flag every
multi-word literal: `'Save your progress'` (child), `'Course cover'` (alt),
`'Search courses'` (placeholder). Single-token strings are deliberately
excluded by the `words.exclude` patterns (false-deny-averse); calibrate those
patterns here if the plugin's own defaults differ.

```tsx
import { createElement as h } from 'react';
export function Card() {
  return h('div', null,
    h('button', null, 'Save your progress'),
    h('img', { alt: 'Course cover', src: '/cover.png' }),
    h('input', { placeholder: 'Search courses' }),
  );
}
```

## 3. Divergent `<Trans>` fallbacks for one key — expected: NOT covered by the lint layer

The retired `divergentFallbackFindings` check (one key rendered with two
materially different fallbacks; observed live: a successful contact submission
rendered "The form becomes active once the service is configured") has no
eslint-plugin-i18next equivalent. Part 7 must either find/author a rule for it
or restore an equivalent check; until then this class is documented as
knowingly advisory-only on lint-layer profiles.

```tsx
import { Trans } from 'react-i18next';
export function Status({ state }: { state: string }) {
  if (state === 'sent') return <p><Trans ns="common" i18nKey="status">Message sent</Trans></p>;
  return <p><Trans ns="common" i18nKey="status">The form becomes active once the service is configured</Trans></p>;
}
```

## 4. JSX copy in expression positions (the 13co shipped bug) — expected: flagged

```tsx
export function Result({ ok }: { ok: boolean }) {
  return <div>{ok ? <p>Your message was sent successfully</p> : null}</div>;
}
```

## 5. Collapsed createElement tree / packed one-liners — expected: flagged by prettier + max-lines

Owning tools: `prettier --check .` (format-coverage gate proves reach) rewrites
one-line trees; `max-lines`/`max-lines-per-function` in the scaffolded eslint
config bound the module. The retired `collapsedLineNumber`/`logicalLoc`
element-call arms counted these lexically.

```ts
import { createElement as h } from 'react';
export const App = () => h('main', null, h('header', null, h('nav', null, h('a', { href: '/' }, null))), h('section', null, h('article', null, null)));
```

## 6. Tailwind utilities in createElement props — expected: flagged by lint layer project-wide

The retired `CLASS_ATTR_RE` `[:=]` widening scored `h('div', { className:
'flex gap-4' })` for `STRUCT_TAILWIND_NO_TOOLCHAIN`. Post-retirement the class
is owned by the scaffolded toolchain: a project styling through Tailwind
compiles the dependency at PLAN_READY (stack contract), and inert-utility
detection on the JSX/markup path is unchanged. Part 7: verify a
createElement-only component with Tailwind classes and no toolchain still
fails the project's own build/lint chain.

```ts
import { createElement as h } from 'react';
export function CourseCard() {
  return h('article', { className: 'flex flex-col gap-3 rounded-xl bg-white p-6' },
    h('h2', { className: 'text-lg font-semibold' }, null),
  );
}
```

## 7. Collapsed/unformatted CSS (13co: 424-char `@theme` line) — expected: flagged

Owning tools: prettier (formats CSS; format-coverage gate proves reach) and
the scaffolded stylelint (`stylelint-config-standard` with Tailwind at-rules
carved out). Part 7: verify `lint:css` fails on a single-line `@theme` blob
and passes on the formatted form.

```css
@theme { --color-primary: oklch(0.7 0.15 250); --color-secondary: oklch(0.6 0.12 180); --spacing-gutter: 1.5rem; --font-display: "Inter", sans-serif; --radius-card: 0.75rem; }
```
