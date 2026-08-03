// src/test-environment/core/lint-corpus/fixtures.ts
// The false-positive corpus: legitimate, idiomatic code that historically
// triggered (or nearly triggered) false denies from the write-time gates, plus
// a small known-bad set proving each gate family still fires. Every good
// fixture names the incident it guards against — the corpus is the permanent
// regression for calibrations that used to live in one-off manual sweeps
// ("0 FP on 649 files").
//
// Fixture PATHS follow the vite-react compiled conventions but are data, not
// contract outputs: the gates under test judge path + content only. The one
// fixture that must agree with the compiled contract byte-for-byte (the lazy
// route shell) is generated from the contract itself in the factories below,
// so a compiler change can never silently desynchronize it.

import * as path from 'path';

import type { CompiledArchitectureV1 } from '../../../shared/architecture-contract';

export type CorpusGateId =
  | 'plan-static'
  | 'structure'
  | 'i18n'
  | 'catalog'
  | 'collapse'
  | 'tailwind'
  | 'forbidden-install';

export type CorpusProfileId = 'react' | 'vue' | 'generic-web';

export interface CorpusFileFixture {
  id: string;
  /** The incident (or incident class) this fixture guards against. */
  guards: string;
  profile: CorpusProfileId;
  file: string;
  content: string;
  /** Known-bad only: the gate that MUST produce a blocking finding. */
  expectBlock?: CorpusGateId;
  /**
   * Good fixtures are STRICT by default: any finding, even advisory, fails the
   * corpus. Set when a fixture legitimately produces advisory findings (they
   * are reported, never failed).
   */
  advisoryOk?: boolean;
  /** Evaluate tailwind evidence against the bare project (no toolchain). */
  bareProject?: boolean;
}

export interface CorpusCommandFixture {
  id: string;
  guards: string;
  command: string;
  expectBlock?: 'forbidden-install';
}

// ── Good: React (vite-react profile, compiled contract) ─────────────────────

export const FILE_FIXTURES: CorpusFileFixture[] = [
  {
    id: 'fx-react-trans-ternary',
    guards: '13co: ternary-wrapped <Trans> fallbacks and conditional t() were denied as hardcoded copy',
    profile: 'react',
    file: 'apps/web/src/components/StatusNotice.tsx',
    content: [
      "import { Trans, useTranslation } from 'react-i18next';",
      '',
      'export function StatusNotice({ sent }: { sent: boolean }) {',
      "  const { t } = useTranslation('common');",
      "  const tone = sent ? t('common:toneSuccess') : t('common:tonePending');",
      '  return (',
      '    <p aria-label={tone} data-tone={tone}>',
      '      {sent ? (',
      '        <Trans ns="common" i18nKey="statusSent">Message sent</Trans>',
      '      ) : (',
      '        <Trans ns="common" i18nKey="statusPending">The form becomes active once the service is configured</Trans>',
      '      )}',
      '    </p>',
      '  );',
      '}',
      '',
      'export function StatusLine({ sent }: { sent: boolean }) {',
      '  return sent',
      '    ? <Trans ns="common" i18nKey="statusSent">Message sent</Trans>',
      '    : <Trans ns="common" i18nKey="statusPending">The form becomes active once the service is configured</Trans>;',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-react-conditional-and',
    guards: '13co: `{cond && <p><Trans/></p>}` expression-position rendering read as hardcoded copy',
    profile: 'react',
    file: 'apps/web/src/components/NewsBanner.tsx',
    content: [
      "import { Trans } from 'react-i18next';",
      '',
      'export function NewsBanner({ hasNews }: { hasNews: boolean }) {',
      '  return (',
      '    <aside>',
      '      {hasNews && (',
      '        <p>',
      '          <Trans ns="common" i18nKey="latestNews">Latest news is available</Trans>',
      '        </p>',
      '      )}',
      '    </aside>',
      '  );',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-react-map-list',
    guards: '13co class: list `.map()` rendering — copy in callback/expression positions must not trip the lexical scanner',
    profile: 'react',
    file: 'apps/web/src/components/CourseList.tsx',
    content: [
      "import { Trans } from 'react-i18next';",
      '',
      "import { CourseCard } from './CourseCard';",
      '',
      'export function CourseList({ courses }: { courses: ReadonlyArray<{ id: string; title: string }> }) {',
      '  return (',
      '    <section>',
      '      <h2>',
      '        <Trans ns="common" i18nKey="coursesHeading">Courses</Trans>',
      '      </h2>',
      '      <ul>',
      '        {courses.map((course) => (',
      '          <li key={course.id}>',
      '            <CourseCard title={course.title} />',
      '          </li>',
      '        ))}',
      '      </ul>',
      '    </section>',
      '  );',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-react-jsdoc-example',
    guards: 'JSDoc `@example` holding JSX is documentation, not rendered copy — comment bodies must stay masked',
    profile: 'react',
    file: 'apps/web/src/components/badge-label.tsx',
    content: [
      '/**',
      ' * Class helper for the course badge.',
      ' *',
      ' * @example',
      ' * ```tsx',
      ' * <Button variant="primary">Save your progress</Button>',
      ' * ```',
      ' */',
      'export function badgeLabelClass(featured: boolean): string {',
      "  return featured ? 'badge badge--featured' : 'badge';",
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-react-generic-arrows',
    guards: 'useState<Course[]> / <T,>(x: T) => x generic type arguments were opened as JSX tags and their trailing code read as child text',
    profile: 'react',
    file: 'apps/web/src/components/CourseLevels.tsx',
    content: [
      "import { useState } from 'react';",
      "import { Trans } from 'react-i18next';",
      '',
      'interface Course {',
      '  id: string;',
      "  level: 'beginner' | 'advanced';",
      '}',
      '',
      'const dedupe = <T,>(values: readonly T[]): T[] => [...new Set(values)];',
      '',
      'export function CourseLevels() {',
      '  const [courses, setCourses] = useState<Course[]>([]);',
      '  const levels = dedupe(courses.map((course) => course.level));',
      '  return (',
      '    <section data-levels={levels.length} onDoubleClick={() => setCourses([])}>',
      '      <Trans ns="common" i18nKey="levelsHeading">Available levels</Trans>',
      '    </section>',
      '  );',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-react-html-string',
    guards: 'const html = "<p>…</p>" — a `<` inside a string literal is data, not an element',
    profile: 'react',
    file: 'apps/web/src/features/digest/template.tsx',
    content: [
      "const TEMPLATE = '<p>Welcome to the weekly digest</p>';",
      '',
      'export function digestTemplate(): string {',
      '  return TEMPLATE;',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-ts-dom-utils',
    guards: 'document.createElement DOM utilities in .ts must not read as misplaced React components (component-placement signal)',
    profile: 'react',
    file: 'apps/web/src/lib/dom-utils.ts',
    content: [
      'export function createFocusSentinel(label: string): HTMLElement {',
      "  const sentinel = document.createElement('div');",
      "  sentinel.setAttribute('aria-hidden', 'true');",
      '  sentinel.dataset.label = label;',
      '  return sentinel;',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-ts-api-service',
    guards: '1cu: packages/api-client/src/AuthAPIService.ts denied by unanchored component placement; Promise<Session | null> generics read as JSX in .ts',
    profile: 'react',
    file: 'packages/api-client/src/AuthAPIService.ts',
    content: [
      'export interface Session {',
      '  userId: string;',
      '  expiresAt: string;',
      '}',
      '',
      'interface RefreshResponse {',
      '  session: Session | null;',
      '  rotated: boolean;',
      '}',
      '',
      'export class AuthAPIService {',
      '  constructor(private readonly baseUrl: string) {}',
      '',
      '  async currentSession(): Promise<Session | null> {',
      '    const response = await fetch(`${this.baseUrl}/auth/session`);',
      '    if (!response.ok) return null;',
      '    return (await response.json()) as Session;',
      '  }',
      '',
      '  async refreshSession(): Promise<RefreshResponse | null> {',
      "    const response = await fetch(`${this.baseUrl}/auth/refresh`, { method: 'POST' });",
      '    if (!response.ok) return null;',
      '    return (await response.json()) as RefreshResponse;',
      '  }',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-react-tailwind-dense',
    guards: '8co calibration: className-dense Tailwind styling WITH the toolchain present is deliberate styling, never a finding',
    profile: 'react',
    file: 'apps/web/src/components/HeroPanel.tsx',
    // The tailwind gate records the toolchain-present evidence as advisory so
    // the corpus can prove the pass came from the toolchain, not an undercount.
    advisoryOk: true,
    content: [
      "import { Trans } from 'react-i18next';",
      '',
      'export function HeroPanel() {',
      '  return (',
      '    <section className="flex flex-col gap-4 rounded-xl bg-slate-900 p-6 shadow-lg">',
      '      <h1 className="text-2xl font-semibold text-slate-100">',
      '        <Trans ns="common" i18nKey="heroTitle">Learn without limits</Trans>',
      '      </h1>',
      '      <p className="text-sm leading-relaxed text-slate-300">',
      '        <Trans ns="common" i18nKey="heroBody">Courses that fit your schedule</Trans>',
      '      </p>',
      '    </section>',
      '  );',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-react-hook-form',
    guards: 'react-hook-form register spreads + t() attribute props are the idiomatic form recipe and must stay clean',
    profile: 'react',
    file: 'apps/web/src/features/auth/LoginForm.tsx',
    content: [
      "import { useForm } from 'react-hook-form';",
      "import { Trans, useTranslation } from 'react-i18next';",
      '',
      'interface LoginFields {',
      '  email: string;',
      '  password: string;',
      '}',
      '',
      'export function LoginForm({ onSubmit }: { onSubmit: (fields: LoginFields) => void }) {',
      '  const { register, handleSubmit } = useForm<LoginFields>();',
      "  const { t } = useTranslation('common');",
      '  return (',
      '    <form onSubmit={handleSubmit(onSubmit)}>',
      '      <input',
      '        type="email"',
      "        {...register('email')}",
      "        placeholder={t('emailPlaceholder')}",
      "        aria-label={t('emailLabel')}",
      '      />',
      '      <input',
      '        type="password"',
      "        {...register('password')}",
      "        placeholder={t('passwordPlaceholder')}",
      "        aria-label={t('passwordLabel')}",
      '      />',
      '      <button type="submit">',
      '        <Trans ns="common" i18nKey="signIn">Sign in</Trans>',
      '      </button>',
      '    </form>',
      '  );',
      '}',
      '',
    ].join('\n'),
  },

  // ── Good: Vue ─────────────────────────────────────────────────────────────
  {
    id: 'fx-vue-sfc-setup',
    guards: '`<script setup lang="ts">` overran the 20-char lookbehind so defineProps generics were scanned as markup; :title bindings read as hardcoded attrs',
    profile: 'vue',
    file: 'apps/web/src/components/CourseCard.vue',
    content: [
      '<script setup lang="ts">',
      "import { useI18n } from 'vue-i18n';",
      '',
      'const props = defineProps<{ title: string; lessonCount: number }>();',
      'const { t } = useI18n();',
      '</script>',
      '',
      '<template>',
      '  <article :title="t(\'common.courseCard\')">',
      '    <h2>{{ props.title }}</h2>',
      "    <p>{{ t('common.lessonCount', { count: props.lessonCount }) }}</p>",
      "    <button type=\"button\">{{ $t('common.enroll') }}</button>",
      '  </article>',
      '</template>',
      '',
    ].join('\n'),
  },

  // ── Good: plain TS ────────────────────────────────────────────────────────
  {
    id: 'fx-ts-template-html-service',
    guards: 'services building HTML inside template literals are string data — the collapse and i18n scanners must mask them',
    profile: 'react',
    file: 'packages/api-client/src/emailTemplates.ts',
    content: [
      'export interface DigestEntry {',
      '  title: string;',
      '  url: string;',
      '}',
      '',
      'export function digestEmailHtml(entries: readonly DigestEntry[]): string {',
      '  const items = entries',
      '    .map((entry) => `<li><a href="${entry.url}">${entry.title}</a></li>`)',
      "    .join('\\n');",
      '  return `<ul>\\n${items}\\n</ul>`;',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-test-inline-snapshot',
    guards: 'test files with inline snapshots (and literal props) are the tester’s own domain: never write-blocking, skipped by the completion scan',
    profile: 'react',
    file: 'apps/web/src/components/__tests__/CourseCard.test.tsx',
    advisoryOk: true,
    content: [
      "import { expect, test } from 'vitest';",
      "import { render } from '@testing-library/react';",
      '',
      "import { CourseCard } from '../CourseCard';",
      '',
      "test('renders the course badge markup', () => {",
      '  const { container } = render(<CourseCard title="TypeScript Basics" />);',
      '  expect(container.firstChild).toMatchInlineSnapshot(`',
      '    <article>',
      '      <h2>',
      '        TypeScript Basics',
      '      </h2>',
      '    </article>',
      '  `);',
      '});',
      '',
    ].join('\n'),
  },

  // ── Good: CSS / HTML ──────────────────────────────────────────────────────
  {
    id: 'fx-css-globals-theme',
    guards: '13co: the formatted @theme globals.css is mandatory scaffold content — no write-time gate may ever deny it',
    profile: 'react',
    file: 'packages/tailwind-config/src/globals.css',
    content: [
      "@import 'tailwindcss';",
      '',
      '@theme {',
      '  --color-primary: oklch(0.7 0.15 250);',
      '  --color-secondary: oklch(0.6 0.12 180);',
      '  --spacing-gutter: 1.5rem;',
      "  --font-display: 'Inter', sans-serif;",
      '  --radius-card: 0.75rem;',
      '}',
      '',
      ':root {',
      '  color-scheme: light dark;',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-html-entry-metadata',
    guards: '13co: the entry index.html <title>/<noscript>/<meta> tripped STRUCT_HARDCODED_COPY and blocked the frontend on a contract-mandated file',
    profile: 'react',
    file: 'apps/web/index.html',
    content: [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '    <meta name="description" content="Learn web development with structured courses" />',
      '    <title>Learning Platform</title>',
      '  </head>',
      '  <body>',
      '    <noscript>This application requires JavaScript to run.</noscript>',
      '    <div id="root"></div>',
      '    <script type="module" src="/src/main.tsx"></script>',
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
  },

  // ── 14cl false-positive shapes: `path:` outside a route table ─────────────
  {
    id: 'fx-react-seo-interface-path',
    guards: '14cl: `path: string;` inside a TypeScript interface (Seo.tsx:21) was reported as STRUCT_ROUTE_PATH_UNRESOLVED — a type member is not a route',
    profile: 'react',
    file: 'apps/web/src/components/Seo.tsx',
    content: [
      "import { useEffect } from 'react';",
      '',
      'export interface RobotsPolicy {',
      '  index: boolean;',
      '  follow: boolean;',
      '}',
      '',
      'export interface SeoProps {',
      '  title: string;',
      '  /** Absolute or root-relative canonical path for the page. */',
      '  path: string;',
      '  robots?: RobotsPolicy;',
      '}',
      '',
      'export function Seo({ title, path }: SeoProps) {',
      '  useEffect(() => {',
      '    document.title = title;',
      '  }, [title, path]);',
      '  return null;',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-react-zod-issue-path',
    guards: "14cl: a Zod validation path (`path: ['confirmPassword']`, SignUpForm.tsx:45) was reported as STRUCT_ROUTE_PATH_UNRESOLVED — an array literal is never a route path",
    profile: 'react',
    file: 'apps/web/src/features/auth/SignUpForm.tsx',
    content: [
      "import { z } from 'zod';",
      "import { Trans, useTranslation } from 'react-i18next';",
      '',
      'export const signUpSchema = z',
      '  .object({',
      '    email: z.string().email(),',
      '    password: z.string().min(8),',
      '    confirmPassword: z.string(),',
      '  })',
      '  .refine((data) => data.password === data.confirmPassword, {',
      "    message: 'auth:passwordsMustMatch',",
      "    path: ['confirmPassword'],",
      '  });',
      '',
      'export function SignUpForm({ onSubmit }: { onSubmit: (value: unknown) => void }) {',
      "  const { t } = useTranslation('auth');",
      '  return (',
      "    <form aria-label={t('signUpTitle')} onSubmit={() => onSubmit(signUpSchema)}>",
      '      <button type="submit">',
      '        <Trans ns="auth" i18nKey="signUp">Create account</Trans>',
      '      </button>',
      '    </form>',
      '  );',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'fx-react-route-constant-advisory',
    guards: '14cl inverse: `path: CONSTANT` inside a real route table (Courses.tsx:42) must STILL record the unresolved-route advisory — the narrowing may not swallow the 1co class',
    profile: 'react',
    file: 'apps/web/src/router.tsx',
    advisoryOk: true,
    content: [
      "import { createBrowserRouter } from 'react-router-dom';",
      '',
      "import { Courses } from './pages/Courses';",
      '',
      "export const CATALOG_PATH = '/courses';",
      '',
      'export const router = createBrowserRouter([',
      '  { path: CATALOG_PATH, element: <Courses /> },',
      ']);',
      '',
    ].join('\n'),
  },

  {
    id: 'fx-react-dynamic-inline-style',
    guards: 'the legitimate neighbor of web-inline-style: runtime-derived style values (progress width, computed transforms) are the rule\'s own documented carve-out and must never deny',
    profile: 'react',
    file: 'apps/web/src/components/ProgressBar.tsx',
    content: [
      'export function ProgressBar({ percent }: { percent: number }) {',
      '  const clamped = Math.min(100, Math.max(0, percent));',
      '  return (',
      '    <div',
      '      role="progressbar"',
      '      aria-valuenow={clamped}',
      '      className="progress-track"',
      '    >',
      '      <div className="progress-fill" style={{ width: `${clamped}%` }} />',
      '    </div>',
      '  );',
      '}',
      '',
    ].join('\n'),
  },

  // ── Known-bad: one per gate family ────────────────────────────────────────
  // These prove the corpus cannot be satisfied by disabling gates: each must
  // still produce a BLOCKING finding from the gate it names.
  {
    id: 'kb-plan-static-inline-style',
    guards: 'inverse guard: a fully static style={{…}} object still denies (web-inline-style)',
    profile: 'react',
    file: 'apps/web/src/components/PromoBadge.tsx',
    expectBlock: 'plan-static',
    content: [
      'export function PromoBadge() {',
      "  return <span style={{ color: 'red', marginTop: 4 }}>*</span>;",
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'kb-i18n-hardcoded-copy',
    guards: 'inverse guard (13co shipped-bug class): rendered hardcoded copy still blocks on profiles without an AST lint layer',
    profile: 'generic-web',
    file: 'src/pages/status.tsx',
    expectBlock: 'i18n',
    content: [
      'export function StatusResult() {',
      '  return <div><p>Your message was sent successfully</p></div>;',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'kb-collapse-packed-line',
    guards: 'inverse guard (16c class): a packed one-line JSX tree still trips collapse detection',
    profile: 'react',
    file: 'apps/web/src/components/PackedNav.tsx',
    expectBlock: 'collapse',
    content: [
      'export const PackedNav = () => <nav><ul><li><a href="/">Home</a></li><li><a href="/courses">Courses</a></li><li><a href="/news">News</a></li></ul></nav>;',
      '',
    ].join('\n'),
  },
  {
    id: 'kb-tailwind-no-toolchain',
    guards: 'inverse guard (8co): three-plus distinct Tailwind utilities with no reachable toolchain still block',
    profile: 'react',
    file: 'apps/web/src/components/UnstyledHero.tsx',
    expectBlock: 'tailwind',
    bareProject: true,
    content: [
      'export function UnstyledHero() {',
      '  return (',
      '    <section className="flex flex-col gap-4 p-6">',
      '      <h1 className="text-2xl font-semibold" />',
      '    </section>',
      '  );',
      '}',
      '',
    ].join('\n'),
  },
];

// ── Install commands: the forbidden-library matcher ─────────────────────────

export const COMMAND_FIXTURES: CorpusCommandFixture[] = [
  {
    id: 'cmd-redux-stack',
    guards: 'the approved state stack must install cleanly',
    command: 'pnpm add @reduxjs/toolkit react-redux zustand',
  },
  {
    id: 'cmd-tanstack-query',
    guards: 'the react-query pattern lookbehind: @tanstack/react-query is the approved library and must not match the bare react-query rule',
    command: 'pnpm add @tanstack/react-query',
  },
  {
    id: 'cmd-vitest-web',
    guards: 'vitest is the WEB test runner; the vitest deny applies only to the native stack',
    command: 'pnpm add -D vitest @vitest/coverage-v8',
  },
  {
    id: 'cmd-next-themes',
    guards: 'the next/next-auth deny must not match next-themes (boundary after the name)',
    command: 'pnpm add next-themes',
  },
  {
    id: 'cmd-react-bootstrap-icons',
    guards: 'the bootstrap deny must not match react-bootstrap-icons (suffix boundary)',
    command: 'pnpm add react-bootstrap-icons',
  },
  {
    id: 'cmd-i18n-runtime',
    guards: 'the profile-selected i18n runtime installs cleanly',
    command: 'yarn add i18next react-i18next',
  },
  {
    id: 'cmd-tailwind-install',
    guards: 'the pinned styling toolchain installs cleanly',
    command: 'pnpm add tailwindcss @tailwindcss/vite',
  },
  {
    id: 'cmd-framer-motion-web',
    guards: 'framer-motion is forbidden only on native; the web stack animates with it',
    command: 'pnpm add framer-motion',
  },
  {
    id: 'cmd-bare-install',
    guards: 'a bare dependency install resolves pinned ranges and is never a library choice',
    command: 'npm install',
  },
  {
    id: 'cmd-shadcn-cli',
    guards: 'npx shadcn@latest add is the shadcn workflow, not an install command — the matcher must not read it at all',
    command: 'npx shadcn@latest add button card',
  },
  {
    id: 'kb-forbidden-mobx',
    guards: 'inverse guard: a genuinely forbidden state library still denies',
    command: 'pnpm add mobx',
    expectBlock: 'forbidden-install',
  },
];

// ── Contract-derived factories ──────────────────────────────────────────────

function shellRouteImports(contract: CompiledArchitectureV1): Array<{
  name: string;
  rel: string;
  routePath: string;
}> {
  const shell = contract.modules.find((module) => module.kind === 'app-shell');
  if (!shell) throw new Error('lint-corpus: compiled contract has no app-shell module');
  const dir = path.posix.dirname(shell.output.replace(/\\/g, '/'));
  return contract.routes
    .filter((route) => !route.redirect)
    .map((route) => {
      const stem = route.moduleOutput.replace(/\\/g, '/').replace(/\.(?:tsx?|jsx?)$/, '');
      let rel = path.posix.relative(dir, stem);
      if (!rel.startsWith('.')) rel = `./${rel}`;
      return { name: path.posix.basename(stem), rel, routePath: route.path };
    });
}

function shellContent(
  contract: CompiledArchitectureV1,
  extraRouteLines: readonly string[],
): string {
  const imports = shellRouteImports(contract);
  return [
    "import { Suspense, lazy } from 'react';",
    "import { BrowserRouter, Route, Routes } from 'react-router-dom';",
    '',
    ...imports.map((entry) => `const ${entry.name} = lazy(() => import('${entry.rel}'));`),
    '',
    'export default function App() {',
    '  return (',
    '    <BrowserRouter>',
    '      <Suspense fallback={null}>',
    '        <Routes>',
    ...imports.map((entry) => `          <Route path="${entry.routePath}" element={<${entry.name} />} />`),
    ...extraRouteLines,
    '        </Routes>',
    '      </Suspense>',
    '    </BrowserRouter>',
    '  );',
    '}',
    '',
  ].join('\n');
}

/**
 * The canonical code-splitting app shell, generated FROM the compiled contract
 * so every route provably matches its compiled module. Guards the 9co class:
 * a `React.lazy` binding read as a locally declared page (the identical file
 * with static imports passed).
 */
export function reactAppShellFixture(contract: CompiledArchitectureV1): CorpusFileFixture {
  const shell = contract.modules.find((module) => module.kind === 'app-shell')!;
  return {
    id: 'fx-react-lazy-route-shell',
    guards: '9co: React.lazy route bindings were denied while the same file with static imports passed',
    profile: 'react',
    file: shell.output,
    content: shellContent(contract, []),
  };
}

// ── Catalog data validation (STRUCT_I18N_CATALOG stays write-time blocking) ──
// One canonical key set shared by the on-disk source seed and the fixtures, so
// the parity judgement can never drift out of sync with the corpus data. The
// plural family is the legitimate-idiom neighbor: locales need DIFFERENT CLDR
// categories (en `_one`/`_other`, ro also `_few`) and `t('ns:key', { count })`
// references the bare key — exact-key parity would deny every correct catalog.
const CATALOG_SOURCE_ENTRIES = {
  welcome: 'Welcome',
  lessonCount_one: 'One lesson',
  lessonCount_other: '{{count}} lessons',
} as const;

function commonCatalogPath(contract: CompiledArchitectureV1, locale: string): string {
  const catalog = (contract.i18n?.catalogs || []).find((candidate) => (
    candidate.locales.includes(locale) && candidate.namespaces.includes('common')
  ));
  if (!catalog) throw new Error(`lint-corpus: compiled contract has no ${locale}/common catalog`);
  return catalog.path;
}

/** The source-locale catalog the runner seeds ON DISK (parity needs both sides). */
export function sourceCatalogSeed(contract: CompiledArchitectureV1): { path: string; content: string } {
  return {
    path: commonCatalogPath(contract, 'en'),
    content: `${JSON.stringify(CATALOG_SOURCE_ENTRIES, null, 2)}\n`,
  };
}

/**
 * The sibling-locale catalog seeded ON DISK: the intermediate-parity fixture
 * judges an en write against a real ro sibling, exactly as the write-time gate
 * does. Fixtures targeting the ro path are unaffected — contentOverrides win.
 */
export function roCatalogSeed(contract: CompiledArchitectureV1): { path: string; content: string } {
  return {
    path: commonCatalogPath(contract, 'ro'),
    content: `${JSON.stringify({
      welcome: 'Bun venit',
      lessonCount_one: 'O lecție',
      lessonCount_other: '{{count}} de lecții',
    }, null, 2)}\n`,
  };
}

/**
 * The 13cl intermediate state: the en write adds a key ro does not carry yet.
 * Parity is a property of the locale PAIR and no role can write two files
 * atomically, so 13cl saw ~8 denies including a perfect oscillation on one key
 * ("en has extra key common:nav.installLabel" → the counterpart write denied →
 * "en is missing common:nav.installLabel"). The write-time gate now banks the
 * cross-locale parity classes as advisory/ledger warnings; completion still
 * blocks while parity stays broken.
 */
export function enIntermediateParityFixture(contract: CompiledArchitectureV1): CorpusFileFixture {
  return {
    id: 'fx-catalog-en-intermediate-key',
    guards: '13cl: adding a key to the source locale FIRST was denied because the sibling locale lacked it — every legitimate two-file catalog edit cost a deny per file',
    profile: 'react',
    file: commonCatalogPath(contract, 'en'),
    advisoryOk: true,
    content: `${JSON.stringify({
      ...CATALOG_SOURCE_ENTRIES,
      installLabel: 'Install the app',
    }, null, 2)}\n`,
  };
}

/**
 * A CLI-installed shadcn vendor primitive under `<sharedRoot>/src/components/
 * ui/` — the directory the compiled contract defines as adapter-CLI-owned.
 * 14cl: 7 of 17 consolidated findings were breadcrumb/pagination/sidebar/
 * spinner primitives flagged as hardcoded copy; `shadcn add` overwrites these
 * files wholesale, so demanding <Trans> inside them is wrong. The path derives
 * from the compiled uiSystem, never a hardcoded workspace literal.
 */
export function shadcnVendorPrimitiveFixture(contract: CompiledArchitectureV1): CorpusFileFixture {
  const sharedRoot = contract.profile.uiSystem?.sharedRoot;
  if (!sharedRoot) throw new Error('lint-corpus: compiled contract has no uiSystem sharedRoot');
  return {
    id: 'fx-shadcn-vendor-primitive',
    guards: '14cl: CLI-installed shadcn primitives under <sharedRoot>/src/components/ui/ were flagged as hardcoded copy; vendor files are overwritten by the next `shadcn add`',
    profile: 'react',
    file: `${sharedRoot}/src/components/ui/spinner.tsx`,
    content: [
      "import { cn } from '../../lib/utils';",
      '',
      'export function Spinner({ className }: { className?: string }) {',
      '  return (',
      '    <svg',
      '      role="status"',
      '      aria-label="Loading"',
      "      className={cn('animate-spin', className)}",
      '      viewBox="0 0 24 24"',
      '    />',
      '  );',
      '}',
      '',
    ].join('\n'),
  };
}

/**
 * A correct Romanian catalog: same logical keys, MORE plural categories than
 * the source locale. Judged by the same write-time call plan-readiness makes
 * for a changed catalog file — any blocking finding is a false deny.
 */
export function roPluralCatalogFixture(contract: CompiledArchitectureV1): CorpusFileFixture {
  return {
    id: 'fx-catalog-ro-plural-forms',
    guards: 'CLDR plural forms are per-locale spellings of one logical key; exact-key parity denied every correct ro catalog carrying `_few`',
    profile: 'react',
    file: commonCatalogPath(contract, 'ro'),
    content: `${JSON.stringify({
      welcome: 'Bun venit',
      lessonCount_one: 'O lecție',
      lessonCount_few: '{{count}} lecții',
      lessonCount_other: '{{count}} de lecții',
    }, null, 2)}\n`,
  };
}

/**
 * Inverse guard: broken catalog DATA still denies at write time. The empty
 * value is the single-file blocking class; the missing logical key rides along
 * as the cross-locale parity ADVISORY (write-time accumulates it — completion
 * still blocks on it).
 */
export function kbCatalogParityFixture(contract: CompiledArchitectureV1): CorpusFileFixture {
  return {
    id: 'kb-catalog-empty-and-missing',
    guards: 'inverse guard: an empty translation value still trips STRUCT_I18N_CATALOG at write time (cross-locale parity classes accumulate instead of denying)',
    profile: 'react',
    file: commonCatalogPath(contract, 'ro'),
    expectBlock: 'catalog',
    content: `${JSON.stringify({
      welcome: '',
    }, null, 2)}\n`,
  };
}

/** Inverse guard: a route absent from the compiled contract must still deny. */
export function reactBrokenRouteFixture(contract: CompiledArchitectureV1): CorpusFileFixture {
  const shell = contract.modules.find((module) => module.kind === 'app-shell')!;
  const first = shellRouteImports(contract)[0]!;
  return {
    id: 'kb-structure-uncompiled-route',
    guards: 'inverse guard: a route the contract never compiled still trips STRUCT_ROUTE_MODULE_MISMATCH',
    profile: 'react',
    file: shell.output,
    expectBlock: 'structure',
    content: shellContent(contract, [
      `          <Route path="/uncompiled-extra" element={<${first.name} />} />`,
    ]),
  };
}
