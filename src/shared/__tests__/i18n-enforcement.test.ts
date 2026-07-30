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
  });
});
