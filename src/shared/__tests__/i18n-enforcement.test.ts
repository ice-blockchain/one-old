import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  compileArchitecture,
  type ArchitectureInputV1,
} from '../architecture-contract';
import {
  analyzeI18nSourceText,
  validateI18nCatalogs,
} from '../i18n-enforcement';

const STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { framework: 'none' },
};

const INPUT: ArchitectureInputV1 = {
  schemaVersion: 1,
  routes: [{ id: 'home', path: '/', moduleId: 'home-page' }],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' },
    { id: 'home-page', name: 'Home', kind: 'page' },
    { id: 'courses-feature', name: 'Courses', kind: 'feature' },
  ],
  i18n: {
    sourceLocale: 'en',
    locales: ['en', 'ro'],
    literalBrands: ['Traffic One'],
  },
};

function withContract(fn: (cwd: string, contract: ReturnType<typeof compileArchitecture>) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-i18n-'));
  try {
    fn(cwd, compileArchitecture(cwd, 'R', STATE, INPUT));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('React child copy requires Trans while t remains valid for string-valued props', () => {
  withContract((_cwd, contract) => {
    const good = [
      "import { Trans, useTranslation } from 'react-i18next';",
      'export function Welcome({ user }: { user: { name: string } }) {',
      "  const { t } = useTranslation('common');",
      '  return (',
      '    <main>',
      '      <h1><Trans ns="common" i18nKey="welcome">Welcome</Trans></h1>',
      '      <p><Trans ns="common" i18nKey="browse"><strong>Browse</strong> courses</Trans></p>',
      '      <Trans ns="common" i18nKey="browseLink" components={{ link: <a href="/courses" /> }}>Browse courses</Trans>',
      '      <p>{user.name}</p>',
      '      <h2>Traffic One</h2>',
      '      <input placeholder={t("searchPlaceholder")} aria-label={t("searchLabel")} />',
      '    </main>',
      '  );',
      '}',
    ].join('\n');
    const accepted = analyzeI18nSourceText('apps/web/src/pages/Home.tsx', good, contract.profile, contract.i18n);
    assert.deepEqual(accepted.findings, []);
    assert.ok(accepted.references.some((reference) => (
      reference.namespace === 'common' && reference.key === 'welcome'
    )));

    const bad = [
      "import { Trans, useTranslation } from 'react-i18next';",
      'export function Bad() {',
      "  const { t } = useTranslation('common');",
      '  return (',
      '    <main>',
      '      <h1>Hardcoded heading</h1>',
      '      <h2>Traffic One documentation</h2>',
      '      <button>{t("save")}</button>',
      '      <button children={t("cancel")} />',
      '      <Trans i18nKey="missingFallback" />',
      '      <Trans ns="common" i18nKey="dynamicOnly">{user.name}</Trans>',
      '      <input placeholder="Search courses" />',
      '    </main>',
      '  );',
      '}',
    ].join('\n');
    const rejected = analyzeI18nSourceText('apps/web/src/pages/Bad.tsx', bad, contract.profile, contract.i18n);
    assert.ok(rejected.findings.some((finding) => finding.id === 'STRUCT_HARDCODED_COPY'));
    assert.ok(rejected.findings.some((finding) => (
      finding.id === 'STRUCT_I18N_REACT_TRANS' && finding.message.includes('rendered child')
    )));
    assert.ok(rejected.findings.some((finding) => finding.message.includes('self-closing')));
    assert.ok(rejected.findings.some((finding) => finding.message.includes('children={t(...)')));
    assert.ok(rejected.findings.some((finding) => finding.message.includes('source-language children fallback')));
    assert.ok(rejected.findings.some((finding) => finding.message.includes('placeholder')));
  });
});

test('Swift String Catalog validation checks every declared localization', () => {
  const state = {
    mode: 'new-project',
    stack: 'custom-frontend',
    frontend: 'none',
    backend: 'none',
    mobile: { framework: 'swift-native' },
  };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-i18n-xcstrings-'));
  try {
    const contract = compileArchitecture(cwd, 'R', state, INPUT);
    const catalog = contract.i18n!.catalogs[0]!;
    fs.writeFileSync(path.join(cwd, catalog.path), JSON.stringify({
      sourceLanguage: 'en',
      strings: {
        save: {
          localizations: {
            en: { stringUnit: { value: 'Save' } },
            ro: { stringUnit: { value: 'Salvează' } },
          },
        },
      },
    }));
    assert.deepEqual(validateI18nCatalogs(cwd, contract.i18n!), []);

    fs.writeFileSync(path.join(cwd, catalog.path), JSON.stringify({
      sourceLanguage: 'en',
      strings: {
        save: {
          localizations: {
            en: { stringUnit: { value: 'Save' } },
            ro: { stringUnit: { value: '' } },
          },
        },
      },
    }));
    assert.ok(validateI18nCatalogs(cwd, contract.i18n!)
      .some((finding) => finding.message.includes('empty')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('catalog validation requires referenced keys and non-empty locale parity', () => {
  withContract((cwd, contract) => {
    assert.ok(contract.i18n);
    const catalogs = contract.i18n!.catalogs.filter((catalog) => catalog.namespaces.includes('common'));
    for (const catalog of catalogs) {
      fs.mkdirSync(path.dirname(path.join(cwd, catalog.path)), { recursive: true });
      const locale = catalog.locales[0];
      fs.writeFileSync(path.join(cwd, catalog.path), JSON.stringify({
        welcome: locale === 'ro' ? 'Bun venit' : 'Welcome',
        searchLabel: locale === 'ro' ? 'Caută' : 'Search',
      }));
    }
    const valid = validateI18nCatalogs(cwd, contract.i18n!, {
      namespaces: ['common'],
      references: [{ namespace: 'common', key: 'welcome', line: 3 }],
    });
    assert.deepEqual(valid, []);

    const ro = catalogs.find((catalog) => catalog.locales.includes('ro'))!;
    fs.writeFileSync(path.join(cwd, ro.path), JSON.stringify({
      welcome: '',
      targetOnly: 'Numai în traducere',
    }));
    const invalid = validateI18nCatalogs(cwd, contract.i18n!, {
      namespaces: ['common'],
      references: [{ namespace: 'common', key: 'welcome', line: 3 }],
    });
    assert.ok(invalid.some((finding) => finding.message.includes('non-empty')));
    assert.ok(invalid.some((finding) => finding.message.includes('searchLabel')));
    assert.ok(invalid.some((finding) => finding.message.includes('extra key')));
    // 13cl: the classes split by scope. Parity findings span the locale PAIR
    // (no single write can satisfy them) and carry `crossLocaleParity`; the
    // single-file classes (empty values here) must NOT, so the write-time gate
    // keeps denying them immediately.
    const parity = invalid.filter((finding) => (
      finding.message.includes('required for catalog parity') || finding.message.includes('extra key')
    ));
    assert.ok(parity.length > 0);
    assert.ok(parity.every((finding) => finding.crossLocaleParity === true));
    const singleFile = invalid.filter((finding) => /has an empty/.test(finding.message));
    assert.ok(singleFile.length > 0);
    assert.ok(singleFile.every((finding) => !finding.crossLocaleParity));
  });
});

// CLDR plural forms are per-locale spellings of one logical key: English needs
// `_one`/`_other`, Romanian also `_few`, and `t('ns:key', { count })`
// references the BARE key. Exact-key parity/reference matching denied every
// correct plural catalog — a false deny on the standard i18next idiom.
test('CLDR plural-form keys satisfy parity and bare-key references across locales', () => {
  withContract((cwd, contract) => {
    assert.ok(contract.i18n);
    const catalogs = contract.i18n!.catalogs.filter((catalog) => catalog.namespaces.includes('common'));
    for (const catalog of catalogs) {
      fs.mkdirSync(path.dirname(path.join(cwd, catalog.path)), { recursive: true });
      const locale = catalog.locales[0];
      fs.writeFileSync(path.join(cwd, catalog.path), JSON.stringify(locale === 'ro'
        ? {
            lessonCount_one: 'O lecție',
            lessonCount_few: 'Câteva lecții',
            lessonCount_other: 'Multe lecții',
          }
        : {
            lessonCount_one: 'One lesson',
            lessonCount_other: 'Many lessons',
          }));
    }
    // Different category sets per locale + a bare-key reference: all satisfied.
    assert.deepEqual(validateI18nCatalogs(cwd, contract.i18n!, {
      namespaces: ['common'],
      references: [{ namespace: 'common', key: 'lessonCount', line: 4 }],
    }), []);

    // The fix must not widen past the family: a missing logical key still
    // denies, and a non-plural extra key still breaks parity.
    const ro = catalogs.find((catalog) => catalog.locales.includes('ro'))!;
    fs.writeFileSync(path.join(cwd, ro.path), JSON.stringify({
      courseCount_other: 'Cursuri',
      draftsOnly: 'Numai în traducere',
    }));
    const invalid = validateI18nCatalogs(cwd, contract.i18n!, {
      namespaces: ['common'],
      references: [{ namespace: 'common', key: 'missingEntirely', line: 9 }],
    });
    assert.ok(invalid.some((finding) => finding.message.includes('lessonCount_one')));
    assert.ok(invalid.some((finding) => finding.message.includes('extra key') && finding.message.includes('draftsOnly')));
    assert.ok(invalid.some((finding) => finding.message.includes('missingEntirely')));
    assert.ok(invalid.some((finding) => finding.message.includes('extra key') && finding.message.includes('courseCount_other')));
  });
});

// Regression: JSX child-text analysis ran on `.ts` files, where TypeScript
// REJECTS JSX. Generic type arguments were parsed as elements — `Promise<X>`
// opened a `<X>` tag and the following code read as rendered child text — so
// two generics in one plain backend service produced STRUCT_HARDCODED_COPY on
// a line holding nothing but a closing brace. Because plan-readiness force-maps
// every i18n finding to `error` on a new project, that DENIED the write: no
// backend implementer could author a typed service on a greenfield React app.
// Found by the run-sim tier on its first end-to-end React shape.
test('generic type arguments in a .ts file are not React child copy', () => {
  withContract((_cwd, contract) => {
    const service = [
      "import { supabase } from './supabase';",
      'export interface Course { id: string; slug: string }',
      'export class CoursesAPI {',
      '  async list(): Promise<Course[]> {',
      "    const rows: Course[] = await supabase.from('courses').select();",
      '    return rows;',
      '  }',
      '  async bySlug(slug: string): Promise<Course | null> {',
      "    const rows: Course[] = await supabase.from('courses').select();",
      '    return rows.find((row) => row.slug === slug) ?? null;',
      '  }',
      '}',
    ].join('\n');
    const analysis = analyzeI18nSourceText(
      'packages/api-client/src/CoursesAPI.ts',
      service,
      contract.profile,
      contract.i18n,
    );
    assert.deepEqual(analysis.findings, [], 'a .ts service cannot contain JSX, so it has no child copy');
  });
});

// The other direction: narrowing the scan must not make it blind. The same
// hardcoded copy in a `.tsx` file is still a finding.
test('hardcoded child copy in a .tsx file is still reported', () => {
  withContract((_cwd, contract) => {
    const page = [
      'export function Page() {',
      '  return (',
      '    <main>',
      '      <h1>Learn web development</h1>',
      '    </main>',
      '  );',
      '}',
    ].join('\n');
    const analysis = analyzeI18nSourceText(
      'apps/web/src/pages/Page.tsx',
      page,
      contract.profile,
      contract.i18n,
    );
    assert.ok(
      analysis.findings.some((finding) => finding.id === 'STRUCT_HARDCODED_COPY'),
      'JSX child text in a .tsx file must still be flagged',
    );
  });
});

// `t()` references are what catalog validation reads, and they are valid in a
// plain .ts file. Returning early must not drop them.
test('t() references are still collected from a .ts file', () => {
  withContract((_cwd, contract) => {
    const helper = [
      "import { t } from '@app/i18n';",
      'export function label(): string {',
      "  return t('common:courseCount');",
      '}',
    ].join('\n');
    const analysis = analyzeI18nSourceText(
      'packages/i18n/src/labels.ts',
      helper,
      contract.profile,
      contract.i18n,
    );
    assert.deepEqual(analysis.findings, []);
    assert.ok(
      analysis.references.some((reference) => reference.key === 'courseCount'),
      't() references must survive the non-JSX early return',
    );
  });
});

// The same generic-vs-JSX confusion also fired in `.tsx`, where the language
// rule cannot excuse it: `useState<Course[]>([])` is the most common idiom in
// React+TypeScript and it opened a `<Course[]>` element, collecting the code
// that followed as rendered child text. The discriminator is position — JSX
// only starts an expression, a type argument is glued to its identifier.
test('generic type arguments in a .tsx file are not JSX elements', () => {
  withContract((_cwd, contract) => {
    const component = [
      "import { useState } from 'react';",
      "import { Trans } from 'react-i18next';",
      'export function Courses() {',
      '  const [courses, setCourses] = useState<Course[]>([]);',
      '  const [news, setNews] = useState<NewsItem[]>([]);',
      '  return (',
      '    <main>',
      '      <h1><Trans ns="common" i18nKey="coursesTitle">Courses</Trans></h1>',
      '      <p>{courses.length + news.length}</p>',
      '    </main>',
      '  );',
      '}',
    ].join('\n');
    const analysis = analyzeI18nSourceText(
      'apps/web/src/pages/Courses.tsx',
      component,
      contract.profile,
      contract.i18n,
    );
    assert.deepEqual(analysis.findings, [], 'useState<T[]> must not read as a JSX element');
  });
});

// Narrowing must not blind the scanner in the file type that matters most:
// real hardcoded child text sitting next to generics is still reported.
test('hardcoded copy is still caught in a .tsx file that also uses generics', () => {
  withContract((_cwd, contract) => {
    const component = [
      "import { useState } from 'react';",
      'export function Courses() {',
      '  const [courses] = useState<Course[]>([]);',
      '  return (',
      '    <main>',
      '      <h1>Browse every course</h1>',
      '    </main>',
      '  );',
      '}',
    ].join('\n');
    const analysis = analyzeI18nSourceText(
      'apps/web/src/pages/Courses.tsx',
      component,
      contract.profile,
      contract.i18n,
    );
    const copy = analysis.findings.filter((finding) => finding.id === 'STRUCT_HARDCODED_COPY');
    assert.equal(copy.length, 1, 'exactly the real hardcoded heading, and nothing from the generic');
    assert.ok(copy[0]!.message.includes('child text'));
  });
});

// Regression: the markup scanner skipped embedded code via a 20-character
// lookbehind, which could not see past the opening tag it was testing for.
// `<script>` (8 chars) was skipped correctly, but `<script setup lang="ts">`
// (23 chars) overran the window — so the CODE inside every modern Vue SFC was
// scanned as template text and `defineProps<{ title: string }>()` was reported
// as hardcoded copy. That is the standard Vue 3 idiom, so it denied every Vue
// and Nuxt component. Found by the run-sim tier's Vue and Nuxt shapes.
test('Vue SFC script blocks are not scanned as template text', () => {
  const profile = {
    profileId: 'vue',
    framework: 'vue',
    router: 'vue-router',
    sourceRoots: ['src'],
    entrypoints: [],
    layerRoots: { pages: [], components: [], features: [], lib: [] },
    qaAdapters: [],
    surfaces: ['web-ui'],
    roles: [],
    skillBuckets: [],
  } as unknown as Parameters<typeof analyzeI18nSourceText>[2];

  const sfc = [
    '<script setup lang="ts">',
    'defineProps<{ title: string }>();',
    "const label = 'internal only';",
    '</script>',
    '',
    '<template>',
    '  <article>',
    '    <h2>{{ title }}</h2>',
    '  </article>',
    '</template>',
  ].join('\n');
  assert.deepEqual(
    analyzeI18nSourceText('src/components/Card.vue', sfc, profile).findings,
    [],
    'script-block code is not user-facing template text',
  );

  // And the scanner still sees real hardcoded copy in the template.
  const withCopy = sfc.replace('{{ title }}', 'Our latest projects');
  const findings = analyzeI18nSourceText('src/components/Card.vue', withCopy, profile).findings;
  assert.equal(findings.length, 1, 'exactly the real template copy');
  assert.equal(findings[0]!.id, 'STRUCT_HARDCODED_COPY');
});

// Regression: the attribute scan matched the name inside a BINDING. Vue's
// `:title="t('cardTitle')"` — the idiomatic way to localize an attribute — was
// reported as hardcoded copy, as were `v-bind:title` and Angular's `[title]`.
// The value of a binding is an expression, not literal text.
test('bound attributes are expressions, not hardcoded copy', () => {
  const profile = {
    profileId: 'vue',
    framework: 'vue',
    router: 'vue-router',
    sourceRoots: ['src'],
    entrypoints: [],
    layerRoots: { pages: [], components: [], features: [], lib: [] },
    qaAdapters: [],
    surfaces: ['web-ui'],
    roles: [],
    skillBuckets: [],
  } as unknown as Parameters<typeof analyzeI18nSourceText>[2];

  for (const bound of [
    '<template><Card :title="t(\'cardTitle\')" /></template>',
    '<template><Card v-bind:title="heading" /></template>',
    '<template><Card [title]="heading" /></template>',
  ]) {
    assert.deepEqual(
      analyzeI18nSourceText('src/pages/Home.vue', bound, profile).findings,
      [],
      `bound attribute must not be copy: ${bound}`,
    );
  }

  // A literal attribute value is still user-facing copy.
  const literal = '<template><Card title="Our latest projects" /></template>';
  const findings = analyzeI18nSourceText('src/pages/Home.vue', literal, profile).findings;
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.id, 'STRUCT_HARDCODED_COPY');
});

// Regression: Blade directives are CODE sitting between tags, so the markup
// scanner's `>text<` rule captured `@include('components.Card')` and reported
// idiomatic Blade as hardcoded copy. Blanked for the same reason as a script
// block. Found by the run-sim tier's Laravel Blade shape.
test('Blade directives are code, not user-facing copy', () => {
  const profile = {
    profileId: 'server-rendered',
    framework: 'laravel',
    router: 'laravel-router',
    sourceRoots: ['resources/views'],
    entrypoints: [],
    layerRoots: { pages: [], components: [], features: [], lib: [] },
    qaAdapters: [],
    surfaces: ['web-ui'],
    roles: [],
    skillBuckets: [],
  } as unknown as Parameters<typeof analyzeI18nSourceText>[2];

  const view = [
    '<main class="page">',
    "    <h1>{{ __('common.title') }}</h1>",
    "    @include('components.Card', ['title' => __('common.cardTitle')])",
    '    @if ($featured)',
    "        @include('components.Featured')",
    '    @endif',
    '</main>',
  ].join('\n');
  assert.deepEqual(
    analyzeI18nSourceText('resources/views/home.blade.php', view, profile).findings,
    [],
    'directives and __() calls are not rendered copy',
  );

  // And a real hardcoded string in the same template is still reported.
  const withCopy = view.replace("{{ __('common.title') }}", 'Our latest projects');
  const findings = analyzeI18nSourceText('resources/views/home.blade.php', withCopy, profile).findings;
  assert.equal(findings.length, 1, 'exactly the real template copy');
  assert.equal(findings[0]!.id, 'STRUCT_HARDCODED_COPY');
});

// 14cl: 7 of 17 consolidated findings were CLI-installed shadcn primitives
// (breadcrumb/pagination/sidebar/spinner) under `<sharedRoot>/src/components/
// ui/` flagged as hardcoded copy. That directory is defined BY THE CONTRACT as
// adapter-CLI-owned vendor code — `shadcn add` overwrites it wholesale — so
// demanding <Trans> there orders edits the next CLI run destroys. Only the
// `ui/` vendor dir is exempt; sibling compositions stay scanned.
test('CLI-owned shadcn vendor primitives are exempt from copy findings; sibling compositions are not', () => {
  withContract((_cwd, contract) => {
    assert.equal(contract.profile.uiSystem?.sharedRoot, 'packages/ui');
    const primitive = [
      'export function Spinner() {',
      '  return <svg role="status" aria-label="Loading" viewBox="0 0 24 24" />;',
      '}',
    ].join('\n');
    assert.deepEqual(
      analyzeI18nSourceText(
        'packages/ui/src/components/ui/spinner.tsx',
        primitive,
        contract.profile,
        contract.i18n,
      ).findings,
      [],
      'vendor primitives are overwritten by the next `shadcn add` — never a copy finding',
    );

    // One directory up: role-authored composition, still fully scanned.
    const composition = analyzeI18nSourceText(
      'packages/ui/src/components/StatusCard.tsx',
      [
        'export function StatusCard() {',
        '  return <p aria-label="Loading">Loading your courses</p>;',
        '}',
      ].join('\n'),
      contract.profile,
      contract.i18n,
    );
    assert.ok(
      composition.findings.some((finding) => finding.id === 'STRUCT_HARDCODED_COPY'),
      'non-ui compositions under the shared root stay scanned',
    );

    // References from a vendor file still feed catalog validation — the keys
    // it consumes must exist regardless of who owns the file.
    const withReference = analyzeI18nSourceText(
      'packages/ui/src/components/ui/pagination.tsx',
      [
        "import { t } from '@app/i18n';",
        'export function paginationLabel(): string {',
        "  return t('common:paginationLabel');",
        '}',
      ].join('\n'),
      contract.profile,
      contract.i18n,
    );
    assert.ok(withReference.references.some((reference) => reference.key === 'paginationLabel'));
  });
});

test('a JSDoc @example containing JSX is documentation, not copy', () => {
  withContract((_cwd, contract) => {
    const source = [
      '/**',
      ' * Formats a price.',
      ' * @example',
      ' * <Button>Save the document</Button>',
      ' */',
      "export const html = '<p>Welcome to the course</p>';",
      'export const identity = <T,>(value: T): T => value;',
      'export function price(value: number): string {',
      '  return `${value}`;',
      '}',
    ].join('\n');
    assert.deepEqual(
      analyzeI18nSourceText('apps/web/src/lib/format.tsx', source, contract.profile, contract.i18n).findings,
      [],
      'comments, string literals, and generic arrows are not rendered markup',
    );
  });
});
