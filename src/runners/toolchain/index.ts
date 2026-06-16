// src/runners/toolchain/index.ts
// Single source of truth for "what version of <tool> is installed" + "what does
// the plugin recommend?". The gitnexus/graphify runners use the probe + stamp
// helpers; doctor + tokenEconomyBanner use toolStatus for drift findings. The
// curated spec lives in the sibling toolchain-versions.json (resolved via
// __dirname so it works in src under tsx and compiled at scripts/). Ported 1:1
// from scripts/toolchain.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { nowIsoNoMs } from '../../shared/text';
import { spawnTool } from '../../shared/spawn-tool';
import { mergeProjectPrefs, readEffectiveState } from '../../shared/state';

export const SPEC_PATH = path.join(__dirname, 'toolchain-versions.json');

type Rec = Record<string, unknown>;
export interface ToolSpec {
  recommended?: string;
  minimum?: string;
  installLatest?: boolean;
  npmPackage?: string;
  pipxPackage?: string;
  runtime?: 'python' | 'node';
  runtimeMinMajor?: number;
  runtimeMinMinor?: number;
  versionCommand?: string;
  versionRegex?: string;
  installCommand?: string;
  [k: string]: unknown;
}

export interface ToolRuntimeReq {
  runtime: 'python' | 'node' | null;
  minMajor: number;
  minMinor: number;
}

// Latest-by-default install spec for a tool's package manager. Tools flagged
// `installLatest` install the newest published version (npm `<pkg>@latest`, pip
// unpinned `<pkg>`); otherwise — or when no `recommended` is set — they still
// default to latest. Pins to `recommended` only for a non-latest tool that has
// one. Returns null when the tool declares no package name. Single source of
// truth so every runner installs consistently.
export function toolInstallSpec(toolName: string): string | null {
  const spec = getToolSpec(toolName);
  if (!spec) return null;
  const npmPkg = typeof spec.npmPackage === 'string' ? spec.npmPackage : '';
  const pipPkg = typeof spec.pipxPackage === 'string' ? spec.pipxPackage : '';
  const rec = typeof spec.recommended === 'string' && spec.recommended ? spec.recommended : '';
  const latest = spec.installLatest === true || !rec;
  if (npmPkg) return latest ? `${npmPkg}@latest` : `${npmPkg}@${rec}`;
  if (pipPkg) return latest ? pipPkg : `${pipPkg}==${rec}`;
  return null;
}

// The language runtime a tool needs (declared in toolchain-versions.json). The
// shared runtime resolver (src/shared/runtime-resolve.ts) consumes this to find a
// satisfying interpreter via GUI-PATH-proof absolute locations.
export function toolRuntime(toolName: string): ToolRuntimeReq {
  const spec = getToolSpec(toolName);
  const runtime = spec && (spec.runtime === 'python' || spec.runtime === 'node') ? spec.runtime : null;
  const minMajor = spec && typeof spec.runtimeMinMajor === 'number' ? spec.runtimeMinMajor : 0;
  const minMinor = spec && typeof spec.runtimeMinMinor === 'number' ? spec.runtimeMinMinor : 0;
  return { runtime, minMajor, minMinor };
}

export type ToolStatusKind = 'unknown' | 'missing' | 'too-old' | 'outdated' | 'current';

export interface ToolProbe {
  binPath: string | null;
  version: string | null;
  status: ToolStatusKind;
  recommended: string | null;
  minimum: string | null;
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

// Managed-toolchain path helpers live in shared/ (pure path/env logic) so hook
// modules can use them without importing a runner; re-exported here for the
// runners' existing import sites.
import { managedNpmBin } from '../../shared/toolchain-paths';

export {
  managedNpmBin,
  managedNpmConfigFlags,
  managedNpmPrefix,
  managedToolDir,
  managedVenvBin,
  managedVenvPython,
  toolchainRoot,
} from '../../shared/toolchain-paths';

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
    // spawnTool: a managed tool's bin may be a Windows .cmd shim (e.g. opencode.cmd).
    result = spawnTool(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 1000 });
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
  status: ToolStatusKind;
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

export function probeTool(toolName: string, binPath: string | null): ToolProbe {
  const version = binPath ? probeToolVersion(toolName, { binPath }) : null;
  const status = toolStatus(toolName, version);
  return {
    binPath,
    version,
    status: status.status,
    recommended: status.recommended,
    minimum: status.minimum,
  };
}

export function isToolUsable(status: ToolStatusKind): boolean {
  return status === 'current' || status === 'outdated';
}

// Reconcile state→disk: when a MANAGED tool binary is present but state carries
// no installedVersion (installed out-of-band, or a re-materialization reset the
// toolchain record), backfill the stamp so the orchestrator and downstream gates
// (e.g. openCodeDelegationActive) stop treating the tool as absent. The managed
// install is pinned to the spec's `recommended` version, so we record that
// WITHOUT spawning the binary — a `--version` probe on the hot delegation path
// would add a process per call and, with a side-effecting CLI, risk touching the
// repo. Does NOT install. Best-effort and never throws — a stamp failure must
// never block the caller. Returns the stamped version, or null when nothing
// changed (already stamped / nothing present / no recommended version).
export function reconcileManagedToolStamp(cwd: string, toolName: string, binName: string = toolName): string | null {
  try {
    const state = readEffectiveState(cwd);
    const tc = state.toolchain && typeof state.toolchain === 'object' ? (state.toolchain as Rec) : {};
    const entry = tc[toolName] && typeof tc[toolName] === 'object' ? (tc[toolName] as Rec) : null;
    if (entry && typeof entry.installedVersion === 'string' && entry.installedVersion) return null;
    const managedBin = managedNpmBin(toolName, binName);
    if (!fs.existsSync(managedBin)) return null;
    const spec = getToolSpec(toolName);
    const version = typeof spec?.recommended === 'string' && spec.recommended ? spec.recommended : null;
    if (!version) return null;
    const updated = mergeToolchainStamp(state, toolName, { version, binPath: managedBin, at: nowIsoNoMs() });
    mergeProjectPrefs(cwd, { toolchain: updated.toolchain });
    return version;
  } catch {
    return null;
  }
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
