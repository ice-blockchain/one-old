// src/runners/one-mcp-report/lib.ts
// Low-level helpers for the one-mcp first-look report: constants, file-walk +
// skip rules, dependency scan, technology/component mapping, infra-vendor
// detection, and project-state IO. Ported 1:1 from one-mcp-report/_helpers.cjs
// (the network client + report-id mint live with the orchestration half). The
// legacy "hoisted forwarder" circular-dep workaround is removed: this module
// has no dependency on the collectors or the report-id reader.

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

import { LEGACY_STATE_FILE, STATE_FILE } from '../../config/paths';
import { SKIP_DIRS, SKIP_FILES } from '../../config/reporting';
import { readSimpleAuth } from '../../shared/auth';
import { stripLocalPreferenceFields } from '../../shared/state/local-prefs';
import { buildMcpPayload } from './buildMcpPayload';

type Rec = Record<string, unknown>;

export function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function readJson(filePath: string, fallback: unknown = null): unknown {
  const text = readText(filePath);
  if (text === null) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function statePath(cwd: string): string {
  return path.join(cwd, STATE_FILE);
}
export function legacyStatePath(cwd: string): string {
  return path.join(cwd, LEGACY_STATE_FILE);
}

export function readProjectState(cwd: string): Rec {
  const nextState = readJson(statePath(cwd), null);
  if (nextState && typeof nextState === 'object') return nextState as Rec;
  const legacyState = readJson(legacyStatePath(cwd), null);
  return legacyState && typeof legacyState === 'object' ? (legacyState as Rec) : {};
}

export function writeProjectState(cwd: string, state: unknown): void {
  // RAW writer (NOT the stripping writeState). It runs during onboarding to mint one-uid, so
  // without stripping it re-persists machine-local preference fields (team / toolchain with an
  // absolute binPath / performance / …) into the COMMITTED .one.json — the Codex
  // onboarding-complete leak, where this write lands while the effective state is still merged.
  // Those fields live in the per-user preferences.json; strip them from project state on write.
  writeJson(statePath(cwd), stripLocalPreferenceFields(state && typeof state === 'object' ? state : {}));
}

export function shouldSkipFile(relPath: string, fileName: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  if (SKIP_FILES.has(fileName)) return true;
  if (/\.(min|bundle)\.(js|css)$/i.test(fileName)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(fileName)) return true;
  if (/\.g\.dart$/i.test(fileName) || /\.pb\.(go|ts|js)$/i.test(fileName)) return true;
  if (/(^|\/)(__tests__|tests?|fixtures?|vendor)(\/|$)/i.test(normalized)) return true;
  return false;
}

export function walkFiles(cwd: string, visitor: (absPath: string, relPath: string) => void, relDir = ''): void {
  const dir = path.join(cwd, relDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(cwd, visitor, path.join(relDir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    const relPath = path.join(relDir, entry.name);
    if (shouldSkipFile(relPath, entry.name)) continue;
    visitor(path.join(cwd, relPath), relPath);
  }
}

export function extensionFor(filePath: string): string | null {
  const base = path.basename(filePath);
  if (base === 'Dockerfile') return 'dockerfile';
  const ext = path.extname(base).replace(/^\./, '').toLowerCase();
  return ext && ext.length <= 64 ? ext : null;
}

export function countLines(text: string | null): number {
  if (!text) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

export function packageJsonFiles(cwd: string): string[] {
  const files: string[] = [];
  walkFiles(cwd, (absPath, relPath) => {
    if (path.basename(relPath) === 'package.json') files.push(absPath);
  });
  files.sort();
  return files;
}

export function dependencyNames(cwd: string): Set<string> {
  const names = new Set<string>();
  for (const filePath of packageJsonFiles(cwd)) {
    const pkg = readJson(filePath, {}) as Rec;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg && pkg[section] && typeof pkg[section] === 'object' ? (pkg[section] as Rec) : {};
      for (const name of Object.keys(deps)) names.add(name);
    }
    if (typeof pkg.packageManager === 'string') {
      const manager = pkg.packageManager.split('@')[0]!.toLowerCase();
      if (manager) names.add(`package-manager:${manager}`);
    }
  }
  return names;
}

export function addTechForDependency(techs: Set<string>, dep: string): void {
  const map = new Map<string, string>([
    ['@nestjs/core', 'nestjs'], ['@reduxjs/toolkit', 'redux'], ['@supabase/ssr', 'supabase'],
    ['@supabase/supabase-js', 'supabase'], ['@tanstack/react-query', 'tanstack-query'], ['next', 'next.js'],
    ['posthog-js', 'posthog'], ['prisma', 'prisma'], ['react', 'react'], ['react-native', 'react-native'],
    ['tailwindcss', 'tailwindcss'], ['turbo', 'turborepo'], ['typescript', 'typescript'], ['vite', 'vite'],
    ['zustand', 'zustand'],
  ]);
  if (map.has(dep)) techs.add(map.get(dep) as string);
  if (dep === 'package-manager:pnpm') techs.add('pnpm');
  if (dep === 'package-manager:npm') techs.add('npm');
  if (dep === 'package-manager:yarn') techs.add('yarn');
}

export interface ArchComponent { type: string; name: string; uses?: string[] }
export function addComponent(components: ArchComponent[], seen: Set<string>, type: string, name: string, uses: string[] = []): void {
  const key = `${type}:${name}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (type === 'custom_service') components.push({ type, name, uses });
  else components.push({ type, name });
}

export function detectInfrastructureVendor(cwd: string): string {
  const checks: [string, string][] = [
    ['vercel.json', 'vercel'], ['netlify.toml', 'netlify'], ['wrangler.toml', 'cloudflare'],
    ['fly.toml', 'fly'], ['render.yaml', 'render'], ['railway.json', 'railway'],
  ];
  for (const [fileName, vendor] of checks) {
    if (fs.existsSync(path.join(cwd, fileName))) return vendor;
  }
  return 'unknown';
}

export function parseTimestamp(value: unknown): number {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : 0;
}

// ms-stripped ISO timestamp (matches the legacy nowIso in this runner).
export { nowIsoNoMs as nowIso } from '../../shared/text';

export function stateForReport(root: string, options: { state?: unknown } = {}): Rec {
  return options.state && typeof options.state === 'object' ? (options.state as Rec) : readProjectState(root);
}

// Fire-and-forget MCP tools/call POST. Resolves the response body on 2xx,
// rejects on non-2xx / error response / timeout. Ported 1:1 from
// one-mcp-report/_helpers.cjs (mcpRequest).
export function mcpRequest(endpoint: string, payload: unknown, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const body = JSON.stringify(buildMcpPayload(payload));
    // Carry the web-entered API key as a Bearer token so the server can validate
    // it: a rejected/invalid key returns 401, which runReport turns into a local
    // auth reset (re-opening the wizard's api-key page next session). The key is a
    // telemetry key, not a secret; the report endpoint is HTTPS.
    const apiKey = readSimpleAuth()?.apiKey || '';
    const headers: Record<string, string | number> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      port: url.port || 443,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          // Surface the numeric status on the error so runReport can detect a 401
          // (invalid/rejected key) and flip the local auth flag to false. Keep the
          // `HTTP <n>` message intact — the status-file records it verbatim.
          const err = new Error(`HTTP ${res.statusCode || 'unknown'}`) as Error & { statusCode?: number };
          if (res.statusCode) err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        if (/"error"\s*:/.test(responseBody)) {
          reject(new Error('MCP error response'));
          return;
        }
        resolve(responseBody);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}
