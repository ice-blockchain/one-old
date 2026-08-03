// src/shared/qa-evidence-runtime-core.ts
// Shared primitives for the QA evidence modules: bounded guards, stable-JSON
// hashing, path containment, streaming file hashing, and the build-output
// manifest walk. Siblings import the guards from here; the public surface is
// re-exported by qa-evidence-runtime.ts.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  QA_BUILD_MANIFEST_MAX_BYTES,
  QA_BUILD_MANIFEST_MAX_FILES,
  QA_BUILD_MANIFEST_SCHEMA_VERSION,
  type BuildManifestFileV1,
  type BuildOutputManifestV1,
  type Rec,
} from './types';

export const SHA256_RE = /^[a-f0-9]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/;

export function isRecord(value: unknown): value is Rec {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && SAFE_TEXT_RE.test(value);
}

export function iso(value: unknown): value is string {
  return typeof value === 'string'
    && ISO_RE.test(value)
    && Number.isFinite(Date.parse(value));
}

export function sha256Bytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Rec)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

export function normalizeRelative(value: string): string | null {
  const normalized = value;
  if (!normalized
    || normalized.includes('\\')
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || /[*?[\]{};]/.test(normalized)
    || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

export function safeRelativePath(value: unknown, max = 4_096): value is string {
  return safeText(value, max)
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && normalizeRelative(value) === value;
}

function inside(candidate: string, boundary: string): boolean {
  const rel = path.relative(boundary, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function hashFile(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function computeBuildOutputManifest(
  projectRoot: string,
  outputRoot: string,
): BuildOutputManifestV1 | null {
  const normalizedRoot = normalizeRelative(outputRoot);
  if (!normalizedRoot
    || /(^|\/)(?:\.traffic-one|node_modules)(?:\/|$)/.test(normalizedRoot)) return null;
  let realProject: string;
  let realOutput: string;
  try {
    realProject = fs.realpathSync(projectRoot);
    realOutput = fs.realpathSync(path.resolve(projectRoot, normalizedRoot));
    if (!inside(realOutput, realProject) || !fs.statSync(realOutput).isDirectory()) return null;
  } catch {
    return null;
  }

  const files: BuildManifestFileV1[] = [];
  const stack = [realOutput];
  let totalBytes = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return null;
      if (entry.isDirectory()) {
        if (entry.name === 'cache' && /(^|\/)\.next\/cache$/.test(
          path.relative(realProject, absolute).replace(/\\/g, '/'),
        )) continue;
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= QA_BUILD_MANIFEST_MAX_FILES) return null;
      let stat: fs.Stats;
      try {
        const real = fs.realpathSync(absolute);
        if (!inside(real, realOutput)) return null;
        stat = fs.lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
      } catch {
        return null;
      }
      totalBytes += stat.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > QA_BUILD_MANIFEST_MAX_BYTES) return null;
      const rel = path.relative(realOutput, absolute).replace(/\\/g, '/');
      if (!normalizeRelative(rel)) return null;
      files.push({ path: rel, size: stat.size, sha256: hashFile(absolute) });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) return null;
  const canonical = {
    schemaVersion: QA_BUILD_MANIFEST_SCHEMA_VERSION,
    outputRoot: normalizedRoot,
    fileCount: files.length,
    totalBytes,
    files,
  };
  return { ...canonical, manifestHash: sha256Bytes(stableJson(canonical)) };
}

export function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function contentHash(filePath: string): string | null {
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return hashFile(filePath);
  } catch {
    return null;
  }
}
