// src/shared/state/toolchain.ts
// Toolchain stamp seeding, deduped (legacy normalize.cjs + local-prefs.cjs each
// carried an identical copy of these two functions).

import * as path from 'path';

import { readJson } from '../fsjson';
import { pluginRoot } from '../paths';

export interface ToolStamp {
  installedVersion: string | null;
  installedAt: string | null;
  binPath?: string;
}

const FALLBACK_TOOLS = ['gitnexus', 'graphify', 'gitleaks', 'trufflehog'];

export function toolNamesFromSpec(): string[] {
  try {
    const specPath = path.join(pluginRoot(), 'scripts', 'toolchain-versions.json');
    const parsed = readJson<{ tools?: Record<string, unknown> }>(specPath, {});
    const tools = parsed && typeof parsed.tools === 'object' && parsed.tools ? parsed.tools : {};
    const names = Object.keys(tools).sort();
    return names.length > 0 ? names : [...FALLBACK_TOOLS];
  } catch {
    return [...FALLBACK_TOOLS];
  }
}

export function initializeToolchainState(existing: unknown = {}): Record<string, ToolStamp> {
  const out: Record<string, ToolStamp> = {};
  const source = existing && typeof existing === 'object' ? (existing as Record<string, unknown>) : {};
  for (const name of toolNamesFromSpec()) {
    const cur = source[name] && typeof source[name] === 'object'
      ? (source[name] as Record<string, unknown>)
      : {};
    out[name] = {
      installedVersion: (typeof cur.installedVersion === 'string' && cur.installedVersion) || null,
      installedAt: (typeof cur.installedAt === 'string' && cur.installedAt) || null,
      ...(typeof cur.binPath === 'string' && cur.binPath ? { binPath: cur.binPath } : {}),
    };
  }
  return out;
}

// Legacy alias (local-prefs used a separate name for the identical function).
export const initializeLocalToolchainState = initializeToolchainState;

// A toolchain is "initialized" once every tracked tool has installedVersion +
// installedAt keys present (the stamp may still be null, but the keys exist).
export function hasInitializedToolchain(toolchain: unknown): boolean {
  if (!toolchain || typeof toolchain !== 'object') return false;
  const tc = toolchain as Record<string, unknown>;
  const expected = initializeToolchainState({});
  return Object.keys(expected).every((toolName) => {
    const entry = tc[toolName];
    return Boolean(
      entry
      && typeof entry === 'object'
      && Object.prototype.hasOwnProperty.call(entry, 'installedVersion')
      && Object.prototype.hasOwnProperty.call(entry, 'installedAt'),
    );
  });
}
