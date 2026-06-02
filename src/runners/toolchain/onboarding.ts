// src/runners/toolchain/onboarding.ts
// Hook-owned toolchain preflight for onboarding/local-preference writes. The
// user's OpenCode/code-graph choices are the consent record; this module checks
// installed versions and installs/upgrades user-local managed tools when needed.

import { spawnSync } from 'child_process';
import * as fs from 'fs';

import { exec } from '../../shared/exec';
import { mergeProjectPrefs, readEffectiveState } from '../../shared/state';
import { nowIso } from '../../shared/text';
import { ensureGitnexusTool } from '../gitnexus';
import { ensureGraphifyTool, type GraphifyToolResult } from '../graphify';
import {
  getToolSpec,
  isToolUsable,
  managedNpmBin,
  managedNpmPrefix,
  mergeToolchainStamp,
  probeTool,
  probeToolVersion,
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

function opencodePackageSpec(): string {
  const spec = getToolSpec('opencode');
  const pkg = typeof spec?.npmPackage === 'string' && spec.npmPackage ? spec.npmPackage : 'opencode-ai';
  return typeof spec?.recommended === 'string' && spec.recommended ? `${pkg}@${spec.recommended}` : pkg;
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
  }

  const npm = which('npm');
  if (!npm) {
    return { tool: 'opencode', ok: false, action: 'install-skipped', error: '`npm` is not on PATH, so the hook cannot install OpenCode automatically', binPath: null };
  }

  const result = spawnSync(npm, ['install', '-g', '--prefix', managedNpmPrefix('opencode'), opencodePackageSpec()], {
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

  const installedVersion = probeToolVersion('opencode', { binPath: managedBin });
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
