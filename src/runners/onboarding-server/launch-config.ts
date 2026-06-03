// src/runners/onboarding-server/launch-config.ts
// Register the running wizard in <cwd>/.claude/launch.json so Claude Code's
// preview tool — preview_start with name "traffic-one-setup" — shows it in the
// IN-APP preview pane (no external browser). preview_start reuses a server already
// listening on the configured port, so it attaches to the gate-spawned wizard.
// Best-effort and merge-preserving: the user's own launch configs are untouched,
// and our entry is removed again when the wizard shuts down.

import * as fs from 'fs';
import * as path from 'path';

import { pluginRoot } from '../../shared/paths';

const ENTRY_NAME = 'traffic-one-setup';

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
  try {
    const file = launchPath(cwd);
    const data = readLaunch(file);
    const configs = (Array.isArray(data.configurations) ? data.configurations : [])
      .filter((c) => c && c.name !== ENTRY_NAME);
    configs.push({
      name: ENTRY_NAME,
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
    const next = data.configurations.filter((c) => c && c.name !== ENTRY_NAME);
    if (next.length === data.configurations.length) return;
    data.configurations = next;
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort
  }
}
