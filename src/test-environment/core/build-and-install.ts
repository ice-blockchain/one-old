// src/test-environment/core/build-and-install.ts
// Refresh dist (gen + build) and idempotently update each enabled host so a
// host-e2e run exercises the latest plugin. Skipped entirely for pure-node-only
// runs (those reuse src/ directly and need neither dist nor an installed host).

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { HostCommandConfig, HostId, RootTestConfig } from './types';
import { REPO_ROOT_PATH } from '../config/test-config';
import {
  armDistRuntimeProof,
  distTreeFingerprint,
  restoreDistRuntimeProof,
  stageCodexMarketplace,
  type ArmedRuntimeProof,
  type CodexMarketplaceStage,
} from './current-dist';

export interface CleanupStep {
  host: HostId;
  cmd: string;
  args: string[];
  cwd: string;
}

export interface BuildResult {
  distRoot: string;
  distFingerprint: string;
  runtimeProof: ArmedRuntimeProof | null;
  built: boolean;
  installed: HostId[];
  sessionProof: HostId[];
  perCaseProof: HostId[];
  exempted: HostId[];
  marketplaces: Partial<Record<HostId, CodexMarketplaceStage>>;
  cleanupSteps: CleanupStep[];
  currentDistFailures: Array<{ host: HostId; detail: string }>;
  currentDistReady: boolean;
  notes: string[];
}

export type CommandRunner = (cmd: string, args: string[], cwd: string) => { ok: boolean; out: string };

export interface BuildAndInstallDeps {
  commandRunner?: CommandRunner;
  distRoot?: string;
  stagesRoot?: string;
}

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600_000 });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { ok: res.status === 0, out };
}

function replaceToken(value: string, token: string, replacement: string): string {
  return value.split(token).join(replacement);
}

function expandInstallArgs(
  args: string[],
  distRoot: string,
  marketplace?: CodexMarketplaceStage,
): string[] {
  return args.map((arg) => {
    let value = replaceToken(arg, '{DIST}', distRoot);
    value = replaceToken(value, '{MARKETPLACE_ROOT}', marketplace?.root ?? '');
    value = replaceToken(value, '{MARKETPLACE}', marketplace?.name ?? '');
    return value;
  });
}

function claudeSessionUsesCurrentDist(cfg: HostCommandConfig): boolean {
  const pluginDir = cfg.runArgs.indexOf('--plugin-dir');
  const settings = cfg.runArgs.indexOf('--setting-sources');
  if (pluginDir < 0 || cfg.runArgs[pluginDir + 1] !== '{DIST}') return false;
  if (settings < 0) return false;
  const sources = (cfg.runArgs[settings + 1] ?? '').split(',').map((source) => source.trim());
  return sources.includes('project') && sources.includes('local') && !sources.includes('user');
}

export function buildAndInstall(
  config: RootTestConfig,
  hostsToInstall: HostId[],
  deps: BuildAndInstallDeps = {},
): BuildResult {
  const distRoot = deps.distRoot ?? path.join(REPO_ROOT_PATH, 'dist');
  const runCommand = deps.commandRunner ?? run;
  const notes: string[] = [];
  const installed: HostId[] = [];
  const sessionProof: HostId[] = [];
  const perCaseProof: HostId[] = [];
  const exempted: HostId[] = [];
  const marketplaces: Partial<Record<HostId, CodexMarketplaceStage>> = {};
  const cleanupSteps: CleanupStep[] = [];
  const currentDistFailures: Array<{ host: HostId; detail: string }> = [];
  let distFingerprint = '';
  let runtimeProof: ArmedRuntimeProof | null = null;
  let built = false;

  if (config.build.refreshDist) {
    const r = runCommand('npm', ['run', 'plugin:build'], REPO_ROOT_PATH);
    built = r.ok;
    if (!r.ok) notes.push(`plugin:build FAILED:\n${r.out.slice(-2000)}`);
  } else {
    notes.push('skipped dist build (--no-build)');
  }

  // Never install an older dist after a failed refresh. run.ts reports the
  // build failure separately and aborts the suite.
  if (config.build.refreshDist && !built) {
    notes.push('skipped host update because dist build failed');
    return {
      distRoot,
      distFingerprint,
      runtimeProof,
      built,
      installed,
      sessionProof,
      perCaseProof,
      exempted,
      marketplaces,
      cleanupSteps,
      currentDistFailures,
      currentDistReady: false,
      notes,
    };
  }

  try {
    runtimeProof = armDistRuntimeProof(distRoot, hostsToInstall);
    notes.push(`armed unique runtime proof token ${runtimeProof.metadata.token}`);
    distFingerprint = distTreeFingerprint(distRoot);
    notes.push(`selected runtime dist fingerprint: sha256:${distFingerprint}`);
  } catch (error) {
    const detail = `cannot arm/fingerprint current runtime dist: ${String(error)}`;
    for (const host of hostsToInstall) currentDistFailures.push({ host, detail });
    return {
      distRoot,
      distFingerprint,
      runtimeProof,
      built,
      installed,
      sessionProof,
      perCaseProof,
      exempted,
      marketplaces,
      cleanupSteps,
      currentDistFailures,
      currentDistReady: false,
      notes,
    };
  }

  for (const host of hostsToInstall) {
    const cfg: HostCommandConfig = config.hosts[host];

    if (cfg.currentDistProof === 'session-plugin-dir') {
      if (host === 'claude' && claudeSessionUsesCurrentDist(cfg)) {
        sessionProof.push(host);
        notes.push('claude: user plugin settings excluded; current dist loaded directly with --plugin-dir');
      } else {
        currentDistFailures.push({
          host,
          detail: 'session-plugin-dir proof requires Claude runArgs with user settings excluded and `--plugin-dir {DIST}`',
        });
      }
      continue;
    }

    if (cfg.currentDistProof === 'case-wrapper') {
      if (host === 'opencode' || host === 'kilo') {
        perCaseProof.push(host);
        notes.push(`${host}: current dist will be installed into each isolated case environment`);
      } else {
        currentDistFailures.push({ host, detail: 'case-wrapper proof is only implemented for OpenCode and Kilo' });
      }
      continue;
    }

    if (cfg.currentDistProof === 'manual-live-pointer') {
      if (host === 'cursor') {
        exempted.push(host);
        notes.push('cursor: explicit live-pointer exemption — run `/add-plugin ' + distRoot + '` once inside the editor; strict behavior assertions remain mandatory');
      } else {
        currentDistFailures.push({ host, detail: 'manual-live-pointer exemption is reserved for Cursor' });
      }
      continue;
    }

    if (cfg.currentDistProof !== 'host-install') {
      currentDistFailures.push({ host, detail: 'no explicit current-dist proof is configured' });
      continue;
    }

    if (!config.build.updateHosts) {
      currentDistFailures.push({ host, detail: 'host update disabled by --no-install; current dist is unproven' });
      continue;
    }

    const steps = cfg.installArgs ?? [];
    if (steps.length === 0) {
      currentDistFailures.push({ host, detail: 'host-install proof has no install commands' });
      continue;
    }

    if (host !== 'codex') {
      currentDistFailures.push({ host, detail: 'content-addressed host-install proof is only implemented for Codex' });
      continue;
    }

    let marketplace: CodexMarketplaceStage;
    try {
      marketplace = stageCodexMarketplace(
        distRoot,
        deps.stagesRoot ?? path.join(config.runsRoot, '.marketplaces'),
      );
      marketplaces[host] = marketplace;
      notes.push(`codex: staged current dist as ${marketplace.name} (${marketplace.sourceFingerprint})`);
    } catch (error) {
      currentDistFailures.push({ host, detail: `could not stage current Codex marketplace: ${String(error)}` });
      continue;
    }

    let allOk = true;
    for (const step of steps) {
      const expanded = expandInstallArgs(step, distRoot, marketplace);
      if (expanded.some((arg) => /\{(?:DIST|MARKETPLACE_ROOT|MARKETPLACE)\}/.test(arg))) {
        allOk = false;
        currentDistFailures.push({ host, detail: `unresolved install token in \`${cfg.bin} ${expanded.join(' ')}\`` });
        break;
      }
      const r = runCommand(cfg.bin, expanded, REPO_ROOT_PATH);
      if (!r.ok) {
        allOk = false;
        const output = r.out.slice(-300).trim();
        currentDistFailures.push({
          host,
          detail: `\`${cfg.bin} ${expanded.join(' ')}\` failed${output ? `: ${output}` : ''}`,
        });
        break;
      }
      if (expanded[0] === 'plugin' && expanded[1] === 'marketplace' && expanded[2] === 'add') {
        cleanupSteps.push({ host, cmd: cfg.bin, args: ['plugin', 'marketplace', 'remove', marketplace.name], cwd: REPO_ROOT_PATH });
      } else if (expanded[0] === 'plugin' && expanded[1] === 'add') {
        cleanupSteps.unshift({ host, cmd: cfg.bin, args: ['plugin', 'remove', marketplace.pluginSelector], cwd: REPO_ROOT_PATH });
      }
    }
    if (allOk) installed.push(host);
  }

  if (!config.build.updateHosts && hostsToInstall.length > 0) {
    notes.push('host update disabled (--no-install); hosts requiring scripted install cannot pass the release gate');
  }

  return {
    distRoot,
    distFingerprint,
    runtimeProof,
    built,
    installed,
    sessionProof,
    perCaseProof,
    exempted,
    marketplaces,
    cleanupSteps,
    currentDistFailures,
    currentDistReady: currentDistFailures.length === 0,
    notes,
  };
}

export interface CleanupResult {
  failures: Array<{ host: HostId; detail: string }>;
  notes: string[];
}

function sameArgs(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function validateMarketplaceStageForRemoval(marketplace: CodexMarketplaceStage): string | null {
  const root = path.resolve(marketplace.root);
  const stagesRoot = path.resolve(marketplace.stagesRoot);
  if (path.dirname(root) !== stagesRoot) return `staging root is not a direct child of its recorded parent: ${root}`;
  if (path.basename(root) !== marketplace.name || !marketplace.name.startsWith('traffic-one-e2e-')) {
    return `staging root/name mismatch: ${root} (${marketplace.name})`;
  }
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return `staging root is not a real directory: ${root}`;
  } catch (error) {
    return `staging root is unavailable: ${root}: ${String(error)}`;
  }
  const expectedPluginRoot = path.join(root, 'plugins', 'traffic-one');
  if (path.resolve(marketplace.stagedPluginRoot) !== expectedPluginRoot) {
    return `staged plugin root escaped its marketplace: ${marketplace.stagedPluginRoot}`;
  }
  const markerPath = path.join(root, '.traffic-one-e2e.json');
  let marker: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    marker = parsed as Record<string, unknown>;
  } catch (error) {
    return `invalid staging marker ${markerPath}: ${String(error)}`;
  }
  const expected: Record<string, unknown> = {
    version: 1,
    root,
    stagesRoot,
    name: marketplace.name,
    pluginSelector: marketplace.pluginSelector,
    sourceFingerprint: marketplace.sourceFingerprint,
    cacheVersion: marketplace.cacheVersion,
    stagedPluginRoot: marketplace.stagedPluginRoot,
  };
  const markerKeys = Object.keys(marker).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (!sameArgs(markerKeys, expectedKeys)) {
    return `staging marker keys mismatch: expected [${expectedKeys.join(', ')}], got [${markerKeys.join(', ')}]`;
  }
  for (const [key, value] of Object.entries(expected)) {
    if (marker[key] !== value) return `staging marker mismatch for ${key}: expected ${String(value)}, got ${String(marker[key])}`;
  }
  return null;
}

export function cleanupBuildInstall(
  result: BuildResult,
  commandRunner: CommandRunner = run,
): CleanupResult {
  const failures: Array<{ host: HostId; detail: string }> = [];
  const notes: string[] = [];
  for (const step of result.cleanupSteps) {
    // Cleanup is intentionally restricted to the exact unique ids returned by
    // stageCodexMarketplace; substring-shaped lookalikes are never sufficient.
    const marketplace = result.marketplaces[step.host];
    const exactPluginRemove = marketplace
      ? sameArgs(step.args, ['plugin', 'remove', marketplace.pluginSelector])
      : false;
    const exactMarketplaceRemove = marketplace
      ? sameArgs(step.args, ['plugin', 'marketplace', 'remove', marketplace.name])
      : false;
    if (step.cmd !== 'codex' || !marketplace || (!exactPluginRemove && !exactMarketplaceRemove)) {
      failures.push({ host: step.host, detail: `refused unsafe cleanup command: ${step.cmd} ${step.args.join(' ')}` });
      continue;
    }
    const cleaned = commandRunner(step.cmd, step.args, step.cwd);
    if (!cleaned.ok) {
      failures.push({
        host: step.host,
        detail: `cleanup \`${step.cmd} ${step.args.join(' ')}\` failed: ${cleaned.out.slice(-300).trim()}`,
      });
    } else {
      notes.push(`${step.host}: cleaned ${step.args.join(' ')}`);
    }
  }
  const failedHosts = new Set(failures.map((failure) => failure.host));
  for (const [host, marketplace] of Object.entries(result.marketplaces) as Array<[HostId, CodexMarketplaceStage]>) {
    if (failedHosts.has(host)) continue;
    const unsafe = validateMarketplaceStageForRemoval(marketplace);
    if (unsafe) {
      failures.push({ host, detail: `refused unsafe staging cleanup: ${unsafe}` });
      continue;
    }
    try {
      fs.rmSync(marketplace.root, { recursive: true, force: true });
      notes.push(`${host}: removed staging marketplace ${marketplace.root}`);
    } catch (error) {
      failures.push({ host, detail: `could not remove staging marketplace ${marketplace.root}: ${String(error)}` });
    }
  }
  if (result.runtimeProof) {
    const proofFailures = restoreDistRuntimeProof(result.runtimeProof);
    const host = result.runtimeProof.hosts[0] ?? 'claude';
    for (const detail of proofFailures) failures.push({ host, detail });
    if (proofFailures.length === 0) notes.push('restored selected runtime dist after E2E proof');
  }
  return { failures, notes };
}
