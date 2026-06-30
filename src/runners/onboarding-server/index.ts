// src/runners/onboarding-server/index.ts
// CLI entry for the detached onboarding wizard server (compiles to
// scripts/onboarding-server.cjs, invoked via the build SHIM). main() starts the
// listening server and returns; the live socket keeps the process alive until the
// wizard completes or the idle timer fires. Never throws on the top level.

import * as http from 'http';

import { detectHost } from '../../shared/host';
import { applyTrafficOneEnv } from '../../shared/state/traffic-one-paths';
import { startOnboardingServer } from './server';

export { startOnboardingServer } from './server';
export type { RunningServer, StartOptions } from './server';

// Does our wizard already answer on this loopback port? (/healthz is token-free.)
function wizardResponds(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Stay alive while the wizard on `port` keeps responding, then exit. Used by the
// preview-pane launcher so it has a managed, live process without binding the port.
function keepAliveWhileUp(port: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      void wizardResponds(port).then((up) => {
        if (!up) {
          clearInterval(timer);
          resolve();
        }
      });
    }, 3000);
  });
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cwd = args.find((a) => !a.startsWith('--')) || process.cwd();
  const host = detectHost(process.env, args);
  applyTrafficOneEnv(cwd, host);
  // `--port <n>` lets Claude Code's preview_start launch on the port recorded in
  // .claude/launch.json; default 0 (kernel-assigned ephemeral).
  const portFlag = args.indexOf('--port');
  const port = portFlag >= 0 ? Number.parseInt(args[portFlag + 1] || '', 10) : Number.NaN;
  const hasPort = Number.isInteger(port) && port > 0;

  // `--attach`: when the editor's preview tool runs the launch.json command, the gate
  // has usually already spawned the wizard. Re-binding the port would crash with
  // EADDRINUSE (this is the "preview failed to start" bug). Instead, when the wizard
  // is already serving, stay alive next to it so preview_start has a managed process
  // pointing at the live port; only serve ourselves if nothing is up.
  if (args.includes('--attach') && hasPort && (await wizardResponds(port))) {
    await keepAliveWhileUp(port);
    return;
  }

  await startOnboardingServer({ cwd, standalone: true, ...(hasPort ? { port } : {}) });
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 0;
  });
}
