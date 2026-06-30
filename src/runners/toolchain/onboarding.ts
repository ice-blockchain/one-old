// src/runners/toolchain/onboarding.ts
// Hook-owned toolchain preflight for onboarding/local-preference writes. The
// user's OpenCode/code-graph choices are the consent record; this module checks
// installed versions and installs/upgrades user-local managed tools when needed.

import * as fs from 'fs';
import * as path from 'path';

import { exec } from '../../shared/exec';
import { ensureManagedRuntime } from '../../shared/managed-runtime';
import { spawnTool } from '../../shared/spawn-tool';
import { mergeProjectPrefs, readEffectiveState } from '../../shared/state';
import { nowIso } from '../../shared/text';
import { ensureGitnexusTool } from '../gitnexus';
import { ensureGraphifyTool, type GraphifyToolResult } from '../graphify';
import { resolveNode, npmNextToNode } from '../../shared/runtime-resolve';
import {
  getToolSpec,
  isToolUsable,
  managedNpmBin,
  managedNpmConfigFlags,
  managedNpmPrefix,
  mergeToolchainStamp,
  probeTool,
  probeToolVersion,
  toolInstallSpec,
  toolRuntime,
} from './index';

type Rec = Record<string, unknown>;
const which = exec.which;

export interface OnboardingToolResult {
  tool: string;
  ok: boolean;
  action: string;
  error: string | null;
  binPath: string | null;
  installedVersion?: string | null;
}

function writeStateMerge(cwd: string, patch: Rec): void {
  try {
    mergeProjectPrefs(cwd, patch);
  } catch {
    // best-effort; the hook should not fail the user's write.
  }
}

function stampToolchain(cwd: string, toolName: string, binPath: string, version?: string | null): void {
  if (!version) return;
  const current = readEffectiveState(cwd);
  const updated = mergeToolchainStamp(current, toolName, { version, binPath, at: nowIso() });
  writeStateMerge(cwd, { toolchain: updated.toolchain });
}

// LATEST-by-default install spec via the shared toolchain contract
// (= "opencode-ai@latest"); the old "@<recommended>" pin is gone. `recommended`
// survives only as a stamp fallback (opencodeRecommendedVersion below).
function opencodePackageSpec(): string {
  return toolInstallSpec('opencode') || 'opencode-ai@latest';
}

function opencodeRecommendedVersion(): string | null {
  const spec = getToolSpec('opencode');
  return typeof spec?.recommended === 'string' && spec.recommended ? spec.recommended : null;
}

// The first `opencode <anything>` on a machine triggers a one-time DB migration
// that "may take a few minutes" — a 10s version probe would time out and report
// no version, leaving OpenCode unstamped (which silently disables delegation +
// the tier-shift). Warm it up with a generous timeout so the probe is fast and
// reliable. Best-effort; never throws.
function warmUpOpencode(binPath: string): void {
  try {
    // spawnTool: binPath is the managed opencode.cmd shim on Windows.
    spawnTool(binPath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60 * 1000 });
  } catch {
    // best-effort
  }
}

// Major version of the Node backing an npm (the node beside it, else the PATH
// node), probed DIRECTLY — not via the probe-gated resolveNode — so it works under
// the test preload and doesn't bypass a stubbed PATH npm. Returns null when no node
// is found or the version can't be parsed (caller treats null as "unknown → keep").
function npmBackingNodeMajor(npm: string): number | null {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const adjacent = path.join(path.dirname(npm), `node${ext}`);
  const nodePath = fs.existsSync(adjacent) ? adjacent : which('node');
  if (!nodePath) return null;
  try {
    const r = spawnTool(nodePath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 1000 });
    const m = /v?(\d+)\./.exec((r.stdout || '').trim());
    return m && m[1] ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function withNpmLifecyclePath(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return { ...baseEnv };
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const parts = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of ['/bin', '/usr/bin']) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  env.PATH = parts.join(path.delimiter);
  if (!env.npm_config_script_shell && fs.existsSync('/bin/sh')) {
    env.npm_config_script_shell = '/bin/sh';
  }
  return env;
}

export function ensureOpenCodeTool(cwd: string = process.cwd()): OnboardingToolResult {
  const managedBin = managedNpmBin('opencode', 'opencode');
  const candidates = [
    { binPath: fs.existsSync(managedBin) ? managedBin : null, action: 'used-managed' },
    { binPath: which('opencode'), action: 'used-existing' },
  ];
  for (const candidate of candidates) {
    if (!candidate.binPath) continue;
    const probed = probeTool('opencode', candidate.binPath);
    if (isToolUsable(probed.status)) {
      stampToolchain(cwd, 'opencode', candidate.binPath, probed.version);
      return { tool: 'opencode', ok: true, action: candidate.action, error: null, binPath: candidate.binPath, installedVersion: probed.version };
    }
    // A present bin with no parseable version is almost always the first-run
    // migration timing out the probe — warm it up and assume the pinned recommended
    // version, so a present OpenCode is never left unstamped (the "enabled but
    // installedVersion:null" case that makes openCodeDelegationActive() false and
    // silently disables delegation + the tier-shift). Applies to a managed bin AND a
    // user's global opencode on PATH (`used-existing`) — both run the delegate alike.
    if (probed.version === null) {
      warmUpOpencode(candidate.binPath);
      const version = probeToolVersion('opencode', { binPath: candidate.binPath }) || opencodeRecommendedVersion();
      if (version) {
        stampToolchain(cwd, 'opencode', candidate.binPath, version);
        return { tool: 'opencode', ok: true, action: candidate.action, error: null, binPath: candidate.binPath, installedVersion: version };
      }
    }
  }

  // Prefer PATH npm (the working path) — but ONLY when its backing Node satisfies
  // opencode-ai's minimum. A PATH npm on a too-old Node (e.g. 16) would install a
  // CLI that can't run (the "enabled but unusable" trap). Reject a KNOWN-too-old
  // backing Node; unknown (no node found) keeps the prior behavior. A stale GUI PATH
  // with no usable npm falls back to a runtime-resolved Node's npm (nvm/Homebrew
  // absolutes), then the managed Node's. Only error when ALL are unavailable.
  const { minMajor } = toolRuntime('opencode');
  let npm = which('npm');
  if (npm) {
    const backingMajor = npmBackingNodeMajor(npm);
    if (backingMajor !== null && backingMajor < minMajor) npm = null;
  }
  if (!npm) {
    const node = resolveNode(minMajor);
    npm = node ? npmNextToNode(node.path) : null;
  }
  if (!npm) {
    // Last resort: the npm bundled with a Traffic One-managed standalone Node
    // (isolated dir, never on PATH). Shared with gitnexus — fetched once.
    const managed = ensureManagedRuntime('node', { minMajor });
    if (managed.ok && managed.binDir) {
      const cand = path.join(managed.binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
      if (fs.existsSync(cand)) npm = cand;
    }
  }
  if (!npm) {
    return { tool: 'opencode', ok: false, action: 'install-skipped', error: '`npm` is not on PATH (and no runtime-resolved or managed Node/npm was found), so the hook cannot install OpenCode automatically', binPath: null };
  }

  // spawnTool for the Windows npm.cmd shim; managed user+global config (two
  // DISTINCT absent files via managedNpmConfigFlags) so a user `.npmrc prefix=`
  // can't redirect the install out of the managed dir, WITHOUT tripping npm >= 11's
  // "double-loading config ... as global, previously loaded as user" rejection
  // (which silently broke every opencode install on node 25 / npm 11).
  const ocPrefix = managedNpmPrefix('opencode');
  const result = spawnTool(npm, ['install', '-g', '--prefix', ocPrefix, ...managedNpmConfigFlags(ocPrefix), opencodePackageSpec()], {
    encoding: 'utf8',
    env: withNpmLifecyclePath(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180 * 1000,
  });
  if (result.status !== 0 || !fs.existsSync(managedBin)) {
    const error = `managed npm install of OpenCode failed: ${(result.stderr || '').trim() || 'non-zero exit'}`;
    // Persist the failure so an "enabled but installedVersion:null" project is
    // diagnosable (doctor) instead of silently failing — the detached self-heal
    // install discards stdio, so this stamp is the only trace it leaves.
    writeStateMerge(cwd, { opencodeLastErrorAt: nowIso(), opencodeLastError: error });
    return { tool: 'opencode', ok: false, action: 'install-skipped', error, binPath: null };
  }
  // Clear any prior failure marker on a successful install.
  writeStateMerge(cwd, { opencodeLastErrorAt: null, opencodeLastError: null });

  // Complete the one-time DB migration now (generous timeout) so the version
  // probe — and the first real delegation — don't pay it / time out later.
  warmUpOpencode(managedBin);
  const installedVersion = probeToolVersion('opencode', { binPath: managedBin }) || opencodeRecommendedVersion();
  stampToolchain(cwd, 'opencode', managedBin, installedVersion);
  return { tool: 'opencode', ok: true, action: 'installed-managed-npm', error: null, binPath: managedBin, installedVersion };
}

function normalizeGraphifyResult(result: GraphifyToolResult): OnboardingToolResult {
  return {
    tool: 'graphify',
    ok: result.ok,
    action: result.action,
    error: result.error,
    binPath: result.binPath,
    installedVersion: result.installedVersion,
  };
}

function shouldMention(result: OnboardingToolResult): boolean {
  if (!result.ok) return true;
  return !['used-existing', 'used-managed', 'used-nvm-v22'].includes(result.action);
}

function formatResult(result: OnboardingToolResult): string | null {
  if (!shouldMention(result)) return null;
  if (result.ok) {
    const version = result.installedVersion ? ` ${result.installedVersion}` : '';
    return `[toolchain] ${result.tool}${version} ready via hook-owned ${result.action}.`;
  }
  return `[toolchain] ${result.tool} install/upgrade failed: ${result.error || 'unknown error'}.`;
}

export function ensureOnboardingToolchainContext(cwd: string): string | null {
  const state = readEffectiveState(cwd);
  const results: OnboardingToolResult[] = [];

  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  if (provider === 'graphify') {
    results.push(normalizeGraphifyResult(ensureGraphifyTool(cwd)));
  } else if (provider === 'gitnexus') {
    const result = ensureGitnexusTool(cwd);
    results.push({
      tool: 'gitnexus',
      ok: result.ok,
      action: result.action,
      error: result.error,
      binPath: result.gitnexusBin,
      installedVersion: result.installedVersion,
    });
  }

  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  if (openCode?.enabled === true) {
    results.push(ensureOpenCodeTool(cwd));
  }

  const lines = results.map(formatResult).filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join('\n') : null;
}

// Probe-only check (no install) used by the wizard's verify-on-complete path so
// a reopened/already-complete wizard can re-gate when a required tool is absent.
// Reuses the ensure*Tool candidate probing via `skipInstall` so gitnexus is
// probed through its Node-22 binary, not a bare PATH lookup.
export interface OnboardingToolchainProbe {
  provider: string | null;
  graphMissing: boolean;
  openCodeEnabled: boolean;
  openCodeMissing: boolean;
}

function opencodeUsable(): boolean {
  const managedBin = managedNpmBin('opencode', 'opencode');
  const candidates = [fs.existsSync(managedBin) ? managedBin : null, which('opencode')];
  for (const binPath of candidates) {
    if (!binPath) continue;
    if (isToolUsable(probeTool('opencode', binPath).status)) return true;
  }
  return false;
}

export function probeOnboardingToolchain(cwd: string = process.cwd()): OnboardingToolchainProbe {
  const state = readEffectiveState(cwd);
  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  const openCodeEnabled = openCode?.enabled === true;
  // Respect the auto-run opt-out: never gate completion on a provider the user
  // told Traffic One not to install.
  const autoRunOff = state.codeGraphAutoRun === false || state.graphifyAutoRun === false;

  let graphMissing = false;
  if (!autoRunOff && provider === 'graphify') {
    graphMissing = !ensureGraphifyTool(cwd, { skipInstall: true }).ok;
  } else if (!autoRunOff && provider === 'gitnexus') {
    graphMissing = !ensureGitnexusTool(cwd, { skipInstall: true }).ok;
  }

  const openCodeMissing = openCodeEnabled ? !opencodeUsable() : false;

  return { provider, graphMissing, openCodeEnabled, openCodeMissing };
}
