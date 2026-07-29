// src/shared/onboarding/seed-prompt.ts
// Persist the user's first request into the project state so the wizard can
// tailor its questions AND derive the right stack (without it, an empty prompt
// derives to `minimal`). Shared by UserPromptSubmit (normal flow) and the
// onboarding-wait runner's `--use --seed-prompt=…` yes path (ask-first flow,
// where nothing may be written before the user's recorded yes). Idempotent:
// never overwrites an existing prompt — the FIRST coding prompt is the project
// description.

import { isLikelyCodingPrompt, promptHasStackSignal } from '../detection';
import { projectContextOriginalPrompt } from './project-context';
import { readState, writeState } from '../state';

// Ceiling for a prompt embedded as a `--seed-prompt=` argv value. Stack
// classification and triage routing only need the leading keywords; an
// unbounded seed bloats the approved command line for no signal gain.
const SEED_PROMPT_MAX_LENGTH = 2000;

// The seed must look like build/coding work — the SAME predicates the
// activation gate uses. A control / non-coding command ("stop all", "cancel",
// a greeting) is NOT a project description; seeding it pollutes the wizard's
// stack derivation and the maintenance-triage continuation.
export function qualifiesAsSeedPrompt(prompt: string): boolean {
  const text = (prompt || '').trim();
  if (!text) return false;
  return isLikelyCodingPrompt(text) || promptHasStackSignal(text);
}

export function truncateSeedPrompt(prompt: string): string {
  const text = (prompt || '').trim();
  return text.length > SEED_PROMPT_MAX_LENGTH ? text.slice(0, SEED_PROMPT_MAX_LENGTH) : text;
}

export function seedOriginalPrompt(cwd: string, prompt: string): void {
  const text = (prompt || '').trim();
  if (!text) return;
  if (!qualifiesAsSeedPrompt(text)) return;
  const state = readState(cwd);
  // Seed for EVERY mode (was new-project-only): the onboarding-wait runner reads
  // `originalPrompt` after SETUP_COMPLETE to emit the maintenance-triage routing
  // for the continued request — existing codebases are exactly where that
  // continuation lands in maintenance phase. Never overwrite an existing seed.
  if (typeof state.originalPrompt === 'string' && state.originalPrompt.trim()) return;
  if (projectContextOriginalPrompt(state)) return;
  try {
    writeState(cwd, { ...state, originalPrompt: text });
  } catch {
    // best-effort; the wizard still runs, just without prompt-tailored defaults
  }
}
