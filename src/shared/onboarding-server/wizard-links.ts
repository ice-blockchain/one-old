// src/shared/onboarding-server/wizard-links.ts
// How the setup link is rendered, and when a surface is allowed to stop offering it.
//
// The previous version of this file suppressed on PRODUCTION: any surface that
// emitted text containing both URLs stamped a 15-minute marker, and every other
// surface then stood down. Most of those producers are invisible to the user —
// the bootstrap's stdout (Cursor collapses it into "ran N commands"), agent-facing
// additionalContext, PreToolUse deny reasons — so a single invisible emission
// silenced every visible one. Runs ended with the agent saying "link already
// shared above" over a conversation that had never contained a link.
//
// Suppression now requires evidence of DELIVERY: the wizard server watching a real
// browser arrive (browser-arrival.ts). Until that happens every surface keeps
// carrying the URL. Repetition is the cheap failure; silence is the expensive one.
//
// Note the division of labour with once.ts: the session-scoped `firstEmitThisSession`
// markers still gate the FULL walkthrough so it lands once per session, which is
// what keeps prose from spamming. This file gates only the URL itself.

import { readDashboardHealth } from './dashboard-health';
import { wizardOpenedByUser } from './browser-arrival';

// A rendered local-fallback fragment — possibly empty when the hosted dashboard is
// healthy. Branded so `tsc` rejects a raw `localWizardUrl` being passed where a
// rendered fragment is expected: the swap is otherwise string→string and three
// independent reviews found call sites that would have silently kept emitting a
// naked loopback URL through the verbatim TS fallbacks.
export type LocalFallback = string & { readonly __localFallback: unique symbol };

export const NO_LOCAL_FALLBACK = '' as LocalFallback;

// True while a browser demonstrably has this wizard open. The ONLY thing that
// lets a surface stop offering the link.
export function wizardOpened(
  cwd: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  host?: unknown,
): boolean {
  return wizardOpenedByUser(cwd, token, env, host);
}

// Should this message carry the loopback wizard alongside the hosted link?
// Absent verdict (probe still in flight, or never ran) → yes: the safe default
// never strands a user on a page that will not load.
export function needsLocalFallback(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  host?: unknown,
): boolean {
  return readDashboardHealth(cwd, env, host) !== 'healthy';
}

// The prose form, for hosts that render a paragraph.
export function localFallbackSection(
  cwd: string,
  localWizardUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  host?: unknown,
): LocalFallback {
  if (!localWizardUrl || !needsLocalFallback(cwd, env, host)) return NO_LOCAL_FALLBACK;
  return `If the hosted page is unavailable or returns 404, open the local wizard directly: ${localWizardUrl}` as LocalFallback;
}

// The bare form for OpenCode/Kilo, whose prompt-injection filters reject
// multi-host walkthroughs — one plain sentence, no markdown, no negations.
export function localFallbackLine(
  cwd: string,
  localWizardUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  host?: unknown,
): LocalFallback {
  if (!localWizardUrl || !needsLocalFallback(cwd, env, host)) return NO_LOCAL_FALLBACK;
  return `Direct local fallback: ${localWizardUrl}` as LocalFallback;
}
