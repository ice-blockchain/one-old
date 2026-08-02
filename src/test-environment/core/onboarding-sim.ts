// src/test-environment/core/onboarding-sim.ts
// Pure-Node onboarding driver. Exercises the REAL wizard state machine
// (computeOnboarding -> applyAnswer) with scripted answers, no browser/host —
// producing authentic .one.json + preferences.json. Caller wraps in withCaseEnv
// so writes land in the isolated per-case paths.

import { computeOnboarding, applyAnswer } from '../../shared/onboarding-server/flow';
import {
  applyAgentTechClassification,
  type AgentTechSubmission,
} from '../../shared/onboarding/detection-stamp';
import type { ScriptedAnswer } from './types';

export interface OnboardingSimResult {
  ok: boolean;
  steps: { step: string; ok: boolean; error?: string }[];
  finalStep: string | null;
  done: boolean;
}

// Drives the flow to completion. For each computed step, looks up a scripted
// answer (matched by step id) and applies it. Stops when done, when a step has
// no scripted answer, or after a hard iteration cap.
export function driveOnboarding(cwd: string, answers: ScriptedAnswer[]): OnboardingSimResult {
  const byStep = new Map<string, unknown[]>();
  for (const a of answers) {
    const list = byStep.get(a.step) ?? [];
    list.push(a.value);
    byStep.set(a.step, list);
  }

  const steps: OnboardingSimResult['steps'] = [];
  let guard = 0;
  const MAX = 50;

  while (guard++ < MAX) {
    const view = computeOnboarding(cwd);
    if (view.done) return { ok: true, steps, finalStep: null, done: true };

    const step = view.step;
    if (!step || step === 'finalize') {
      // Terminal commit step: derives + writes the stack. No scripted answer needed.
      const outcome = applyAnswer(cwd, 'finalize', true);
      steps.push({ step: 'finalize', ok: outcome.ok, error: outcome.error });
      if (!outcome.ok) return { ok: false, steps, finalStep: 'finalize', done: false };
      continue;
    }

    const queued = byStep.get(step);
    if (!queued || queued.length === 0) {
      steps.push({ step, ok: false, error: 'no scripted answer for step' });
      return { ok: false, steps, finalStep: step, done: false };
    }
    const value = queued.shift();

    // Agent classification is NOT a wizard answer (POST /answer rejects it by
    // design — the runner is the only writer). The scripted value is the agent's
    // submission, applied through the REAL writer the `--set-tech` runner uses.
    if (step === 'tech-detect') {
      const result = applyAgentTechClassification(cwd, value as AgentTechSubmission);
      steps.push({
        step,
        ok: result.ok,
        ...(result.ok ? {} : { error: `${result.reason}${'issues' in result && result.issues ? `: ${result.issues.join('; ')}` : ''}` }),
      });
      if (!result.ok) return { ok: false, steps, finalStep: step, done: false };
      continue;
    }

    const outcome = applyAnswer(cwd, step, value);
    steps.push({ step, ok: outcome.ok, error: outcome.error });
    if (!outcome.ok) return { ok: false, steps, finalStep: step, done: false };
  }

  return { ok: false, steps, finalStep: 'iteration-cap', done: false };
}
