// src/runners/traffic-one-uninstall/index.ts
// Removes every machine-global trace of Traffic One, in the one order that is
// safe, then removes the plugin bundle itself from each host CLI that has it.
//
// The ordering is not cosmetic:
//   1. The Kilo wrapper FIRST. It is fail-closed and its plugin-bundle path is
//      baked in at install time, so a wrapper left behind after the bundle is
//      gone denies every tool call in every Traffic One project on Kilo — and
//      the script that would repair it has just been deleted. OpenCode's wrapper
//      fails open, so it is merely residual, but it is removed here as well.
//   2. Windsurf/Cascade hooks + global rule, and the Codex machine-global MCP
//      block. Both survive bundle removal and keep pointing at a dead path.
//   3. ~/.traffic-one — auth record, per-user preferences, runner shims, managed
//      toolchains.
//   4. The plugin bundle, via each host CLI, LAST. Every module this runner
//      needs is already loaded by then, so deleting the bundle mid-run is safe.
//
// Onboarded projects are deliberately untouched: their `.traffic-one/` folders
// and generated instructions are project content, not plugin state.
//
// Consent-gated like every other user-level mutation here: no `--yes`, no writes.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runOneMcpHostCommand } from '../one-mcp-host';
import { kiloGlobalPluginPath, uninstallWrapper as uninstallKiloWrapper } from '../kilo-host';
import { opencodeGlobalPluginPath, uninstallWrapper as uninstallOpenCodeWrapper } from '../opencode-host';
import {
  uninstallWrapper as uninstallWindsurfWrapper,
  windsurfGlobalRulesPath,
  windsurfHooksPath,
} from '../windsurf-host';
import { codexConfigPath } from '../../shared/codex-mcp';
import { globalTrafficOneDir } from '../../shared/state/traffic-one-paths';

export interface RunnerOutput { code: number; stdout: string; stderr?: string }

export interface Step { label: string; ok: boolean; detail: string }

const PLUGIN_NAME = 'traffic-one';
const WINDSURF_CHANNELS = ['stable', 'next', 'insiders'] as const;

export interface PluginInstall {
  host: 'claude' | 'codex' | 'cursor';
  cli: string | null;
  marketplace: string;
  dir: string;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function firstLine(text: string | undefined): string {
  return String(text || '').trim().split('\n').filter(Boolean).join('; ');
}

// Every (host, marketplace) pair whose cache actually holds a traffic-one plugin,
// plus Cursor's unversioned local install. Codex requires PLUGIN@MARKETPLACE, so
// the marketplace is discovered rather than assumed.
export function discoverPluginInstalls(env: NodeJS.ProcessEnv = process.env): PluginInstall[] {
  const home = homeDir(env);
  const found: PluginInstall[] = [];
  const hosts = [
    { host: 'claude', dir: '.claude', cli: 'claude' },
    { host: 'codex', dir: '.codex', cli: 'codex' },
    { host: 'cursor', dir: '.cursor', cli: null },
  ] as const;
  for (const { host, dir, cli } of hosts) {
    const cache = path.join(home, dir, 'plugins', 'cache');
    let marketplaces: string[] = [];
    try { marketplaces = fs.readdirSync(cache); } catch { marketplaces = []; }
    for (const marketplace of marketplaces) {
      const pluginDir = path.join(cache, marketplace, PLUGIN_NAME);
      try {
        if (!fs.statSync(pluginDir).isDirectory()) continue;
      } catch { continue; }
      found.push({ host, cli, marketplace, dir: pluginDir });
    }
    const local = path.join(home, dir, 'plugins', 'local', PLUGIN_NAME);
    try {
      if (fs.statSync(local).isDirectory()) found.push({ host, cli: null, marketplace: 'local', dir: local });
    } catch { /* no local install */ }
  }
  return found;
}

function pluginCliArgs(install: PluginInstall): string[] {
  const spec = `${PLUGIN_NAME}@${install.marketplace}`;
  return install.host === 'codex' ? ['plugin', 'remove', spec] : ['plugin', 'uninstall', spec];
}

export function describePluginInstall(install: PluginInstall): string {
  if (!install.cli) {
    return `${install.host} (${install.marketplace}) — no uninstall CLI; remove it from the ${install.host} plugin UI`;
  }
  return `${install.cli} ${pluginCliArgs(install).join(' ')}`;
}

function removePluginViaCli(install: PluginInstall, env: NodeJS.ProcessEnv): Step {
  const label = `plugin bundle (${install.host}/${install.marketplace})`;
  if (!install.cli) {
    return { label, ok: true, detail: `manual: remove Traffic One from the ${install.host} plugin UI (${install.dir})` };
  }
  const result = spawnSync(install.cli, pluginCliArgs(install), { encoding: 'utf8', timeout: 120_000, env });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { label, ok: true, detail: `skipped: \`${install.cli}\` is not on PATH — run \`${describePluginInstall(install)}\` yourself` };
    }
    return { label, ok: false, detail: `failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { label, ok: false, detail: `failed (exit ${result.status}): ${firstLine(result.stderr) || firstLine(result.stdout)}` };
  }
  return { label, ok: true, detail: firstLine(result.stdout) || 'removed' };
}

// Last guard before an `rm -rf` on a path derived from the environment: it must
// look like ours and must never be the home dir or a filesystem root. Nothing in
// globalTrafficOneDir can produce such a path today — this exists so a future
// change to that resolution cannot silently widen the delete.
export function isRemovableStateDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return false;
  if (resolved === path.resolve(homeDir(env) || os.homedir())) return false;
  return path.basename(resolved) === '.traffic-one' || path.basename(resolved) === 'traffic-one';
}

function removeStateDir(env: NodeJS.ProcessEnv, dryRun: boolean): Step {
  const dir = globalTrafficOneDir(env);
  const label = `state dir ${dir}`;
  if (!isRemovableStateDir(dir, env)) {
    return { label, ok: false, detail: 'refused: resolved path is not a Traffic One state dir' };
  }
  if (!fs.existsSync(dir)) return { label, ok: true, detail: 'not present' };
  if (dryRun) return { label, ok: true, detail: 'would remove (auth record, preferences, shims, managed toolchains)' };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { label, ok: true, detail: 'removed' };
  } catch (error) {
    return { label, ok: false, detail: `failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function presenceStep(label: string, file: string, action: string): Step {
  return fs.existsSync(file)
    ? { label, ok: true, detail: `${action} (${file})` }
    : { label, ok: true, detail: `not present (${file})` };
}

function hostStep(label: string, result: RunnerOutput): Step {
  return {
    label,
    ok: result.code === 0,
    detail: (result.code === 0 ? firstLine(result.stdout) : firstLine(result.stderr) || firstLine(result.stdout))
      || (result.code === 0 ? 'done' : `exit ${result.code}`),
  };
}

export interface UninstallOptions {
  dryRun: boolean;
  keepPlugin: boolean;
}

export function runUninstall(options: UninstallOptions, env: NodeJS.ProcessEnv = process.env): { code: number; steps: Step[] } {
  const steps: Step[] = [];
  const installs = discoverPluginInstalls(env);

  if (options.dryRun) {
    // A preview is only useful if it reports what is actually on this machine, so
    // each integration is probed rather than described from the install recipe.
    steps.push(presenceStep(
      'Kilo wrapper',
      kiloGlobalPluginPath(env),
      'would remove it FIRST — it is fail-closed, so a wrapper outliving the bundle denies every tool call',
    ));
    steps.push(presenceStep(
      'OpenCode wrapper',
      opencodeGlobalPluginPath(env),
      'would remove it and its entry in the OpenCode global config',
    ));
    for (const channel of WINDSURF_CHANNELS) {
      steps.push(presenceStep(
        `Windsurf integration (${channel})`,
        windsurfHooksPath(env, ['--channel', channel]),
        `would remove the Cascade/Devin hooks and the global rule (${windsurfGlobalRulesPath(env, ['--channel', channel])})`,
      ));
    }
    steps.push(presenceStep(
      'Codex MCP block',
      codexConfigPath(env),
      'would remove the Traffic One marked block if it is still byte-exact',
    ));
    steps.push(removeStateDir(env, true));
    for (const install of installs) {
      steps.push({
        label: `plugin bundle (${install.host}/${install.marketplace})`,
        ok: true,
        detail: options.keepPlugin ? 'kept (--keep-plugin)' : `would run: ${describePluginInstall(install)}`,
      });
    }
    if (installs.length === 0) steps.push({ label: 'plugin bundle', ok: true, detail: 'no installed bundle found' });
    return { code: 0, steps };
  }

  // 1-2. User-level host integrations, while the bundle they point at still exists.
  steps.push(hostStep('Kilo wrapper', uninstallKiloWrapper(env, ['uninstall'])));
  steps.push(hostStep('OpenCode wrapper', uninstallOpenCodeWrapper(env, ['uninstall'])));
  for (const channel of WINDSURF_CHANNELS) {
    steps.push(hostStep(`Windsurf integration (${channel})`, uninstallWindsurfWrapper(env, ['uninstall', '--yes', '--channel', channel])));
  }
  steps.push(hostStep('Codex MCP block', runOneMcpHostCommand(['uninstall', '--yes'], env)));

  // 3. Machine-global state.
  steps.push(removeStateDir(env, false));

  // 4. The bundle itself, last.
  if (options.keepPlugin) {
    steps.push({ label: 'plugin bundle', ok: true, detail: 'kept (--keep-plugin)' });
  } else if (installs.length === 0) {
    steps.push({ label: 'plugin bundle', ok: true, detail: 'no installed bundle found' });
  } else {
    for (const install of installs) steps.push(removePluginViaCli(install, env));
  }

  return { code: steps.every((step) => step.ok) ? 0 : 1, steps };
}

function usage(): string {
  return [
    'Usage: traffic-one-uninstall.cjs [--yes] [--dry-run] [--keep-plugin]',
    '',
    'Removes every machine-global Traffic One artifact: the user-level host',
    'integrations (Kilo, OpenCode, Windsurf, the Codex MCP block), the state dir',
    '~/.traffic-one (saved API key, per-project preferences, runner shims, managed',
    'toolchains), and the plugin bundle from each host CLI that has it.',
    '',
    'Onboarded projects are never touched.',
    '',
    '  --yes           apply (required; nothing is written without it)',
    '  --dry-run       print the plan and exit',
    '  --keep-plugin   clean everything but leave the installed bundle in place',
  ].join('\n');
}

function render(steps: Step[], dryRun: boolean): string {
  const lines = [`traffic-one uninstall ${dryRun ? 'dry-run' : 'apply'}:`];
  for (const step of steps) lines.push(`- [${step.ok ? 'ok' : 'FAILED'}] ${step.label}: ${step.detail}`);
  return `${lines.join('\n')}\n`;
}

export function run(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): RunnerOutput {
  if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: `${usage()}\n` };
  const keepPlugin = argv.includes('--keep-plugin');
  const apply = argv.includes('--yes');
  const dryRun = argv.includes('--dry-run') || !apply;

  const result = runUninstall({ dryRun, keepPlugin }, env);
  const stdout = render(result.steps, dryRun);

  if (dryRun && !argv.includes('--dry-run')) {
    return {
      code: 2,
      stdout,
      stderr: 'Traffic One uninstall removes user-level host config and ~/.traffic-one. Re-run with --yes to apply.\n',
    };
  }
  if (!dryRun) {
    return {
      code: result.code,
      stdout: `${stdout}\nRestart the host now — this session's hooks still point at the removed plugin and will error until it does.\n`,
    };
  }
  return { code: result.code, stdout };
}

export function main(): number {
  const result = run();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

if (require.main === module) process.exitCode = main();
