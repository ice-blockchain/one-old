// src/runners/onboarding-wait/index.ts
// A BLOCKING wait the agent runs right after opening the setup wizard, so the build
// resumes automatically when setup finishes — with no extra message from the user.
// It polls the SAME completeness predicate the gate uses (computeOnboarding(cwd).done),
// sleeping between checks, and is read-only (no writes; the only child process is the
// degraded-path /bin/sleep fallback). Compiles to dist/scripts/onboarding-wait.cjs
// via the build SHIM.
//
//   node onboarding-wait.cjs <cwd> [--timeout-ms <n>] [--interval-ms <n>]
//
// stdout TRAFFIC_ONE_SETUP_COMPLETE, exit 0 → setup finished; continue the build now.
// stdout TRAFFIC_ONE_SETUP_PENDING,  exit 2 → still pending after the timeout; re-run.

import { execFileSync } from 'child_process';

import { computeOnboarding } from '../../shared/onboarding-server/flow';

// 8 min keeps a single run safely under the host's ~10-min shell cap, so the agent
// gets a clean PENDING signal (rather than a hard kill) when the user is slow.
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 2000;

export type WaitOutcome = 'complete' | 'pending';

function positiveIntFlag(args: readonly string[], flag: string): number | null {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const n = Number.parseInt(args[i + 1] || '', 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Block the thread for `ms` without busy-spinning the CPU (no event-loop work runs
// between polls). Falls back to /bin/sleep when SharedArrayBuffer is disabled —
// re-polling immediately here would spin a core for the whole (up to 8-minute) wait.
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    try {
      execFileSync('/bin/sleep', [String(Math.max(0, ms) / 1000)], { stdio: 'ignore' });
    } catch {
      // No sleep available either — re-poll immediately rather than throw.
    }
  }
}

function onboardingDone(cwd: string): boolean {
  try {
    return computeOnboarding(cwd).done;
  } catch {
    return false;
  }
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  // Seams for tests (avoid real clock + state IO).
  isComplete?: (cwd: string) => boolean;
  now?: () => number;
  sleep?: (ms: number) => void;
}

export function waitForOnboarding(cwd: string, options: WaitOptions = {}): WaitOutcome {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const isComplete = options.isComplete ?? onboardingDone;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepSync;
  const deadline = now() + timeoutMs;
  for (;;) {
    if (isComplete(cwd)) return 'complete';
    if (now() >= deadline) return 'pending';
    sleep(intervalMs);
  }
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const cwd = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const outcome = waitForOnboarding(cwd, {
    timeoutMs: positiveIntFlag(argv, '--timeout-ms') ?? undefined,
    intervalMs: positiveIntFlag(argv, '--interval-ms') ?? undefined,
  });
  if (outcome === 'complete') {
    process.stdout.write('TRAFFIC_ONE_SETUP_COMPLETE\n');
    process.exit(0);
  }
  process.stdout.write('TRAFFIC_ONE_SETUP_PENDING\n');
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch {
    // Never hang or crash loudly — report pending so the agent re-runs.
    process.stdout.write('TRAFFIC_ONE_SETUP_PENDING\n');
    process.exit(2);
  }
}
