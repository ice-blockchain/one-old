// src/runners/onboarding-wait/wait-loop.ts
// Timing constants, the blocking wait loop, and post-setup triage.

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { maintenanceTriageDirective } from '../../modules/session/triage-directive';
import { detectMode } from '../../shared/detection';
import { detectHost } from '../../shared/host';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import { ensureCurrentRunId, normalizeState, readEffectiveState } from '../../shared/state';

const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 2000;
// How recently THIS runner printed its own terminal banner. Deliberately short and
// deliberately scoped to the banner alone: it stops the same block appearing twice
// back-to-back in one turn, and gates no other surface. The old cross-surface
// "links were shown" marker is gone — see shared/onboarding-server/wizard-links.ts.
export const WIZARD_BANNER_REPRINT_MS = 90 * 1000;

export function bannerMarkerLabel(token: string): string {
  return `wizard-banner-printed:${createHash('sha256').update(token || 'pending', 'utf8').digest('hex').slice(0, 20)}`;
}

export type WaitOutcome = 'complete' | 'pending';

export function positiveIntFlag(args: readonly string[], flag: string): number | null {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const n = Number.parseInt(args[i + 1] || '', 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Block the thread for `ms` without busy-spinning the CPU (no event-loop work runs
// between polls). Falls back to /bin/sleep when SharedArrayBuffer is disabled —
// re-polling immediately here would spin a core for the whole (up to 8-minute) wait.
export function sleepSync(ms: number): void {
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

export function onboardingDone(cwd: string): boolean {
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

// The post-setup routing for the request the agent is about to continue. The
// prompt was seeded into state.originalPrompt by the setup-required branch of
// UserPromptSubmit; non-maintenance projects (fresh new-project builds) and
// non-edit prompts return '' — the orchestrator flow owns those.
export function postSetupTriage(cwd: string): string {
  try {
    const state = JSON.parse(JSON.stringify(readEffectiveState(cwd))) as Record<string, unknown>;
    const prompt = typeof state.originalPrompt === 'string' ? state.originalPrompt.trim() : '';
    if (!prompt) return '';
    normalizeState(state, (state.mode as string) || detectMode(cwd));
    return maintenanceTriageDirective(cwd, state, prompt, {}, detectHost());
  } catch {
    return '';
  }
}
