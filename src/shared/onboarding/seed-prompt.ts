// src/shared/onboarding/seed-prompt.ts
// Persist the user's first request so the wizard can tailor its questions AND
// derive the right stack (without it, an empty prompt derives a bare frontend
// shell). It lands in the PER-USER project preferences
// (~/.traffic-one/projects/<hash>/preferences.json), never in the committed
// `.one.json` — see PROJECT_PREF_KEYS in state/local-prefs/pref-schema.ts for
// why a raw prompt must not be pushed to a shared remote.
// Shared by UserPromptSubmit (normal flow) and the
// onboarding-wait runner's `--use --seed-prompt=…` yes path (ask-first flow,
// where nothing may be written before the user's recorded yes). Idempotent:
// never overwrites an existing prompt — the FIRST coding prompt is the project
// description.

import { isLikelyCodingPrompt, promptHasStackSignal } from '../detection';
import { uiLibraryFromPrompt } from '../capabilities/ui-system';
import { readJsonResult } from '../fsjson';
import { projectContextOriginalPrompt } from './project-context';
import { mergeProjectPrefs, patchState, readEffectiveState, statePath } from '../state';
import { projectWritesPermitted } from '../state/plugin-use';

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
 * TWO ways this seed can fail to land, and they get OPPOSITE verdicts. Reading
 * the second onto the first is what left this function replacing state files.
 *
 * ── A REFUSED WRITE: acceptable as-is, and deliberately so ───────────────────
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
 *
 * ── AN ILLEGIBLE BASE: not the same fact, and not acceptable ─────────────────
 *
 * Everything above was measured on a REFUSED WRITE and is true of exactly that
 * input. It says nothing about the READ below it, where what is at stake is not
 * the seed but the file: `readState` answers a torn or unreadable `.one.json`
 * with the same `{}` it gives an absent one, so both idempotency guards decide
 * "no seed yet" from bytes nobody managed to read. That used to publish a
 * two-field object over everything the wizard had recorded; the prompt no longer
 * goes into that file at all, but `uiLibrary` still does, and the guard is kept
 * for the second reason it always had: a project whose recorded state cannot be
 * read is not one to start deriving preferences for. The one behavioural
 * consequence, stated rather than left to be discovered: a genuinely torn state
 * gets no seed until the wizard's `finalize` replaces and heals the file.
 *
 * ── WHERE THE PROMPT GOES, and why not through `writeState` ──────────────────
 *
 * The per-user preference store, via `mergeProjectPrefs`. NOT `writeState` with
 * `originalPrompt` in the object: `originalPrompt` is a routed local preference
 * now, so writeState would STRIP it, persist a state file that says nothing
 * about it, and answer `true` — the exact shape that lost `team` in production
 * (see the scope note on `writeState`). A caller whose subject IS a local
 * preference has to write the store directly, and `mergeProjectPrefs` reports by
 * throwing, which the `catch` below already accepts.
 */
export function seedOriginalPrompt(cwd: string, prompt: string): void {
  const text = (prompt || '').trim();
  if (!text) return;
  if (!qualifiesAsSeedPrompt(text)) return;
  // The repo write fence, applied by NAME because it is no longer applied for us.
  // The old `writeState` went through fsjson, which refuses any write under a
  // project's `.traffic-one/` while the use-plugin question is pending or
  // declined. The per-user prefs file is machine-owned and deliberately exempt
  // from that fence (it is where the consent answer itself lives), so without
  // this line the first prompt of a project the user then DECLINES would be
  // recorded anyway — and no decline can reclaim it, because
  // removeDeclinedProjectArtifacts must never touch the per-user dir.
  if (!projectWritesPermitted(cwd)) return;
  // Ahead of the guards below, which are the things a `{}` fallback turns into
  // "no seed yet". `absent` deliberately proceeds: a project with no `.one.json`
  // is the brand-new one this function exists for.
  const read = readJsonResult(statePath(cwd));
  if (read.kind === 'corrupt' || read.kind === 'unreadable') return;
  // The EFFECTIVE state, not `readState`: the latter strips routed local
  // preferences on read, so it answers "no seed yet" for a project that has one
  // and every later coding prompt would overwrite the first — the opposite of
  // this function's contract. readEffectiveState merges the per-user store back
  // in, and also rescues a value still embedded in a not-yet-scrubbed
  // `.one.json`, so an existing project mid-migration is not re-seeded either.
  const state = readEffectiveState(cwd);
  // Seed for EVERY mode (was new-project-only): the onboarding-wait runner reads
  // `originalPrompt` after SETUP_COMPLETE to emit the maintenance-triage routing
  // for the continued request — existing codebases are exactly where that
  // continuation lands in maintenance phase. Never overwrite an existing seed.
  if (typeof state.originalPrompt === 'string' && state.originalPrompt.trim()) return;
  if (projectContextOriginalPrompt(state)) return;
  try {
    mergeProjectPrefs(cwd, {
      originalPrompt: text,
    });
    // `uiLibrary` is a stack fact the materializer reads from shared state, not a
    // local preference, so it stays in `.one.json` — through `patchState`, which
    // re-reads the base inside the state lock instead of republishing a snapshot
    // taken outside it.
    const uiLibrary = uiLibraryFromPrompt(text);
    if (uiLibrary) patchState(cwd, { uiLibrary });
  } catch {
    // best-effort; the wizard still runs, just without prompt-tailored defaults
  }
}
