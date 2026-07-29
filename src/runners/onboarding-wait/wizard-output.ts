// src/runners/onboarding-wait/wizard-output.ts
// Wizard URL announcement, bootstrap-ready output, completion ack, and
// decline/use choice handling. Stdout protocol tokens stay byte-identical.

import { detectHost } from '../../shared/host';
import { pluginUseDeclined, recordPluginUseChoice } from '../../shared/state/plugin-use';
import { seedOriginalPrompt } from '../../shared/onboarding/seed-prompt';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import { agentOnboardingUrls } from '../../config/dashboard';
import { readServerRecord } from '../../shared/onboarding-server/registry';
import { localFallbackSection, wizardOpened } from '../../shared/onboarding-server/wizard-links';
import { emittedWithin, stampEmitMarker } from '../../shared/once';

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

// The --decline output: records the durable opt-out. A setup tab the user may
// still have open is theirs to close — we do not drive their browser.
export function declineOutput(cwd: string, _host: string): string {
  recordPluginUseChoice(cwd, false, 'command');
  return 'TRAFFIC_ONE_DISABLED\n'
    + "Traffic One is disabled for this project — continue the user's request without Traffic One conventions. "
    + 'It stays silent here until the user explicitly asks for Traffic One again.\n';
}

// The `--use` yes path: record the durable per-project opt-in, then seed the
// request that triggered the ask-first question (`--seed-prompt=…`). In that
// flow NOTHING was written before this recorded yes — this is the FIRST write
// that may create the project's .traffic-one folder, exactly at decision time.
// The seed feeds the wizard's stack derivation and the post-setup triage.
export function applyUseChoice(
  cwd: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  recordPluginUseChoice(cwd, true, 'command', env);
  const seedArg = argv.find((a) => a.startsWith('--seed-prompt='));
  if (seedArg) seedOriginalPrompt(cwd, seedArg.slice('--seed-prompt='.length));
}
