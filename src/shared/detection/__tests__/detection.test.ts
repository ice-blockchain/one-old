import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { classifyPromptForStack, dependenciesFromPackage, detectMode, detectStackFromCodebase, promptHasStackSignal, reconcileStackFromArtifacts } from '../index';
import { STACK_IDS } from '../../../config/stacks';

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-detect-'));
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf8');
  }
  return dir;
}

test('classifyPromptForStack: landing page → custom-frontend, never a frontend-less stack', () => {
  // A brochure site IS a frontend. This used to derive `minimal/none/none`,
  // which compiles to a backend-only capability profile with zero surfaces and
  // NO implementer role: the architect was denied every route it declared and
  // the orchestrator was told not to spawn a frontend.
  const c = classifyPromptForStack('build a simple landing page');
  assert.equal(c.stack, 'custom-frontend');
  assert.equal(c.frontend, 'react-vite');
  assert.equal(c.backend, 'none');
  assert.equal(c.evidence.wantsStaticSite, true, 'brochure vocabulary is still recorded as evidence');
});

test('classifyPromptForStack: the agency brief derives a buildable full stack', () => {
  // Verbatim from the field. `projects listing`, `latest news`, `reviews` are
  // collections the user expects to list and later edit, so backendNeed now
  // recognises them; without that the prompt read as needing no backend at all.
  const c = classifyPromptForStack(
    'create modern an agency presentation website. one landing page with projects '
    + 'listing, latest news, reviews.',
  );
  assert.equal(c.stack, 'default');
  assert.equal(c.frontend, 'react-vite');
  assert.equal(c.backend, 'supabase');
  assert.equal(c.evidence.backendNeed, true);
});

test('classifyPromptForStack: the brochure brief derives the frontend-only shape run-sim seeds', () => {
  // Verbatim BRIEF_BROCHURE from test-environment/config/cases/run-sim.cases.ts
  // (inlined: tsconfig layering forbids importing test-environment here). The
  // sim-new-react-vite-nobackend preSeed declares custom-frontend/react-vite/none;
  // this row proves the classifier actually derives that triple for the brief,
  // so seed and derivation cannot drift apart silently.
  const c = classifyPromptForStack(
    'create a modern agency presentation website. one landing page with a hero, '
    + 'our services, selected work, and a contact form.',
  );
  assert.equal(c.stack, 'custom-frontend');
  assert.equal(c.frontend, 'react-vite');
  assert.equal(c.backend, 'none');
});

test('classifyPromptForStack: content vocabulary alone implies persistence', () => {
  for (const [prompt, backend] of [
    ['a blog for my travel photos', 'supabase'],
    ['a news site for our town', 'supabase'],
    ['a site with customer reviews', 'supabase'],
    ['a property listings site', 'supabase'],
    ['a website with a cms', 'supabase'],
    // …but a brochure with none of those words stays backend-free.
    ['a restaurant website with our menu and opening hours', 'none'],
    ['a one-page brochure site for a law firm', 'none'],
  ] as const) {
    const c = classifyPromptForStack(prompt);
    assert.equal(c.backend, backend, prompt);
    assert.equal(c.frontend, 'react-vite', prompt);
    assert.notEqual(c.stack, 'minimal', prompt);
  }
});

test('classifyPromptForStack: an explicit "no backend" outranks a backendNeed keyword', () => {
  // Arm ordering, not luck: `noBackend` sits ahead of `backendNeed`, and
  // "no backend" itself matches /\bbackend\b/.
  for (const prompt of [
    'a landing page with a news section, frontend-only',
    'a blog with no backend',
    'a static only portfolio site',
  ]) {
    const c = classifyPromptForStack(prompt);
    assert.equal(c.stack, 'custom-frontend', prompt);
    assert.equal(c.frontend, 'react-vite', prompt);
    assert.equal(c.backend, 'none', prompt);
  }
});

test('classifyPromptForStack: never `minimal`, and never a frontend-less web project', () => {
  // The classifier is the ONLY producer of a brand-new project's stack. Two
  // invariants: it never returns `minimal` (that id now belongs exclusively to
  // the existing-codebase detection floor, which pairs it with backend `other`
  // so senior-backend stays eligible), and `frontend: 'none'` may come from
  // exactly TWO arms — the mobile arm (a native app has no web surface) and the
  // API-only arm (an explicit custom backend, API vocabulary, zero UI words).
  // Both are identifiable from `evidence`, so any third producer fails here.
  const prompts = [
    'build a simple landing page',
    'create modern an agency presentation website. one landing page with projects listing, latest news, reviews.',
    'a one-page brochure site for a law firm',
    'a portfolio', 'a static site', 'a simple website',
    'a presentation website for our studio',
    'ok build it', 'make me something', '',
    'a blog', 'a news site', 'a restaurant website with our menu',
    'build a SaaS platform with auth and a dashboard',
    'an expo mobile app', 'a next.js marketing site',
    'build a React Vite frontend with no backend',
    'build a django rest api',
    'create a golang api project with api fetching products, product info, news, auth',
    'build a rest api with microservices in go',
    'create a golang web app with a dashboard ui',
    'create an api for products with auth',
    'create a modern learning platform with courses for web development. use laravel with vuejs.',
  ];
  for (const prompt of prompts) {
    const c = classifyPromptForStack(prompt);
    assert.notEqual(c.stack, 'minimal', prompt);
    assert.ok(STACK_IDS.has(c.stack), `${prompt}: unknown stack ${c.stack}`);
    if (c.frontend === 'none') {
      const explicitCustomBackend = Boolean(
        c.evidence.backend && c.evidence.backend !== 'supabase' && c.evidence.backend !== 'none',
      );
      assert.ok(
        c.mobile.enabled || explicitCustomBackend,
        `${prompt}: frontend 'none' with neither a native surface nor an explicit custom backend`,
      );
    }
  }
});

test('promptHasStackSignal: brochure vocabulary still admits a verb-less project description', () => {
  // The evidence key was renamed wantsMinimal → wantsStaticSite. It MUST stay in
  // the OR: the finalize no-signal floor (onboarding-server/flow.ts) would
  // otherwise fire on an EXPLICIT brochure request and overwrite it with the
  // default build seed, and prompt-submit's coding-intent gate would drop the
  // first project description entirely.
  for (const prompt of [
    'a simple static landing page',
    'a one-page brochure site for a law firm',
    'a portfolio',
    'a marketplace where freelancers and clients find each other',
  ]) assert.equal(promptHasStackSignal(prompt), true, prompt);

  // Unchanged: genuine chit-chat still carries no stack signal.
  for (const prompt of [
    'hi there, how are you today?',
    'what is the capital of France?',
    '',
  ]) assert.equal(promptHasStackSignal(prompt), false, prompt);
});

test('promptHasStackSignal: content vocabulary now counts as a stack signal', () => {
  // Direct consequence of adding news/blog(s)/review(s)/listing(s)/cms/content
  // to backendNeed — promptHasStackSignal reads that evidence. A bare content
  // noun therefore activates Traffic One on a pristine directory (prompt-submit's
  // coding-intent gate). Accepted: that gate is documented as biased toward true
  // and already fires on `files`, `users`, and `api`. Pinned so the widening is
  // visible rather than discovered.
  assert.equal(promptHasStackSignal('a blog for my travel photos'), true);
  assert.equal(promptHasStackSignal('what is the latest news?'), true);
});

test('classifyPromptForStack: SaaS w/ auth + dashboard → default react+supabase', () => {
  const c = classifyPromptForStack('build a SaaS platform with auth and a dashboard');
  assert.equal(c.stack, 'default');
  assert.equal(c.frontend, 'react-vite');
  assert.equal(c.backend, 'supabase');
});

test('classifyPromptForStack: django api → custom-backend', () => {
  const c = classifyPromptForStack('build a django rest api');
  assert.equal(c.backend, 'django');
  assert.equal(c.stack, 'custom-backend');
});

test('classifyPromptForStack: API-only custom backend → frontend none (13c)', () => {
  // the exact 13c prompt that scaffolded an unrequested React app
  const c = classifyPromptForStack('create a golang api project with api fetching products, product info, news, auth');
  assert.equal(c.backend, 'go');
  assert.equal(c.stack, 'custom-backend');
  assert.equal(c.frontend, 'none');

  const micro = classifyPromptForStack('build a rest api with microservices in go');
  assert.equal(micro.frontend, 'none');
  assert.equal(micro.backend, 'go');

  const dj = classifyPromptForStack('build a django rest api');
  assert.equal(dj.frontend, 'none');
});

test('classifyPromptForStack: custom backend WITH ui signals keeps the web frontend', () => {
  const c = classifyPromptForStack('create a golang web app with a dashboard ui');
  assert.equal(c.backend, 'go');
  assert.equal(c.frontend, 'react-vite');
  assert.equal(c.stack, 'custom-stack');

  // explicit react wording is untouched by the API-only branch
  const react = classifyPromptForStack('React frontend and a Go server for the API');
  assert.equal(react.frontend, 'react-vite');
  assert.equal(react.stack, 'custom-stack');
});

test('classifyPromptForStack: ambiguous supabase-tier api prompt keeps the web default', () => {
  // no explicit custom backend → NOT api-only; stays on the default stack
  const c = classifyPromptForStack('create an api for products with auth');
  assert.equal(c.frontend, 'react-vite');
  assert.equal(c.backend, 'supabase');
  assert.equal(c.stack, 'default');
});

test('classifyPromptForStack: React with Go as backend → custom-stack/go', () => {
  const prompts = [
    'build a web development academy in react with go as backend',
    'make a React app with backend in Go',
    'React frontend and a Go server for the API',
    'React/Vite app with API written in Go',
    'React app where the backend is written in Go',
  ];
  for (const prompt of prompts) {
    const c = classifyPromptForStack(prompt);
    assert.equal(c.frontend, 'react-vite', prompt);
    assert.equal(c.backend, 'go', prompt);
    assert.equal(c.stack, 'custom-stack', prompt);
  }
});

test('classifyPromptForStack: expo app (no react word) → custom-frontend, RN, no web frontend', () => {
  const c = classifyPromptForStack('an expo mobile app');
  assert.equal(c.mobile.enabled, true);
  assert.equal(c.mobile.framework, 'react-native-expo');
  assert.equal(c.stack, 'custom-frontend');
  assert.equal(c.frontend, 'none');
  assert.equal(c.backend, 'none');
});

test('classifyPromptForStack: next.js → custom-frontend/nextjs', () => {
  const c = classifyPromptForStack('a next.js marketing site');
  assert.equal(c.evidence.frontend, 'nextjs');
  assert.equal(c.stack, 'custom-frontend');
  assert.equal(c.backend, 'none');
});

test('classifyPromptForStack: React/Vite without a backend is custom-frontend, never custom-backend', () => {
  const c = classifyPromptForStack('build a React Vite frontend with no backend');
  assert.equal(c.stack, 'custom-frontend');
  assert.equal(c.frontend, 'react-vite');
  assert.equal(c.backend, 'none');
});

test('dependenciesFromPackage merges deps + devDeps and tolerates junk', () => {
  assert.deepEqual(dependenciesFromPackage({ dependencies: { a: '1' }, devDependencies: { b: '2' } }), { a: '1', b: '2' });
  assert.deepEqual(dependenciesFromPackage(null), {});
});

test('detectStackFromCodebase: react + supabase → default', () => {
  const dir = tmpProject({ 'package.json': JSON.stringify({ dependencies: { react: '18', '@supabase/supabase-js': '2' } }) });
  try {
    const d = detectStackFromCodebase(dir);
    assert.equal(d.stack, 'default');
    assert.equal(d.frontend, 'react-vite');
    assert.equal(d.backend, 'supabase');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectStackFromCodebase: React/Vite without backend → custom-frontend', () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ dependencies: { react: '18', vite: '5' } }),
  });
  try {
    const d = detectStackFromCodebase(dir);
    assert.equal(d.stack, 'custom-frontend');
    assert.equal(d.frontend, 'react-vite');
    assert.equal(d.backend, 'none');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectStackFromCodebase: Supabase project with a stray .go file stays default/supabase', () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ dependencies: { react: '18', vite: '5', '@supabase/supabase-js': '2' } }),
    'services/api/scratch.go': 'package scratch\n',
  });
  try {
    const d = detectStackFromCodebase(dir);
    assert.equal(d.stack, 'default');
    assert.equal(d.frontend, 'react-vite');
    assert.equal(d.backend, 'supabase');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectStackFromCodebase: Go workspace with React package → custom-stack/go', () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ dependencies: { react: '18', vite: '5' } }),
    'go.work': 'go 1.23\nuse ./services/api\n',
    'services/api/main.go': 'package main\nfunc main() {}\n',
  });
  try {
    const d = detectStackFromCodebase(dir);
    assert.equal(d.stack, 'custom-stack');
    assert.equal(d.frontend, 'react-vite');
    assert.equal(d.backend, 'go');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectStackFromCodebase: backend-local Go module with React package → custom-stack/go', () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ dependencies: { react: '18', vite: '5' } }),
    'services/api/go.mod': 'module example.com/api\n',
    'services/api/cmd/main.go': 'package main\nfunc main() {}\n',
  });
  try {
    const d = detectStackFromCodebase(dir);
    assert.equal(d.stack, 'custom-stack');
    assert.equal(d.frontend, 'react-vite');
    assert.equal(d.backend, 'go');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileStackFromArtifacts repairs stale default/supabase state when Go backend exists', () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ dependencies: { react: '18', vite: '5' } }),
    'go.work': 'go 1.23\nuse ./services/api\n',
  });
  try {
    const state: Record<string, unknown> = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase' };
    assert.equal(reconcileStackFromArtifacts(dir, state), true);
    assert.equal(state.stack, 'custom-stack');
    assert.equal(state.frontend, 'react-vite');
    assert.equal(state.backend, 'go');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileStackFromArtifacts ignores stray .go files without Go module markers', () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ dependencies: { react: '18', vite: '5', '@supabase/supabase-js': '2' } }),
    'services/api/scratch.go': 'package scratch\n',
  });
  try {
    const state: Record<string, unknown> = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase' };
    assert.equal(reconcileStackFromArtifacts(dir, state), false);
    assert.equal(state.stack, 'default');
    assert.equal(state.frontend, 'react-vite');
    assert.equal(state.backend, 'supabase');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectStackFromCodebase: empty deps → nulls; next → custom-frontend/nextjs', () => {
  const empty = tmpProject({ 'package.json': '{}' });
  try {
    const d = detectStackFromCodebase(empty);
    assert.equal(d.stack, null);
    assert.equal(d.backend, null);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
  const next = tmpProject({ 'package.json': JSON.stringify({ dependencies: { next: '14', react: '18' } }) });
  try {
    const d = detectStackFromCodebase(next);
    assert.equal(d.stack, 'custom-frontend');
    assert.equal(d.frontend, 'nextjs');
  } finally {
    fs.rmSync(next, { recursive: true, force: true });
  }
});

test('detectMode: few files → new-project; many + supabase → existing-with-supabase', () => {
  const few = tmpProject({ 'package.json': '{}', 'a.ts': 'export const x = 1' });
  try {
    assert.equal(detectMode(few), 'new-project');
  } finally {
    fs.rmSync(few, { recursive: true, force: true });
  }
  const files: Record<string, string> = { 'package.json': JSON.stringify({ dependencies: { '@supabase/supabase-js': '2' } }) };
  for (let i = 0; i < 8; i += 1) files[`f${i}.ts`] = 'export const x = 1';
  const many = tmpProject(files);
  try {
    assert.equal(detectMode(many), 'existing-with-supabase');
  } finally {
    fs.rmSync(many, { recursive: true, force: true });
  }
});
