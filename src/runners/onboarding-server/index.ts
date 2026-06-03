// src/runners/onboarding-server/index.ts
// CLI entry for the detached onboarding wizard server (compiles to
// scripts/onboarding-server.cjs, invoked via the build SHIM). main() starts the
// listening server and returns; the live socket keeps the process alive until the
// wizard completes or the idle timer fires. Never throws on the top level.

import { startOnboardingServer } from './server';

export { startOnboardingServer } from './server';
export type { RunningServer, StartOptions } from './server';

export async function main(): Promise<void> {
  const cwd = process.argv[2] || process.cwd();
  await startOnboardingServer({ cwd, standalone: true });
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 0;
  });
}
