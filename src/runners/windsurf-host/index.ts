// src/runners/windsurf-host/index.ts
// Install/doctor/uninstall Traffic One integration for Windsurf / Devin Desktop
// Cascade by merging owned hooks, MCP config, and a compact global-rule block.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DEFAULT_ENDPOINT } from '../../config/auth';
import {
  WINDSURF_HOOK_EVENTS,
  WINDSURF_HOST_CONFIG_DIR_REL,
  WINDSURF_HOST_GLOBAL_RULES_REL,
  WINDSURF_HOST_HOOKS_FILE,
  WINDSURF_HOST_INSIDERS_CONFIG_DIR_REL,
  WINDSURF_HOST_MCP_FILE,
  WINDSURF_HOST_NEXT_CONFIG_DIR_REL,
  type WindsurfHookEvent,
} from '../../config/windsurf-host';
import { globalTrafficOneDir } from '../../shared/state/traffic-one-paths';
import { windsurfUserHookCommand } from '../../shared/windsurf-hook-command';

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

export function windsurfMcpPath(env: NodeJS.ProcessEnv = process.env, args: readonly string[] = []): string {
  return path.join(windsurfConfigDir(env, args), WINDSURF_HOST_MCP_FILE);
}

export function windsurfGlobalRulesPath(env: NodeJS.ProcessEnv = process.env, args: readonly string[] = []): string {
  return path.join(windsurfConfigDir(env, args), WINDSURF_HOST_GLOBAL_RULES_REL);
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

function hookCommand(pluginRoot: string, event: WindsurfHookEvent): string {
  return windsurfUserHookCommand(pluginRoot, event);
}

function ownedHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const command = (entry as Rec).command;
  return typeof command === 'string' && command.includes('windsurf-hook-runtime.cjs');
}

function ensureHooks(file: string, pluginRoot: string): boolean {
  const config = readJsonObject(file);
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks as Rec
    : {};
  let changed = config.hooks !== hooks;
  config.hooks = hooks;

  for (const event of WINDSURF_HOOK_EVENTS) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    const next = [
      ...current.filter((entry) => !ownedHookEntry(entry)),
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

function removeHooks(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const config = readJsonObject(file);
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks as Rec
    : {};
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    const next = current.filter((entry) => !ownedHookEntry(entry));
    if (next.length !== current.length) {
      if (next.length) hooks[event] = next;
      else delete hooks[event];
      changed = true;
    }
  }
  if (changed) writeJson(file, config);
  return changed;
}

function ownedMcpEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const rec = entry as Rec;
  return rec.serverUrl === DEFAULT_ENDPOINT || rec.url === DEFAULT_ENDPOINT;
}

function ensureMcp(file: string): boolean {
  const config = readJsonObject(file);
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? config.mcpServers as Rec
    : {};
  const next = { serverUrl: DEFAULT_ENDPOINT };
  const changed = config.mcpServers !== servers || JSON.stringify(servers['mcp-auth']) !== JSON.stringify(next);
  config.mcpServers = servers;
  servers['mcp-auth'] = next;
  if (changed) writeJson(file, config);
  return changed;
}

function removeMcp(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const config = readJsonObject(file);
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? config.mcpServers as Rec
    : {};
  if (!ownedMcpEntry(servers['mcp-auth'])) return false;
  delete servers['mcp-auth'];
  config.mcpServers = servers;
  writeJson(file, config);
  return true;
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
    '- Do not call the exposed `mcp-auth` MCP tools for routine Traffic One auth checks; hooks run the auth client silently.',
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
  const hooksFile = windsurfHooksPath(env, args);
  const mcpFile = windsurfMcpPath(env, args);
  const rulesFile = windsurfGlobalRulesPath(env, args);
  const hooksChanged = ensureHooks(hooksFile, pluginRoot);
  const mcpChanged = ensureMcp(mcpFile);
  const globalRules = ensureGlobalRules(rulesFile, pluginRoot);
  writeWindsurfPluginRootStamp(pluginRoot, env);
  return {
    code: 0,
    stdout: [
      `ok: Windsurf hooks ${hooksChanged ? 'updated' : 'already current'} at ${hooksFile}`,
      `ok: Windsurf MCP ${mcpChanged ? 'updated' : 'already current'} at ${mcpFile}`,
      globalRules.skipped
        ? `warn: global_rules.md is over ${GLOBAL_RULE_LIMIT} characters with the Traffic One block; skipped ${rulesFile}`
        : `ok: Windsurf global rule ${globalRules.changed ? 'updated' : 'already current'} at ${rulesFile}`,
      'Restart Windsurf / Devin Desktop for hook and MCP config changes to load.',
    ].join('\n') + '\n',
  };
}

export function uninstallWrapper(env: NodeJS.ProcessEnv = process.env, args: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!args.includes('--yes')) {
    return { code: 2, stdout: 'Traffic One Windsurf uninstall mutates user-level Windsurf config. Re-run with --yes to confirm.\n' };
  }
  const hooksFile = windsurfHooksPath(env, args);
  const mcpFile = windsurfMcpPath(env, args);
  const rulesFile = windsurfGlobalRulesPath(env, args);
  const hooksChanged = removeHooks(hooksFile);
  const mcpChanged = removeMcp(mcpFile);
  const rulesChanged = removeGlobalRules(rulesFile);
  return {
    code: 0,
    stdout: [
      `ok: hooks ${hooksChanged ? 'removed' : 'not present'} at ${hooksFile}`,
      `ok: MCP ${mcpChanged ? 'removed' : 'not present'} at ${mcpFile}`,
      `ok: global rule ${rulesChanged ? 'removed' : 'not present'} at ${rulesFile}`,
    ].join('\n') + '\n',
  };
}

export function doctorWrapper(env: NodeJS.ProcessEnv = process.env, args: readonly string[] = process.argv.slice(2)): RunnerOutput {
  const hooksFile = windsurfHooksPath(env, args);
  const mcpFile = windsurfMcpPath(env, args);
  const rulesFile = windsurfGlobalRulesPath(env, args);
  const issues: string[] = [];
  try {
    const hooksConfig = readJsonObject(hooksFile);
    const hooks = hooksConfig.hooks && typeof hooksConfig.hooks === 'object' && !Array.isArray(hooksConfig.hooks) ? hooksConfig.hooks as Rec : {};
    for (const event of WINDSURF_HOOK_EVENTS) {
      const entries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
      if (!entries.some(ownedHookEntry)) issues.push(`missing hook ${event}`);
    }
  } catch (error) {
    issues.push(`hooks config unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const mcpConfig = readJsonObject(mcpFile);
    const servers = mcpConfig.mcpServers && typeof mcpConfig.mcpServers === 'object' && !Array.isArray(mcpConfig.mcpServers) ? mcpConfig.mcpServers as Rec : {};
    if (!ownedMcpEntry(servers['mcp-auth'])) issues.push('missing mcp-auth server');
  } catch (error) {
    issues.push(`MCP config unreadable: ${error instanceof Error ? error.message : String(error)}`);
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
  return { code: 0, stdout: `ok: Windsurf Traffic One integration active\nhooks: ${hooksFile}\nmcp: ${mcpFile}\nglobalRule: ${global}\n` };
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
