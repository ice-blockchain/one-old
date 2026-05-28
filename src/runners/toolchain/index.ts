// src/runners/toolchain/index.ts
// Single source of truth for "what version of <tool> is installed" + "what does
// the plugin recommend?". The gitnexus/graphify runners use the probe + stamp
// helpers; doctor + tokenEconomyBanner use toolStatus for drift findings. The
// curated spec lives in the sibling toolchain-versions.json (resolved via
// __dirname so it works in src under tsx and compiled at scripts/). Ported 1:1
// from scripts/toolchain.cjs.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { nowIsoNoMs } from '../../shared/text';

export const SPEC_PATH = path.join(__dirname, 'toolchain-versions.json');

type Rec = Record<string, unknown>;
export interface ToolSpec {
  recommended?: string;
  minimum?: string;
  versionCommand?: string;
  versionRegex?: string;
  installCommand?: string;
  [k: string]: unknown;
}

let cachedSpec: Record<string, ToolSpec> | null = null;
export function loadSpec(): Record<string, ToolSpec> {
  if (cachedSpec !== null) return cachedSpec;
  try {
    const parsed = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
    cachedSpec = (parsed && parsed.tools) || {};
  } catch {
    cachedSpec = {};
  }
  return cachedSpec as Record<string, ToolSpec>;
}

export function getToolSpec(toolName: string): ToolSpec | null {
  const spec = loadSpec();
  return Object.prototype.hasOwnProperty.call(spec, toolName) ? (spec[toolName] as ToolSpec) : null;
}

// Compare two semver strings (no dep). -1 / 0 / 1, or null for non-semver.
export function compareSemver(a: unknown, b: unknown): number | null {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const norm = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => Number(n));
  const aa = norm(a);
  const bb = norm(b);
  if (aa.length !== 3 || bb.length !== 3) return null;
  if (aa.some(Number.isNaN) || bb.some(Number.isNaN)) return null;
  for (let i = 0; i < 3; i += 1) {
    const av = aa[i] as number;
    const bv = bb[i] as number;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

// Probe `tool --version` and extract the semver via the spec's versionRegex.
// Returns the matched semver, or null on any failure. opts.binPath forces an
// absolute binary path (PATH-order independence, e.g. nvm-v22 gitnexus).
export function probeToolVersion(toolName: string, opts: { binPath?: string } = {}): string | null {
  const spec = getToolSpec(toolName);
  if (!spec) return null;

  const tokens = String(spec.versionCommand || `${toolName} --version`).split(/\s+/);
  const cmd = opts.binPath && typeof opts.binPath === 'string' ? opts.binPath : (tokens[0] as string);
  const args = tokens.slice(1);

  let result;
  try {
    result = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 1000 });
  } catch {
    return null;
  }
  const blob = `${(result.stdout || '').trim()}\n${(result.stderr || '').trim()}`;
  const regex = new RegExp(spec.versionRegex || 'v?(\\d+\\.\\d+\\.\\d+)');
  const match = regex.exec(blob);
  return match && match[1] ? match[1] : null;
}

export interface ToolStatus {
  installed: string | null;
  recommended: string | null;
  minimum: string | null;
  status: 'unknown' | 'missing' | 'too-old' | 'outdated' | 'current';
}

// Where a tool sits vs. spec: unknown / missing / too-old / outdated / current.
export function toolStatus(toolName: string, installedVersion: unknown): ToolStatus {
  const spec = getToolSpec(toolName);
  if (!spec) {
    return { installed: (installedVersion as string) || null, recommended: null, minimum: null, status: 'unknown' };
  }
  if (!installedVersion) {
    return { installed: null, recommended: spec.recommended ?? null, minimum: spec.minimum ?? null, status: 'missing' };
  }
  const vMin = compareSemver(installedVersion, spec.minimum);
  const vRec = compareSemver(installedVersion, spec.recommended);
  let status: ToolStatus['status'] = 'current';
  if (vMin !== null && vMin < 0) status = 'too-old';
  else if (vRec !== null && vRec < 0) status = 'outdated';
  return { installed: installedVersion as string, recommended: spec.recommended ?? null, minimum: spec.minimum ?? null, status };
}

// Merge a toolchain stamp into the in-memory state object (caller persists).
export function mergeToolchainStamp(
  state: unknown,
  toolName: string,
  { version, binPath, at }: { version?: string | null; binPath?: string; at?: string },
): Rec {
  const next: Rec = state && typeof state === 'object' ? (state as Rec) : {};
  const toolchain: Rec = next.toolchain && typeof next.toolchain === 'object' ? (next.toolchain as Rec) : {};
  toolchain[toolName] = {
    installedVersion: version || null,
    installedAt: at || nowIsoNoMs(),
    ...(binPath ? { binPath } : {}),
  };
  next.toolchain = toolchain;
  return next;
}
