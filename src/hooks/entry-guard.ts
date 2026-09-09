// Defense-in-depth around host entry `main()`. run*Hook is already supposed
// never to throw; this catches anything that still escapes (readStdin, a future
// edit, stdout write after a rejected runner) and turns a gate pre-tool escape
// into that host's existing deny — never exit 1, which is non-blocking on
// Claude/Codex/Windsurf.

import { reexecUnderManagedNodeIfBelowFloor } from '../shared/node-floor-reexec';
import { safeFailClosedRecoveryExemption } from './fail-closed';

export type GuardedHookOutput = {
  stdout: string;
  stderr?: string;
  exitCode: number;
};

type PreToolSurface = Parameters<typeof safeFailClosedRecoveryExemption>[2];

export type GuardedMainArgs<T extends GuardedHookOutput> = {
  subcommand: string | undefined;
  stdin: string;
  isPreTool: boolean;
  surface: PreToolSurface;
  deny: T;
  noop: T;
  run: () => Promise<T>;
};

function escapeHookOutput<T extends GuardedHookOutput>(args: GuardedMainArgs<T>): T {
  try {
    if (!args.isPreTool) return args.noop;
    if (safeFailClosedRecoveryExemption(args.stdin, args.subcommand, args.surface)) {
      return args.noop;
    }
    return args.deny;
  } catch {
    return args.isPreTool ? args.deny : args.noop;
  }
}

export async function guardedMain<T extends GuardedHookOutput>(
  args: GuardedMainArgs<T>,
): Promise<T> {
  reexecUnderManagedNodeIfBelowFloor({ stdin: args.stdin });
  try {
    return await args.run();
  } catch {
    return escapeHookOutput(args);
  }
}
