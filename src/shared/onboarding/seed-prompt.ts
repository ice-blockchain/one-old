// src/shared/onboarding/seed-prompt.ts
// Persist the user's first request into the project state so the wizard can
// tailor its questions AND derive the right stack (without it, an empty prompt
// derives a bare frontend shell). Shared by UserPromptSubmit (normal flow) and the
// onboarding-wait runner's `--use --seed-prompt=…` yes path (ask-first flow,
// where nothing may be written before the user's recorded yes). Idempotent:
// never overwrites an existing prompt — the FIRST coding prompt is the project
// description.

import { isLikelyCodingPrompt, promptHasStackSignal } from '../detection';
import { uiLibraryFromPrompt } from '../capabilities/ui-system';
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
  // Flatten newlines/control characters to single spaces: the value is embedded
  // as a shell-quoted `--seed-prompt=` argv, and the gate's strict runner
  // allow-list rejects an embedded literal newline — observed live (019fbca1,
  // Codex 1.0.45): the gate denied the exact command its own recipe printed for
  // a two-line prompt, and the retry silently DROPPED the seed. Classification
  // only reads keywords, so the flattening loses no signal.
  const text = (prompt || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return text.length > SEED_PROMPT_MAX_LENGTH ? text.slice(0, SEED_PROMPT_MAX_LENGTH) : text;
}

/**
 * VERDICT on the dropped write below: acceptable as-is, and deliberately so.
 *
 * `writeState` answers `false` for a refused seed and that answer is discarded —
 * but the outcome it reports is the one the adjacent `catch` already accepts in
 * writing, and it is accepted for a reason that does not depend on which channel
 * carried it: a lost seed costs prompt-tailored wizard defaults, nothing more.
 * There is no in-memory state to outlive the call (`state` is local, the function
 * hands nothing back) and no irreversible act on either side of the write — the
 * one caller that precedes it with a mutation, onboarding-wait's `--use`
 * handler, records CONSENT, which the seed does not justify and which a lost seed
 * does not invalidate.
 *
 * The consumer is also already built for the seed being absent: onboarding-server
 * flow.ts's finalize has an explicit no-signal floor for exactly this case
 * (observed on Cursor 9b, where the host payload carried no prompt text so this
 * function never ran at all), and it floors to the default build stack rather
 * than deriving an empty one. A seed refused by the fence and a seed that never
 * existed are the same fact to that code path, and it is correct for both.
 */
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
    const uiLibrary = uiLibraryFromPrompt(text);
    writeState(cwd, {
      ...state,
      originalPrompt: text,
      ...(uiLibrary ? { uiLibrary } : {}),
    });
  } catch {
    // best-effort; the wizard still runs, just without prompt-tailored defaults
  }
}
