// src/runners/onboarding-server/index.ts
// CLI entry for the detached onboarding wizard server (compiles to
// scripts/onboarding-server.cjs, invoked via the build SHIM). main() starts the
// listening server and returns; the live socket keeps the process alive until the
// wizard completes or the idle timer fires. Never throws on the top level.
//
// The `--port`/`--attach` pair used to exist for Claude Code's preview pane, which
// launched this entry from `.claude/launch.json`. Traffic One no longer opens the
// wizard for the user on any host — the agent posts a link and the user clicks it —
// so the port is always kernel-assigned and there is nothing to attach to.

import { detectHost } from '../../shared/host';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';
import { startOnboardingServer } from './server';

export { startOnboardingServer } from './server';
export type { RunningServer, StartOptions } from './server';

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cwd = args.find((a) => !a.startsWith('--')) || process.cwd();
  const host = detectHost(process.env, args);
  initializeTrafficOneEnv(cwd, host);
  await startOnboardingServer({ cwd, trafficHost: host, standalone: true });
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 0;
  });
}
