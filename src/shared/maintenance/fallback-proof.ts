// Dependency-light, runtime-owned evidence for a paid maintenance fallback.
// The finalizer and lifecycle reconciler both validate this exact structure;
// prose or a bare `fallback-paid` marker is never completion evidence.

import * as fs from 'fs';
import * as path from 'path';

import { sha256 } from '../text';

const FALLBACK_SOURCE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
const PAID_FALLBACK_COMPLETION_SCHEMA_VERSION = 1 as const;
const MAX_FALLBACK_SOURCE_FILES = 128;
const MAX_FALLBACK_SOURCE_BYTES = 16 * 1024 * 1024;

type Rec = Record<string, unknown>;

export interface FallbackSourceFileV1 {
  path: string;
  state: 'file' | 'missing';
  size: number;
  hash: string | null;
}

export interface FallbackSourceSnapshotV1 {
  schemaVersion: typeof FALLBACK_SOURCE_SNAPSHOT_SCHEMA_VERSION;
  capturedAt: string;
  files: FallbackSourceFileV1[];
  stateHash: string;
  snapshotHash: string;
}

interface PaidFallbackCompletionV1 {
  schemaVersion: typeof PAID_FALLBACK_COMPLETION_SCHEMA_VERSION;
  authority: 'traffic-one-runtime';
  role: string;
  envelopeHash: string;
  workUnitContractHash: string;
  allowlistHash: string;
  digestPath: string;
  digestHash: string;
  sourceBaselineHash: string;
  sourceResultHash: string;
  runBaselineHash: string;
  changedPaths: string[];
  completedAt: string;
  completionHash: string;
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

function hash(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

function safeRelativeFile(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
  if (!normalized
    || normalized.startsWith('/')
    || normalized === '.'
    || normalized.split('/').includes('..')
    || normalized.includes('\0')
    || /[*?[\]{}]/.test(normalized)
    || normalized === '.traffic-one'
    || normalized.startsWith('.traffic-one/')) return null;
  return normalized;
}

function sourceStateHash(files: readonly FallbackSourceFileV1[]): string {
  return hash({ files });
}

export function captureFallbackSourceSnapshot(
  projectRoot: string,
  sourcePaths: readonly string[],
  capturedAt = new Date().toISOString(),
): FallbackSourceSnapshotV1 | null {
  const normalized = [...new Set(sourcePaths.map((item) => safeRelativeFile(item) || ''))]
    .filter(Boolean)
    .sort();
  if (normalized.length === 0
    || normalized.length > MAX_FALLBACK_SOURCE_FILES
    || normalized.length !== new Set(sourcePaths).size) return null;
  const files: FallbackSourceFileV1[] = [];
  for (const relative of normalized) {
    const absolute = path.resolve(projectRoot, relative);
    const root = path.resolve(projectRoot);
    if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) return null;
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FALLBACK_SOURCE_BYTES) return null;
      const bytes = fs.readFileSync(absolute);
      files.push({
        path: relative,
        state: 'file',
        size: bytes.length,
        hash: sha256(bytes.toString('base64')),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      files.push({ path: relative, state: 'missing', size: 0, hash: null });
    }
  }
  const stateHash = sourceStateHash(files);
  const canonical = {
    schemaVersion: FALLBACK_SOURCE_SNAPSHOT_SCHEMA_VERSION,
    capturedAt,
    files,
    stateHash,
  };
  return { ...canonical, snapshotHash: hash(canonical) };
}

export function parseFallbackSourceSnapshot(value: unknown): FallbackSourceSnapshotV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<FallbackSourceSnapshotV1>;
  if (raw.schemaVersion !== FALLBACK_SOURCE_SNAPSHOT_SCHEMA_VERSION
    || typeof raw.capturedAt !== 'string'
    || !Array.isArray(raw.files)
    || raw.files.length === 0
    || raw.files.length > MAX_FALLBACK_SOURCE_FILES
    || typeof raw.stateHash !== 'string'
    || typeof raw.snapshotHash !== 'string') return null;
  const files: FallbackSourceFileV1[] = [];
  for (const candidate of raw.files) {
    if (!candidate || typeof candidate !== 'object') return null;
    const entry = candidate as Partial<FallbackSourceFileV1>;
    const relative = typeof entry.path === 'string' ? safeRelativeFile(entry.path) : null;
    if (!relative
      || (entry.state !== 'file' && entry.state !== 'missing')
      || !Number.isInteger(entry.size)
      || Number(entry.size) < 0
      || Number(entry.size) > MAX_FALLBACK_SOURCE_BYTES
      || (entry.state === 'file' && (
        typeof entry.hash !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry.hash)
      ))
      || (entry.state === 'missing' && (entry.hash !== null || entry.size !== 0))) return null;
    files.push({
      path: relative,
      state: entry.state,
      size: Number(entry.size),
      hash: entry.hash ?? null,
    });
  }
  if (new Set(files.map((entry) => entry.path)).size !== files.length
    || files.some((entry, index) => index > 0 && files[index - 1]!.path.localeCompare(entry.path) >= 0)
    || sourceStateHash(files) !== raw.stateHash) return null;
  const { snapshotHash: observed, ...canonical } = raw;
  if (hash(canonical) !== observed) return null;
  return raw as FallbackSourceSnapshotV1;
}

export function createPaidFallbackCompletion(
  input: Omit<PaidFallbackCompletionV1, 'schemaVersion' | 'authority' | 'completionHash'>,
): PaidFallbackCompletionV1 {
  const canonical = {
    schemaVersion: PAID_FALLBACK_COMPLETION_SCHEMA_VERSION,
    authority: 'traffic-one-runtime' as const,
    ...input,
    changedPaths: [...new Set(input.changedPaths)].sort(),
  };
  return { ...canonical, completionHash: hash(canonical) };
}

function parsePaidFallbackCompletion(value: unknown): PaidFallbackCompletionV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<PaidFallbackCompletionV1>;
  if (raw.schemaVersion !== PAID_FALLBACK_COMPLETION_SCHEMA_VERSION
    || raw.authority !== 'traffic-one-runtime'
    || typeof raw.role !== 'string'
    || !raw.role.trim()
    || typeof raw.envelopeHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.envelopeHash)
    || typeof raw.workUnitContractHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.workUnitContractHash)
    || typeof raw.allowlistHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.allowlistHash)
    || typeof raw.digestPath !== 'string'
    || !raw.digestPath.startsWith('.traffic-one/digests/')
    || typeof raw.digestHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.digestHash)
    || typeof raw.sourceBaselineHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.sourceBaselineHash)
    || typeof raw.sourceResultHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.sourceResultHash)
    || raw.sourceBaselineHash === raw.sourceResultHash
    || typeof raw.runBaselineHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.runBaselineHash)
    || !Array.isArray(raw.changedPaths)
    || raw.changedPaths.length === 0
    || !raw.changedPaths.every((item) => typeof item === 'string' && Boolean(safeRelativeFile(item)))
    || new Set(raw.changedPaths).size !== raw.changedPaths.length
    || raw.changedPaths.some((item, index) => index > 0
      && String(raw.changedPaths?.[index - 1]).localeCompare(item) >= 0)
    || typeof raw.completedAt !== 'string'
    || !Number.isFinite(Date.parse(raw.completedAt))
    || typeof raw.completionHash !== 'string') return null;
  const { completionHash: observed, ...canonical } = raw;
  if (hash(canonical) !== observed) return null;
  return raw as PaidFallbackCompletionV1;
}

export function paidFallbackCompletionFromMaintenance(
  value: unknown,
): PaidFallbackCompletionV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const marker = value as Rec;
  const outcomes = [marker.overallOutcome, marker.outcome]
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase());
  if (!outcomes.includes('fallback-paid')) return null;
  const completion = parsePaidFallbackCompletion(marker.fallbackCompletion);
  if (!completion
    || marker.role !== completion.role
    || marker.workUnitContractHash !== completion.workUnitContractHash
    || marker.allowlistHash !== completion.allowlistHash) return null;
  return completion;
}
