import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { classifyPromptForStack, dependenciesFromPackage, detectMode, detectStackFromCodebase } from '../index';

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
