// src/shared/onboarding-server/launch-config.ts
// Register the running wizard in <cwd>/.claude/launch.json so Claude Code's preview
// tool — preview_start with name "traffic-one-setup" — shows it in the IN-APP
// preview pane (no external browser). preview_start reuses a server already
// listening on the configured port, so it attaches to the gate-spawned wizard.
//
// This lives in shared (not the runner) because the SYNCHRONOUS gate writes it the
// instant it spawns the server — guaranteeing .claude/launch.json exists before the
// agent is told to call preview_start. (The detached server also self-registers on
// listen(), but the gate cannot depend on that async write having landed yet.)
// Best-effort and merge-preserving: the user's own launch configs are untouched,
// and our entry is removed again when the wizard shuts down.

import * as fs from 'fs';
import * as path from 'path';

import { isNonProjectRoot } from '../authoring-root';
import { pluginRoot } from '../paths';

export const LAUNCH_ENTRY_NAME = 'traffic-one-setup';

interface LaunchConfig {
  name?: string;
  [key: string]: unknown;
}
interface LaunchFile {
  version?: string;
  configurations?: LaunchConfig[];
  [key: string]: unknown;
}

function launchPath(cwd: string): string {
  return path.join(cwd, '.claude', 'launch.json');
}

function readLaunch(file: string): LaunchFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as LaunchFile;
  } catch {
    // missing or invalid → start fresh
  }
  return { version: '0.0.1', configurations: [] };
}

function wizardScriptPath(): string {
  const arg = process.argv[1];
  if (typeof arg === 'string' && arg.endsWith('onboarding-server.cjs')) return arg;
  return path.join(pluginRoot(), 'scripts', 'onboarding-server.cjs');
}

export function writeLaunchConfig(cwd: string, port: number): void {
  if (!Number.isInteger(port) || port <= 0) return;
  // Covers the detached server's async self-registration path too — never write
  // .claude/launch.json into the plugin's own repo/install.
  if (isNonProjectRoot(cwd)) return;
  try {
    const file = launchPath(cwd);
    const data = readLaunch(file);
    const configs = (Array.isArray(data.configurations) ? data.configurations : [])
      .filter((c) => c && c.name !== LAUNCH_ENTRY_NAME);
    configs.push({
      name: LAUNCH_ENTRY_NAME,
      runtimeExecutable: process.execPath,
      // --attach: don't re-bind the port the gate already opened; stay alive next to
      // it so preview_start shows the live wizard instead of crashing on EADDRINUSE.
      runtimeArgs: [wizardScriptPath(), cwd, '--port', String(port), '--attach'],
      port,
    });
    data.configurations = configs;
    if (!data.version) data.version = '0.0.1';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort; the clickable URL is always the fallback
  }
}

export function removeLaunchConfig(cwd: string): void {
  try {
    const file = launchPath(cwd);
    if (!fs.existsSync(file)) return;
    const data = readLaunch(file);
    if (!Array.isArray(data.configurations)) return;
    const next = data.configurations.filter((c) => c && c.name !== LAUNCH_ENTRY_NAME);
    if (next.length === data.configurations.length) return;
    // Our entry was the only one → remove the file rather than leaving an empty
    // `{"configurations":[]}` husk (and the `.claude/` dir) behind in a project
    // that may not even be a Claude Code project.
    const otherKeys = Object.keys(data).filter((key) => key !== 'configurations' && key !== 'version');
    if (next.length === 0 && otherKeys.length === 0) {
      fs.rmSync(file, { force: true });
      try {
        const dir = path.dirname(file);
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // best-effort; a non-empty .claude/ simply stays
      }
      return;
    }
    data.configurations = next;
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort
  }
}
