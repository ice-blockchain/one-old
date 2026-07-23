// Content-addressed release-harness helpers. Marketplace hosts must never infer
// freshness from a successful CLI exit alone: the source tree is fingerprinted,
// and Codex gets a real marketplace root containing an immutable copy of it.

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { HostId } from './types';

type Json = Record<string, unknown>;

export interface CodexMarketplaceStage {
  root: string;
  stagesRoot: string;
  name: string;
  pluginSelector: string;
  stagedPluginRoot: string;
  sourceFingerprint: string;
  cacheVersion: string;
}

export const RUNTIME_PROOF_FILE_ENV = 'TRAFFIC_ONE_TEST_RUNTIME_PROOF_FILE';
export const RUNTIME_PROOF_TOKEN_ENV = 'TRAFFIC_ONE_TEST_RUNTIME_PROOF_TOKEN';
export const RUNTIME_PROOF_ENTRY_ENV = 'TRAFFIC_ONE_TEST_RUNTIME_PROOF_ENTRY';
const RUNTIME_PROOF_METADATA_FILE = '.traffic-one-e2e-runtime-proof.json';

const RUNTIME_ENTRY_BY_HOST: Record<HostId, string> = {
  claude: 'scripts/hook-runtime.cjs',
  codex: 'scripts/hook-runtime.cjs',
  cursor: 'scripts/cursor-hook-runtime.cjs',
  opencode: 'scripts/opencode-hook-runtime.cjs',
  kilo: 'scripts/kilo-hook-runtime.cjs',
  copilot: 'scripts/copilot-hook-runtime.cjs',
  windsurf: 'scripts/windsurf-hook-runtime.cjs',
};

export interface RuntimeProofMetadata {
  version: 1;
  token: string;
  entries: Partial<Record<HostId, string>>;
}

interface RuntimeProofPatchedFile {
  path: string;
  original: Buffer;
  injected: Buffer;
}

export interface ArmedRuntimeProof {
  distRoot: string;
  hosts: HostId[];
  metadata: RuntimeProofMetadata;
  metadataPath: string;
  metadataBytes: Buffer;
  patchedFiles: RuntimeProofPatchedFile[];
  restored?: boolean;
}

export function runtimeProofEntryForHost(host: HostId): string {
  return RUNTIME_ENTRY_BY_HOST[host];
}

function runtimeProofPrelude(token: string, entry: string): string {
  const payload = `${JSON.stringify({ version: 1, token, entry })}\n`;
  return [
    "'use strict';",
    '// Injected temporarily by src/test-environment; restored after the E2E run.',
    'try {',
    `  const proofFile = process.env.${RUNTIME_PROOF_FILE_ENV};`,
    `  if (proofFile) require('fs').writeFileSync(proofFile, ${JSON.stringify(payload)}, 'utf8');`,
    '} catch { /* release proof is asserted by the harness */ }',
    '',
  ].join('\n');
}

function parseRuntimeProofMetadata(value: unknown): RuntimeProofMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.token !== 'string' || !/^[a-f0-9]{32}$/.test(raw.token)) return null;
  if (!raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) return null;
  const entries: Partial<Record<HostId, string>> = {};
  for (const host of Object.keys(RUNTIME_ENTRY_BY_HOST) as HostId[]) {
    const entry = (raw.entries as Record<string, unknown>)[host];
    if (typeof entry === 'string' && entry === RUNTIME_ENTRY_BY_HOST[host]) entries[host] = entry;
  }
  return { version: 1, token: raw.token, entries };
}

export function readDistRuntimeProof(distRoot: string): RuntimeProofMetadata | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(distRoot, RUNTIME_PROOF_METADATA_FILE), 'utf8')) as unknown;
    return parseRuntimeProofMetadata(parsed);
  } catch {
    return null;
  }
}

// Add a unique, hard-coded token writer to the exact compiled hook entrypoints
// selected for this E2E run. A stale runtime cannot emit the new token even if
// it shares the package version or inherits the harness environment. The source
// dist bytes are restored byte-for-byte by cleanupBuildInstall.
export function armDistRuntimeProof(distRoot: string, hosts: HostId[]): ArmedRuntimeProof {
  const metadataPath = path.join(distRoot, RUNTIME_PROOF_METADATA_FILE);
  if (fs.existsSync(metadataPath)) {
    throw new Error(`dist already contains an active runtime proof marker: ${metadataPath}; rebuild it before running E2E`);
  }

  const token = randomBytes(16).toString('hex');
  const entries: Partial<Record<HostId, string>> = {};
  for (const host of hosts) entries[host] = runtimeProofEntryForHost(host);
  const metadata: RuntimeProofMetadata = { version: 1, token, entries };
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  const patchedFiles: RuntimeProofPatchedFile[] = [];

  try {
    for (const entry of [...new Set(Object.values(entries))]) {
      if (!entry) continue;
      const file = path.join(distRoot, entry);
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`runtime proof entrypoint is missing: ${entry}`);
      }
      const original = fs.readFileSync(file);
      const injected = Buffer.concat([Buffer.from(runtimeProofPrelude(token, entry), 'utf8'), original]);
      fs.writeFileSync(file, injected);
      patchedFiles.push({ path: file, original, injected });
    }
    fs.writeFileSync(metadataPath, metadataBytes);
  } catch (error) {
    for (const patched of patchedFiles.reverse()) {
      try { fs.writeFileSync(patched.path, patched.original); } catch { /* best effort rollback */ }
    }
    try { fs.rmSync(metadataPath, { force: true }); } catch { /* best effort rollback */ }
    throw error;
  }

  return { distRoot, hosts: [...hosts], metadata, metadataPath, metadataBytes, patchedFiles };
}

export function restoreDistRuntimeProof(proof: ArmedRuntimeProof): string[] {
  if (proof.restored) return [];
  const failures: string[] = [];
  for (const patched of proof.patchedFiles) {
    try {
      const current = fs.readFileSync(patched.path);
      if (!current.equals(patched.injected)) {
        failures.push(`refused to overwrite runtime entrypoint changed during E2E: ${patched.path}`);
        continue;
      }
      fs.writeFileSync(patched.path, patched.original);
    } catch (error) {
      failures.push(`could not restore runtime entrypoint ${patched.path}: ${String(error)}`);
    }
  }
  try {
    const currentMetadata = fs.readFileSync(proof.metadataPath);
    if (!currentMetadata.equals(proof.metadataBytes)) {
      failures.push(`refused to remove runtime proof metadata changed during E2E: ${proof.metadataPath}`);
    } else {
      fs.rmSync(proof.metadataPath, { force: true });
    }
  } catch (error) {
    failures.push(`could not remove runtime proof metadata ${proof.metadataPath}: ${String(error)}`);
  }
  if (failures.length === 0) proof.restored = true;
  return failures;
}

function sortedEntries(dir: string): fs.Dirent[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function hashTreeEntry(hash: ReturnType<typeof createHash>, root: string, rel: string): void {
  const full = path.join(root, rel);
  const stat = fs.lstatSync(full);
  const portable = rel.split(path.sep).join('/');
  if (stat.isSymbolicLink()) {
    hash.update(`L\0${portable}\0${fs.readlinkSync(full)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`D\0${portable}\0`);
    for (const entry of sortedEntries(full)) {
      hashTreeEntry(hash, root, path.join(rel, entry.name));
    }
    return;
  }
  if (stat.isFile()) {
    hash.update(`F\0${portable}\0${stat.mode & 0o777}\0`);
    hash.update(fs.readFileSync(full));
    hash.update('\0');
  }
}

export function distTreeFingerprint(distRoot: string): string {
  if (!fs.statSync(distRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`dist root is missing or not a directory: ${distRoot}`);
  }
  const hash = createHash('sha256');
  for (const entry of sortedEntries(distRoot)) {
    hashTreeEntry(hash, distRoot, entry.name);
  }
  return hash.digest('hex');
}

function readObject(file: string): Json {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`expected JSON object at ${file}`);
  }
  return parsed as Json;
}

function writeObject(file: string, value: Json): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function stageCodexMarketplace(
  distRoot: string,
  stagesRoot: string,
): CodexMarketplaceStage {
  const sourceFingerprint = distTreeFingerprint(distRoot);
  const shortHash = sourceFingerprint.slice(0, 16);
  const resolvedStagesRoot = path.resolve(stagesRoot);
  fs.mkdirSync(resolvedStagesRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(resolvedStagesRoot, `traffic-one-e2e-${shortHash}-`));
  const name = path.basename(root);
  const stagedPluginRoot = path.join(root, 'plugins', 'traffic-one');
  const pluginSelector = `traffic-one@${name}`;
  try {
    fs.mkdirSync(path.dirname(stagedPluginRoot), { recursive: true });
    fs.cpSync(distRoot, stagedPluginRoot, { recursive: true, dereference: false });

    // Prove the copy was byte-for-byte current before applying the isolated cache
    // version below. A changed source tree creates a different marketplace id and
    // cache key, so an "already installed" result can only reuse identical bytes.
    const copiedFingerprint = distTreeFingerprint(stagedPluginRoot);
    if (copiedFingerprint !== sourceFingerprint) {
      throw new Error(`Codex marketplace staging mismatch: source=${sourceFingerprint} copy=${copiedFingerprint}`);
    }

    const pluginManifestPath = path.join(stagedPluginRoot, '.codex-plugin', 'plugin.json');
    const pluginManifest = readObject(pluginManifestPath);
    const cacheVersion = `0.0.0-e2e.${shortHash}`;
    writeObject(pluginManifestPath, { ...pluginManifest, version: cacheVersion });

    writeObject(path.join(root, '.agents', 'plugins', 'marketplace.json'), {
      name,
      interface: { displayName: `Traffic One E2E ${shortHash}` },
      plugins: [
        {
          name: 'traffic-one',
          source: { source: 'local', path: './plugins/traffic-one' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Developer Tools',
        },
      ],
    });
    writeObject(path.join(root, '.traffic-one-e2e.json'), {
      version: 1,
      root,
      stagesRoot: resolvedStagesRoot,
      name,
      pluginSelector,
      sourceFingerprint,
      cacheVersion,
      stagedPluginRoot,
    });

    return {
      root,
      stagesRoot: resolvedStagesRoot,
      name,
      pluginSelector,
      stagedPluginRoot,
      sourceFingerprint,
      cacheVersion,
    };
  } catch (error) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(`Codex marketplace staging failed (${String(error)}) and could not remove ${root}: ${String(cleanupError)}`);
    }
    throw error;
  }
}
