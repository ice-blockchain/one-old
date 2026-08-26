// src/runners/onboarding-wait/wizard-output.ts
// Wizard URL announcement, bootstrap-ready output, completion ack, and
// decline/use choice handling. Stdout protocol tokens stay byte-identical.

import * as path from 'path';

import { detectHost } from '../../shared/host';
import { projectMembershipRoot } from '../../shared/project-membership';
import {  recordPluginUseChoice } from '../../shared/state/plugin-use';
import { seedOriginalPrompt } from '../../shared/onboarding/seed-prompt';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import { agentOnboardingUrls } from '../../config/dashboard';
import { readServerRecord } from '../../shared/onboarding-server/registry';
import { localFallbackSection, setupLinkNudgeLabel, wizardOpened } from '../../shared/onboarding-server/wizard-links';
import { clearEmitMarker, emittedWithin, stampEmitMarker } from '../../shared/once';

import {
  WIZARD_BANNER_REPRINT_MS,
  bannerMarkerLabel,
  sleepSync,
} from './wait-loop';

export function announceWizardUrl(
  cwd: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
  host: string = detectHost(),
  sessionId?: string,
): void {
  try {
    const rec = readServerRecord(cwd, process.env, host);
    if (!rec || !rec.url || rec.url.includes(':0/')) return;
    const urls = agentOnboardingUrls(process.env, rec.port, rec.token);
    const link = urls.dashboardUrl || urls.localWizardUrl;
    // The user has the wizard open in a browser — the server watched it arrive.
    // Keep a compact wait line so the terminal output still explains the block.
    // Note this is the ONLY thing that suppresses the banner: "some surface
    // already printed the URL" is explicitly NOT evidence the user saw it.
    if (wizardOpened(cwd, rec.token, process.env, host)) {
      write('\nWaiting for Traffic One setup to complete (the wizard is open in your browser; this command keeps the turn open)…\n');
      return;
    }
    // The banner is this process's own stdout, which several surfaces can print
    // near-simultaneously in one turn. A short production-scoped marker keeps the
    // terminal from showing the same block twice back-to-back — it never gates any
    // OTHER surface, so it cannot cause the silence this file exists to prevent.
    if (emittedWithin(cwd, bannerMarkerLabel(rec.token), WIZARD_BANNER_REPRINT_MS)) {
      write('\nWaiting for Traffic One setup to complete (setup link shown just above)…\n');
      return;
    }
    const localFallback = localFallbackSection(cwd, urls.localWizardUrl, process.env, host);
    const banner = (
      '\n════════════════════════════════════════════════════════════════\n'
      + '  TRAFFIC ONE SETUP — open this link in your browser to finish setup:\n\n'
      + `  ${link}\n\n`
      + (localFallback ? `  ${String(localFallback)}\n` : '')
      + '  Enter your API key and complete the setup steps.\n'
      + `  Setup link: ${link}\n`
      + '  Waiting for setup to complete (this command keeps the turn open)…\n'
      + '════════════════════════════════════════════════════════════════\n'
    );
    write(banner);
    stampEmitMarker(cwd, bannerMarkerLabel(rec.token));
  } catch {
    // best-effort — the wait still works without the banner
  }
}

// A wait that exits PENDING means setup did not complete while the agent held
// the turn open — and the gate's setup-link nudge marker may still be inside its
// TTL, which would leave every wait retry in the next few minutes with no
// user-visible surface at all (observed live: the link never reached the user).
// Re-arm the nudge so the NEXT gated tool call re-delivers the link. Exit-free
// and best-effort by design (the pending exit itself must never be blocked).
export function rearmSetupLinkNudge(cwd: string, host: string): void {
  try {
    const rec = readServerRecord(cwd, process.env, host);
    if (rec?.token) clearEmitMarker(cwd, setupLinkNudgeLabel(rec.token));
    // Defensive: a record-less project may still hold the placeholder marker.
    clearEmitMarker(cwd, setupLinkNudgeLabel(''));
  } catch {
    // best effort — re-arming must never break the waiter's exit path
  }
}

// The bootstrap's stdout is NOT a user-visible surface on every host — Cursor
// collapses it into a "ran N commands" block. It used to stamp a cross-surface
// "links were shown" marker and tell the agent not to print the URLs again, which
// is precisely how a run reached the user with the agent asserting "link already
// shared above" over a conversation that had never contained a link (2cu, 5cu).
// It now stamps nothing and instructs the opposite.
export function bootstrapReadyOutput(
  cwd: string,
  _token: string,
  dashboardUrl: string,
  localWizardUrl: string,
  host?: string,
): string {
  const localFallback = localFallbackSection(cwd, localWizardUrl, process.env, host);
  return `TRAFFIC_ONE_SETUP_READY\nSetup link: ${dashboardUrl || localWizardUrl}\n`
    + (localFallback ? `${String(localFallback)}\n` : '')
    + 'Post the setup link to the user in your next CHAT MESSAGE, as plain clickable text on its own line. '
    + 'This command output does not count as showing it — several hosts collapse or hide it. '
    + 'Do NOT open the link yourself with a browser tool or an `open`/`xdg-open`/`start` command; the user clicks it.\n';
}

// The setup tab belongs to the user. Traffic One neither opens nor closes it —
// the agent-driven `browser_tabs` close directive that used to live here was part
// of the same "the agent drives the browser" model that left users with no link
// at all (2cu: navigate, claim "links were shared above", close the tab).

// Bounded grace: `computeOnboarding().done` flips on the LAST /answer, which is
// seconds BEFORE the wizard tab finishes (`/verify-toolchain` → `/complete` →
// done view). `/complete` shuts the server down and clears its record, so a short
// poll on the record lets the wizard settle before the build resumes — this is a
// LOCAL poll ordering our own shutdown ahead of materialization, not a browser
// action. Capped so a tab that never posts /complete (closed early, network
// error) cannot stall the released build.
const COMPLETION_ACK_GRACE_MS = 4000;
const COMPLETION_ACK_POLL_MS = 250;

export function awaitWizardCompletionAck(cwd: string, host: string, graceMs: number = COMPLETION_ACK_GRACE_MS): void {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      if (!readServerRecord(cwd, process.env, host)) return; // /complete landed — server gone
    } catch {
      return;
    }
    sleepSync(COMPLETION_ACK_POLL_MS);
  }
}

// The cause prefs-store.ts decides the refusal from: it will not CREATE a
// preferences root for a directory an enclosing project already owns, and it
// reads that from the PARENT. Resolved the same way here so the message can name
// the directory a durable decline would have to be recorded against. A null
// keeps the wording generic rather than guessing at a root.
function enclosingProjectRoot(cwd: string): string | null {
  try {
    return projectMembershipRoot(path.dirname(path.resolve(cwd)));
  } catch {
    return null;
  }
}

// The --decline output: records the durable opt-out. A setup tab the user may
// still have open is theirs to close — we do not drive their browser.
//
// This string is the whole of what the command hands back, so it has to be true
// of the run that produced it. `recordPluginUseChoice` answers false when the
// choice never reached disk — measured on a plain sub-directory of a workspace,
// which gets no preferences root of its own (prefs-store.ts, the
// `mercury/strategies` guard). By then `removeDeclinedProjectArtifacts` has
// ALREADY swept, so the old body was wrong in both directions: the project's
// runtime files are gone AND the question comes back. Line 1 is the stdout
// protocol token four surfaces pin (test-environment's consent-decline-fence
// assertion, state/__tests__/home-rooted-consent.ts, and two cases in this
// runner's own wait.test.ts); it stays byte-identical and only the body varies.
export function declineOutput(cwd: string, _host: string): string {
  if (recordPluginUseChoice(cwd, false, 'command')) {
    return 'TRAFFIC_ONE_DISABLED\n'
      + "Traffic One is disabled for this project — continue the user's request without Traffic One conventions. "
      + 'It stays silent here until the user explicitly asks for Traffic One again.\n';
  }
  const enclosing = enclosingProjectRoot(cwd);
  return 'TRAFFIC_ONE_DISABLED\n'
    + "Continue the user's request without Traffic One conventions. "
    + 'The decline was NOT saved, so do not report it as settled: this directory\'s preferences belong to '
    + `${enclosing || 'an enclosing project'}, and Traffic One opens no preferences root for a sub-directory of `
    + 'one — nothing was written. The Traffic One runtime files that were here were deleted before that was known '
    + 'and do not come back, and with no answer on record the question returns next session. Only a decline '
    + `recorded against ${enclosing || 'the enclosing project root'} lasts, and turning Traffic One off for that `
    + "whole project is the user's call.\n";
}

// The `--use` yes path: record the durable per-project opt-in, then seed the
// request that triggered the ask-first question (`--seed-prompt=…`). In that
// flow NOTHING was written before this recorded yes — this is the FIRST write
// that may create the project's .traffic-one folder, exactly at decision time.
// The seed feeds the wizard's stack derivation and the post-setup triage.
// Returns whether the yes landed. beginOnboardingAttempt ignores it; main
// speaks via abortIfUseNotRecorded after the attempt. An unrecorded yes is not seeded.
export function applyUseChoice(
  cwd: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const recorded = recordPluginUseChoice(cwd, true, 'command', env);
  if (recorded) {
    const seedArg = argv.find((a) => a.startsWith('--seed-prompt='));
    if (seedArg) seedOriginalPrompt(cwd, seedArg.slice('--seed-prompt='.length), env);
  }
  return recorded;
}

// Same shape as the unrecorded-decline body in declineOutput: the yes never
// reached disk (prefs-store will not create a bucket for a directory an
// enclosing project already owns). Line 1 is the stdout protocol token — not
// TRAFFIC_ONE_DISABLED (that means decline) and not SETUP_READY / COMPLETE /
// PENDING (setup did not start). Printing belongs in main(), not here.
export function useNotRecordedOutput(cwd: string): string {
  const enclosing = enclosingProjectRoot(cwd);
  return 'TRAFFIC_ONE_SETUP_USE_NOT_RECORDED\n'
    + 'The yes was NOT saved, so do not report it as settled: this directory\'s preferences belong to '
    + `${enclosing || 'an enclosing project'}, and Traffic One opens no preferences root for a sub-directory of `
    + 'one — nothing was written. With no answer on record the question returns next session. Only a yes '
    + `recorded against ${enclosing || 'the enclosing project root'} lasts.\n`;
}
