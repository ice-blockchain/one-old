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

  // Prefer PATH npm (the working path); a stale GUI PATH with no npm must not
  // doom the install, so fall back to the npm beside a runtime-resolved Node
  // (nvm/Homebrew absolute paths). Only error when BOTH are unavailable.
  let npm = which('npm');
  if (!npm) {
    const { minMajor } = toolRuntime('opencode');
    const node = resolveNode(minMajor);
    npm = node ? npmNextToNode(node.path) : null;
  }
  if (!npm) {
    // Last resort: the npm bundled with a Traffic One-managed standalone Node
    // (isolated dir, never on PATH). Shared with gitnexus — fetched once.
    const managed = ensureManagedRuntime('node', { minMajor: toolRuntime('opencode').minMajor });
    if (managed.ok && managed.binDir) {
      const cand = path.join(managed.binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
      if (fs.existsSync(cand)) npm = cand;
    }
  }
  if (!npm) {
    return { tool: 'opencode', ok: false, action: 'install-skipped', error: '`npm` is not on PATH (and no runtime-resolved or managed Node/npm was found), so the hook cannot install OpenCode automatically', binPath: null };
  }

  // spawnTool for the Windows npm.cmd shim; managed user/global config so a user
  // `.npmrc prefix=` can't redirect the install out of the managed dir.
  const ocPrefix = managedNpmPrefix('opencode');
  const ocNpmrc = path.join(ocPrefix, 'managed.npmrc');
  const result = spawnTool(npm, ['install', '-g', '--prefix', ocPrefix, '--userconfig', ocNpmrc, '--globalconfig', ocNpmrc, opencodePackageSpec()], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180 * 1000,
  });
  if (result.status !== 0 || !fs.existsSync(managedBin)) {
    return {
      tool: 'opencode',
      ok: false,
      action: 'install-skipped',
      error: `managed npm install of OpenCode failed: ${(result.stderr || '').trim() || 'non-zero exit'}`,
      binPath: null,
    };
  }

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
