import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { classifyPromptForStack, dependenciesFromPackage, detectMode, detectStackFromCodebase, reconcileStackFromArtifacts } from '../index';

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-detect-'));
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf8');
  }
  return dir;
}

test('classifyPromptForStack: landing page → minimal', () => {
  const c = classifyPromptForStack('build a simple landing page');
  assert.equal(c.stack, 'minimal');
  assert.equal(c.frontend, 'none');
  assert.equal(c.backend, 'none');
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

test('classifyPromptForStack: React with Go as backend → custom-backend/go', () => {
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
    assert.equal(c.stack, 'custom-backend', prompt);
  }
});

test('classifyPromptForStack: expo app (no react word) → custom-frontend, RN, no web frontend', () => {
  const c = classifyPromptForStack('an expo mobile app');
  assert.equal(c.mobile.enabled, true);
  assert.equal(c.mobile.framework, 'react-native-expo');
  assert.equal(c.stack, 'custom-frontend');
  assert.equal(c.frontend, 'none');
});

test('classifyPromptForStack: next.js → custom-frontend/nextjs', () => {
  const c = classifyPromptForStack('a next.js marketing site');
  assert.equal(c.evidence.frontend, 'nextjs');
  assert.equal(c.stack, 'custom-frontend');
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

test('detectStackFromCodebase: Go workspace with React package → custom-backend/go', () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ dependencies: { react: '18', vite: '5' } }),
    'go.work': 'go 1.23\nuse ./services/api\n',
    'services/api/main.go': 'package main\nfunc main() {}\n',
  });
  try {
    const d = detectStackFromCodebase(dir);
    assert.equal(d.stack, 'custom-backend');
    assert.equal(d.frontend, 'react-vite');
    assert.equal(d.backend, 'go');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectStackFromCodebase: backend-local Go module with React package → custom-backend/go', () => {
  const dir = tmpProject({
    'package.json': JSON.stringify({ dependencies: { react: '18', vite: '5' } }),
    'services/api/go.mod': 'module example.com/api\n',
    'services/api/cmd/main.go': 'package main\nfunc main() {}\n',
  });
  try {
    const d = detectStackFromCodebase(dir);
    assert.equal(d.stack, 'custom-backend');
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
    assert.equal(state.stack, 'custom-backend');
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
