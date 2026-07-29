// src/shared/capabilities/fs-probe.ts
// Filesystem/record micro-probes and the backend evidence checks.

import * as fs from 'fs';
import * as path from 'path';
import { readJson } from '../fsjson';
import { obj, type Rec } from '../obj';

import {
  BACKEND_NONE,
  MAX_WORKSPACE_ROOTS,
} from './types';

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function stringField(rec: Rec | null, key: string, fallback = ''): string {
  const value = rec?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function exists(cwd: string, rel: string): boolean {
  try { return fs.existsSync(path.join(cwd, rel)); } catch { return false; }
}

export function packageDependencies(cwd: string, root = '.'): Rec {
  const pkg = readJson<Rec>(path.join(cwd, root, 'package.json'), {});
  return {
    ...(obj(pkg.dependencies) || {}),
    ...(obj(pkg.devDependencies) || {}),
  };
}

export function composerPackages(cwd: string): Rec {
  const composer = readJson<Rec>(path.join(cwd, 'composer.json'), {});
  return {
    ...(obj(composer.require) || {}),
    ...(obj(composer['require-dev']) || {}),
  };
}


export function safeNames(cwd: string): string[] {
  try { return fs.readdirSync(cwd); } catch { return []; }
}

function fileContains(cwd: string, rel: string, pattern: RegExp): boolean {
  try {
    return pattern.test(fs.readFileSync(path.join(cwd, rel), 'utf8').slice(0, 512_000));
  } catch {
    return false;
  }
}

function pythonApiEvidencePresent(cwd: string, backend: string): boolean {
  if (backend === 'fastapi' || backend === 'django') return true;
  if ([
    'api',
    'routes',
    'endpoints',
    'manage.py',
  ].some((marker) => exists(cwd, marker))) return true;
  const frameworkPattern = /\b(?:fastapi|flask|django|starlette|litestar|aiohttp|sanic|uvicorn)\b/i;
  if ([
    'pyproject.toml',
    'requirements.txt',
    'requirements-dev.txt',
    'Pipfile',
  ].some((rel) => fileContains(cwd, rel, frameworkPattern))) return true;
  const serverPattern = /\b(?:FastAPI|Flask|APIRouter)\s*\(|\bfrom\s+(?:django|aiohttp|sanic)\b|@(?:app|router)\.(?:get|post|put|patch|delete|route)\b/;
  return safeNames(cwd)
    .filter((name) => name.endsWith('.py'))
    .some((name) => fileContains(cwd, name, serverPattern));
}

export function backendExposesApi(cwd: string, backend: string): boolean {
  if (BACKEND_NONE.has(backend)) return false;
  // `python` names a language/runtime, not a transport. A script, CLI, worker,
  // ETL job, or library must not acquire an API surface without server/router
  // evidence. Explicit web frameworks remain APIs.
  if (backend === 'python') return pythonApiEvidencePresent(cwd, backend);
  return true;
}

export function pythonCliEvidencePresent(cwd: string): boolean {
  if (exists(cwd, 'cmd') || exists(cwd, 'bin')) return true;
  if (fileContains(cwd, 'pyproject.toml', /^\s*\[(?:project\.scripts|tool\.poetry\.scripts)\]\s*$/m)) {
    return true;
  }
  return safeNames(cwd).some((name) => (
    name.endsWith('.py')
    && !['manage.py', 'wsgi.py', 'asgi.py'].includes(name)
  ));
}

export function postgresEvidencePresent(cwd: string, state: Rec, backend: string): boolean {
  if (['supabase', 'our-fork', 'postgres', 'postgresql'].includes(backend)) return true;
  const provider = [
    state.database,
    state.databaseProvider,
    state.database_provider,
    state.db,
    state.dbProvider,
  ].find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  if (provider && /\b(?:postgres|postgresql|supabase)\b/i.test(provider)) return true;

  const jsDeps = candidateWebRoots(cwd).flatMap((root) => Object.keys(packageDependencies(cwd, root)));
  if (jsDeps.some((name) => [
    'pg',
    'postgres',
    'postgres.js',
    '@supabase/supabase-js',
    '@supabase/ssr',
  ].includes(name))) return true;

  const packageEvidence = [
    ['go.mod', /\b(?:github\.com\/lib\/pq|github\.com\/jackc\/pgx)\b/i],
    ['pyproject.toml', /\b(?:psycopg|psycopg2|asyncpg|postgresql)\b/i],
    ['requirements.txt', /\b(?:psycopg|psycopg2|asyncpg)\b/i],
    ['composer.json', /\b(?:ext-pgsql|ext-pdo_pgsql)\b/i],
    ['Cargo.toml', /\b(?:tokio-postgres|postgres)\b/i],
    ['docker-compose.yml', /\b(?:image:\s*postgres|postgresql:)\b/i],
    ['docker-compose.yaml', /\b(?:image:\s*postgres|postgresql:)\b/i],
    ['compose.yml', /\b(?:image:\s*postgres|postgresql:)\b/i],
    ['compose.yaml', /\b(?:image:\s*postgres|postgresql:)\b/i],
    ['.env.example', /\bpostgres(?:ql)?:\/\//i],
  ] as const;
  return packageEvidence.some(([rel, pattern]) => fileContains(cwd, rel, pattern));
}

export function backendSkillBucket(backend: string): string | null {
  if (backend === 'supabase' || backend === 'our-fork') return 'supabase';
  if (backend === 'nestjs') return 'node';
  if (backend === 'fastapi') return 'python';
  if (backend === 'laravel') return 'php';
  if (backend === 'csharp') return 'dotnet';
  if (backend === 'other') return null;
  return backend;
}


export function prefixed(root: string, rel: string): string {
  return root === '.' ? rel : `${root}/${rel}`;
}
export function candidateWebRoots(cwd: string): string[] {
  const conventional = ['apps/web', 'web', 'frontend', 'client']
    .filter((root) => exists(cwd, root));
  const workspace = [
    ...workspaceChildren(cwd, 'apps'),
    ...workspaceChildren(cwd, 'packages'),
  ].slice(0, MAX_WORKSPACE_ROOTS);
  return unique([...conventional, ...workspace, '.']);
}

export function workspaceChildren(cwd: string, container: 'apps' | 'packages'): string[] {
  try {
    return fs.readdirSync(path.join(cwd, container), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${container}/${entry.name}`)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
