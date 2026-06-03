// src/runners/onboarding-server/index.ts
// CLI entry for the detached onboarding wizard server (compiles to
// scripts/onboarding-server.cjs, invoked via the build SHIM). main() starts the
// listening server and returns; the live socket keeps the process alive until the
// wizard completes or the idle timer fires. Never throws on the top level.

import { startOnboardingServer } from './server';

export { startOnboardingServer } from './server';
export type { RunningServer, StartOptions } from './server';

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cwd = args.find((a) => !a.startsWith('--')) || process.cwd();
  // `--port <n>` lets Claude Code's preview_start re-launch the wizard on the same
  // port recorded in .claude/launch.json; default 0 (kernel-assigned ephemeral).
  const portFlag = args.indexOf('--port');
  const port = portFlag >= 0 ? Number.parseInt(args[portFlag + 1] || '', 10) : Number.NaN;
  await startOnboardingServer({ cwd, standalone: true, ...(Number.isInteger(port) && port > 0 ? { port } : {}) });
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 0;
  });
}
