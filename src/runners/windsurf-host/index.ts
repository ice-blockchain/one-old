// src/runners/windsurf-host/index.ts
// Install/doctor/uninstall Traffic One integration for Windsurf. Both Cascade
// and Devin Local backends are supported; the Cascade runtime ignores Devin's
// identifiable empty-trajectory compatibility duplicates.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  WINDSURF_HOOK_EVENTS,
  WINDSURF_HOST_CONFIG_DIR_REL,
  WINDSURF_HOST_GLOBAL_RULES_REL,
  WINDSURF_HOST_HOOKS_FILE,
  WINDSURF_HOST_INSIDERS_CONFIG_DIR_REL,
  WINDSURF_HOST_NEXT_CONFIG_DIR_REL,
  DEVIN_HOST_CONFIG_REL,
  DEVIN_NATIVE_HOOKS,
  type WindsurfHookEvent,
} from '../../config/windsurf-host';
import { globalTrafficOneDir } from '../../shared/state/traffic-one-paths';
import { devinUserHookCommand, windsurfUserHookCommand } from '../../shared/windsurf-hook-command';

export interface RunnerOutput { code: number; stdout: string; stderr?: string; }

type Rec = Record<string, unknown>;

const OWNER_START = '<!-- traffic-one:windsurf:start -->';
const OWNER_END = '<!-- traffic-one:windsurf:end -->';
const GLOBAL_RULE_LIMIT = 6000;

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function argValue(args: readonly string[], name: string): string | null {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && typeof args[index + 1] === 'string') return args[index + 1] as string;
  return null;
}

function channelRel(args: readonly string[]): string {
  const channel = (argValue(args, '--channel') || 'stable').trim().toLowerCase();
  if (channel === 'next') return WINDSURF_HOST_NEXT_CONFIG_DIR_REL;
  if (channel === 'insiders') return WINDSURF_HOST_INSIDERS_CONFIG_DIR_REL;
  return WINDSURF_HOST_CONFIG_DIR_REL;
}

export function windsurfConfigDir(env: NodeJS.ProcessEnv = process.env, args: readonly string[] = []): string {
  const explicit = argValue(args, '--config-dir');
  if (explicit) return path.resolve(explicit);
  return path.join(homeDir(env), channelRel(args));
}

export function windsurfHooksPath(env: NodeJS.ProcessEnv = process.env, args: readonly string[] = []): string {
  return path.join(windsurfConfigDir(env, args), WINDSURF_HOST_HOOKS_FILE);
}

export function windsurfGlobalRulesPath(env: NodeJS.ProcessEnv = process.env, args: readonly string[] = []): string {
  return path.join(windsurfConfigDir(env, args), WINDSURF_HOST_GLOBAL_RULES_REL);
}

export function devinConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(homeDir(env), DEVIN_HOST_CONFIG_REL);
}

function runtimePluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRAFFIC_ONE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..', '..');
}

function readJsonObject(file: string): Rec {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed as Rec;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function windsurfPluginRootStamp(env: NodeJS.ProcessEnv): string {
  return path.join(globalTrafficOneDir(env), 'windsurf-plugin-root');
}

function writeWindsurfPluginRootStamp(pluginRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = windsurfPluginRootStamp(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${pluginRoot.trim()}\n`, 'utf8');
  } catch {
    // best-effort; workspace shims fall back to TRAFFIC_ONE_PLUGIN_ROOT in hook commands
  }
}

function readWindsurfPluginRootStamp(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const value = fs.readFileSync(windsurfPluginRootStamp(env), 'utf8').trim();
    return value && path.isAbsolute(value) ? path.normalize(value) : null;
  } catch {
    return null;
  }
}

function ownedPluginRoots(pluginRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const stamped = readWindsurfPluginRootStamp(env);
  return [...new Set([pluginRoot, ...(stamped ? [stamped] : [])])];
}

function ownedHookEntry(entry: unknown, event: WindsurfHookEvent, pluginRoots: readonly string[]): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const command = (entry as Rec).command;
  return typeof command === 'string'
    && pluginRoots.some((pluginRoot) => command === windsurfUserHookCommand(pluginRoot, event));
}

function hookCommand(pluginRoot: string, event: WindsurfHookEvent): string {
  return windsurfUserHookCommand(pluginRoot, event);
}

function ensureHooks(file: string, pluginRoot: string, pluginRoots: readonly string[]): boolean {
  const config = readJsonObject(file);
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks as Rec
    : {};
  let changed = config.hooks !== hooks;
  config.hooks = hooks;
  for (const event of WINDSURF_HOOK_EVENTS) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    const next = [
      ...current.filter((entry) => !ownedHookEntry(entry, event, pluginRoots)),
      { command: hookCommand(pluginRoot, event), show_output: true },
    ];
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      hooks[event] = next;
      changed = true;
    }
  }
  if (changed) writeJson(file, config);
  return changed;
}

function removeHooks(file: string, pluginRoots: readonly string[]): boolean {
  if (!fs.existsSync(file)) return false;
  const config = readJsonObject(file);
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks as Rec
    : {};
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    const next = current.filter((entry) => (
      !WINDSURF_HOOK_EVENTS.includes(event as WindsurfHookEvent)
      || !ownedHookEntry(entry, event as WindsurfHookEvent, pluginRoots)
    ));
    if (next.length !== current.length) {
      if (next.length) hooks[event] = next;
      else delete hooks[event];
      changed = true;
    }
  }
  if (changed) writeJson(file, config);
  return changed;
}

function ownedDevinCommand(entry: unknown, pluginRoots: readonly string[]): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const command = (entry as Rec).command;
  return typeof command === 'string' && pluginRoots.some((pluginRoot) => (
    DEVIN_NATIVE_HOOKS.some((spec) => command === devinUserHookCommand(pluginRoot, spec.subcommand))
  ));
}

function asHookEntries(group: unknown): unknown[] {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return [];
  const entries = (group as Rec).hooks;
  return Array.isArray(entries) ? entries : [];
}

function withoutOwnedDevinHooks(groups: unknown[], pluginRoots: readonly string[]): unknown[] {
  const next: unknown[] = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      next.push(group);
      continue;
    }
    const rec = { ...(group as Rec) };
    const entries = Array.isArray(rec.hooks) ? rec.hooks as unknown[] : [];
    const kept = entries.filter((entry) => !ownedDevinCommand(entry, pluginRoots));
    if (kept.length > 0) {
      rec.hooks = kept;
      next.push(rec);
    } else if (entries.length === 0) {
      next.push(group);
    }
  }
  return next;
}

function ensureDevinHooks(file: string, pluginRoot: string, pluginRoots: readonly string[]): boolean {
  const config = readJsonObject(file);
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks as Rec
    : {};
  const nextHooks: Rec = { ...hooks };
  for (const event of new Set(DEVIN_NATIVE_HOOKS.map((spec) => spec.event))) {
    nextHooks[event] = withoutOwnedDevinHooks(
      Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [],
      pluginRoots,
    );
  }
  for (const spec of DEVIN_NATIVE_HOOKS) {
    const groups = nextHooks[spec.event] as unknown[];
    groups.push({
      matcher: spec.matcher,
      hooks: [{
        type: 'command',
        command: devinUserHookCommand(pluginRoot, spec.subcommand),
        timeout: 30,
      }],
    });
  }
  const changed = config.hooks !== hooks || JSON.stringify(hooks) !== JSON.stringify(nextHooks);
  config.hooks = nextHooks;
  if (changed) writeJson(file, config);
  return changed;
}

function removeDevinHooks(file: string, pluginRoots: readonly string[]): boolean {
  if (!fs.existsSync(file)) return false;
  const config = readJsonObject(file);
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks as Rec
    : {};
  const nextHooks: Rec = { ...hooks };
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    const next = withoutOwnedDevinHooks(current, pluginRoots);
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      changed = true;
      if (next.length > 0) nextHooks[event] = next;
      else delete nextHooks[event];
    }
  }
  if (changed) {
    config.hooks = nextHooks;
    writeJson(file, config);
  }
  return changed;
}

function globalRulesBlock(pluginRoot: string): string {
  return [
    OWNER_START,
    '# Traffic One',
    '',
    `Plugin root: ${pluginRoot}`,
    '',
    '- Traffic One project context is loaded from root `AGENTS.md`, `.devin/rules/*.md`, and `.traffic-one/skills/*/SKILL.md`.',
    '- Hooks enforce Traffic One authentication, setup, workspace, and write gates. If a hook blocks, follow its message before continuing.',
    '- The Traffic One plugin source repository and installed plugin root are never end-user projects.',
    OWNER_END,
    '',
  ].join('\n');
}

function replaceOwnedBlock(existing: string, block: string): string {
  const start = existing.indexOf(OWNER_START);
  const end = existing.indexOf(OWNER_END);
  if (start >= 0 && end >= start) {
    return `${existing.slice(0, start).trimEnd()}\n\n${block}${existing.slice(end + OWNER_END.length).replace(/^\s+/, '')}`;
  }
  return existing.trim() ? `${existing.trimEnd()}\n\n${block}` : block;
}

function ensureGlobalRules(file: string, pluginRoot: string): { changed: boolean; skipped: boolean } {
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = ''; }
  const next = replaceOwnedBlock(existing, globalRulesBlock(pluginRoot));
  if (next.length > GLOBAL_RULE_LIMIT) return { changed: false, skipped: true };
  if (next === existing) return { changed: false, skipped: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return { changed: true, skipped: false };
}

function removeGlobalRules(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const existing = fs.readFileSync(file, 'utf8');
  const start = existing.indexOf(OWNER_START);
  const end = existing.indexOf(OWNER_END);
  if (start < 0 || end < start) return false;
  const next = `${existing.slice(0, start).trimEnd()}\n${existing.slice(end + OWNER_END.length).replace(/^\s+/, '')}`.trim();
  fs.writeFileSync(file, next ? `${next}\n` : '', 'utf8');
  return true;
}

export function installWrapper(env: NodeJS.ProcessEnv = process.env, args: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!args.includes('--yes')) {
    return { code: 2, stdout: 'Traffic One Windsurf install mutates user-level Windsurf config. Re-run with --yes to confirm.\n' };
  }
  const pluginRoot = runtimePluginRoot(env);
  const pluginRoots = ownedPluginRoots(pluginRoot, env);
  const hooksFile = windsurfHooksPath(env, args);
  const rulesFile = windsurfGlobalRulesPath(env, args);
  const devinFile = devinConfigPath(env);
  const hooksChanged = ensureHooks(hooksFile, pluginRoot, pluginRoots);
  const devinChanged = ensureDevinHooks(devinFile, pluginRoot, pluginRoots);
  const globalRules = ensureGlobalRules(rulesFile, pluginRoot);
  writeWindsurfPluginRootStamp(pluginRoot, env);
  return {
    code: 0,
    stdout: [
      `ok: Cascade hooks ${hooksChanged ? 'updated' : 'already current'} at ${hooksFile}`,
      `ok: Devin Local hooks ${devinChanged ? 'updated' : 'already current'} at ${devinFile}`,
      globalRules.skipped
        ? `warn: global_rules.md is over ${GLOBAL_RULE_LIMIT} characters with the Traffic One block; skipped ${rulesFile}`
        : `ok: Windsurf global rule ${globalRules.changed ? 'updated' : 'already current'} at ${rulesFile}`,
      'Restart Windsurf / Devin Desktop for hook and rule changes to load.',
    ].join('\n') + '\n',
  };
}

export function uninstallWrapper(env: NodeJS.ProcessEnv = process.env, args: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!args.includes('--yes')) {
    return { code: 2, stdout: 'Traffic One Windsurf uninstall mutates user-level Windsurf config. Re-run with --yes to confirm.\n' };
  }
  const hooksFile = windsurfHooksPath(env, args);
  const rulesFile = windsurfGlobalRulesPath(env, args);
  const devinFile = devinConfigPath(env);
  const pluginRoots = ownedPluginRoots(runtimePluginRoot(env), env);
  const hooksChanged = removeHooks(hooksFile, pluginRoots);
  const devinChanged = removeDevinHooks(devinFile, pluginRoots);
  const rulesChanged = removeGlobalRules(rulesFile);
  return {
    code: 0,
    stdout: [
      `ok: hooks ${hooksChanged ? 'removed' : 'not present'} at ${hooksFile}`,
      `ok: Devin Local hooks ${devinChanged ? 'removed' : 'not present'} at ${devinFile}`,
      `ok: global rule ${rulesChanged ? 'removed' : 'not present'} at ${rulesFile}`,
    ].join('\n') + '\n',
  };
}

export function doctorWrapper(env: NodeJS.ProcessEnv = process.env, args: readonly string[] = process.argv.slice(2)): RunnerOutput {
  const hooksFile = windsurfHooksPath(env, args);
  const rulesFile = windsurfGlobalRulesPath(env, args);
  const devinFile = devinConfigPath(env);
  const pluginRoots = ownedPluginRoots(runtimePluginRoot(env), env);
  const issues: string[] = [];
  try {
    const hooksConfig = readJsonObject(hooksFile);
    const hooks = hooksConfig.hooks && typeof hooksConfig.hooks === 'object' && !Array.isArray(hooksConfig.hooks) ? hooksConfig.hooks as Rec : {};
    for (const event of WINDSURF_HOOK_EVENTS) {
      const entries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
      if (!entries.some((entry) => ownedHookEntry(entry, event, pluginRoots))) issues.push(`missing Cascade hook ${event}`);
    }
  } catch (error) {
    issues.push(`Cascade hooks config unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const devinConfig = readJsonObject(devinFile);
    const hooks = devinConfig.hooks && typeof devinConfig.hooks === 'object' && !Array.isArray(devinConfig.hooks) ? devinConfig.hooks as Rec : {};
    for (const spec of DEVIN_NATIVE_HOOKS) {
      const groups = Array.isArray(hooks[spec.event]) ? hooks[spec.event] as unknown[] : [];
      const present = groups.some((group) => {
        const entries = asHookEntries(group);
        return entries.some((entry) => {
          const command = entry && typeof entry === 'object' ? (entry as Rec).command : undefined;
          return typeof command === 'string'
            && pluginRoots.some((pluginRoot) => command === devinUserHookCommand(pluginRoot, spec.subcommand));
        });
      });
      if (!present) issues.push(`missing Devin Local hook ${spec.event}/${spec.subcommand}`);
    }
  } catch (error) {
    issues.push(`Devin Local config unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let global = 'missing';
  try {
    global = fs.readFileSync(rulesFile, 'utf8').includes(OWNER_START) ? 'ok' : 'missing';
  } catch {
    global = 'missing';
  }
  if (issues.length > 0) {
    return { code: 1, stdout: `not ok: ${issues.join('; ')}\nglobalRule: ${global}\n` };
  }
  return { code: 0, stdout: `ok: Windsurf Traffic One integration active\ncascadeHooks: ${hooksFile}\ndevinHooks: ${devinFile}\nglobalRule: ${global}\n` };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const command = argv[0] || 'doctor';
  const result = command === 'install'
    ? installWrapper(process.env, argv)
    : command === 'uninstall'
      ? uninstallWrapper(process.env, argv)
      : doctorWrapper(process.env, argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

if (require.main === module) {
  process.exitCode = main();
}
