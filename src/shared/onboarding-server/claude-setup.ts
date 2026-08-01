// Compact, host-specific setup text for Claude Code's hook surfaces. Keep this
// verbatim with the matching onboarding-gate skill blocks so it remains a safe
// fallback when a generated skill file is unavailable.
//
// Claude Code renders hook output and blocked commands inside a collapsed tool
// block, so a deny body is agent-visible but NOT user-visible. Observed live
// (1.0.43, existing codebase, Accept Edits): the agent answered the ask-first
// yes, ran bootstrap + wait, retried the wait as a background task, and the
// setup link never appeared in any message the user could see — only collapsed
// red "Failed to wait" blocks. These denies order the repost explicitly and name
// their own invisibility, mirroring the proven Cursor wait-link-first shape.

import type { LocalFallback } from './wizard-links';

export function claudeWaitLinkFirstReason(url: string, localFallback: LocalFallback, waitCommand: string): string {
  return [
    'This notice is NOT visible to the user: Claude Code renders hook output and blocked commands inside a collapsed tool block, so the setup link has still never appeared in the conversation.',
    'Check your own last VISIBLE chat message. Tool output, hook banners, and collapsed command blocks do not count — if the link is not in a message you wrote, the user has not seen it.',
    'Post this to the user in your NEXT CHAT MESSAGE, on its own line, as plain clickable text — not inside a code block. Do NOT open it yourself with a browser tool or an `open`/`xdg-open`/`start` command; the user clicks it:',
    `Open Traffic One setup: ${url}`,
    String(localFallback),
    'Only after that message is written, re-run the wait command in the FOREGROUND of the same turn (run_in_background: false, timeout ~9 minutes / 540000 ms) and keep the turn open:',
    waitCommand,
    'When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, continue the original request.',
  ].filter((line) => line !== '').join('\n\n');
}

// Turn-end (Stop) backstop prose, host-neutral: rendered as the Stop-block
// reason on Claude/Codex and as the Stop followup on Cursor. The turn is ending
// with setup still pending — this is the LAST chance to put the link in a
// message the user can see, so the block orders the post and the foreground
// wait. Once the server has watched a browser arrive, the links-shown variant
// keeps the turn on the waiter without reposting over an open wizard.
export function stopSetupRequiredReason(url: string, localFallback: LocalFallback, waitCommand: string): string {
  return [
    'You are ending your turn while Traffic One setup is still required, and the setup link has not been confirmed delivered — if the link is not in a message you wrote, the user has no way to continue setup.',
    'Post this setup link to the user NOW, in a chat message, on its own line, as plain clickable text — not inside a code block. Do NOT open it yourself; the user clicks it:',
    `Open Traffic One setup: ${url}`,
    String(localFallback),
    'Then run this wait command in the FOREGROUND (run_in_background: false, timeout ~9 minutes / 540000 ms) and keep the turn open. When it prints TRAFFIC_ONE_SETUP_COMPLETE, continue the original request:',
    waitCommand,
  ].filter((line) => line !== '').join('\n\n');
}

// The assistant already posted the link in a visible chat message, but the
// browser has not arrived yet. Reposting would duplicate the link (observed
// live on 1.0.45); the only useful continuation is the foreground wait.
export function stopSetupLinkPostedReason(waitCommand: string): string {
  return [
    'You are ending your turn while Traffic One setup is still pending. The setup link is already posted in the conversation — do NOT post it again; a repeated link reads as noise.',
    'Run this wait command NOW in the FOREGROUND (run_in_background: false, timeout ~9 minutes / 540000 ms) and keep the turn open. It returns immediately if setup is already complete; when it prints TRAFFIC_ONE_SETUP_COMPLETE, continue the original request:',
    waitCommand,
  ].filter((line) => line !== '').join('\n\n');
}

export function stopSetupLinksShownReason(waitCommand: string): string {
  return [
    'You are ending your turn while Traffic One setup is still in progress — the user has the setup wizard open in their browser right now (the setup server saw it load). Do NOT repost the link: a repeated link reads as "start over".',
    'Run this wait command NOW in the FOREGROUND (run_in_background: false, timeout ~9 minutes / 540000 ms) and keep the turn open. It returns immediately if setup is already complete; when it prints TRAFFIC_ONE_SETUP_COMPLETE, continue the original request:',
    waitCommand,
  ].filter((line) => line !== '').join('\n\n');
}

// Distinct semantics from the link-first deny: the command itself is fine — the
// backgrounding is not. Fires on EVERY backgrounded onboarding-runner request
// (bootstrap or waiter): a background task file is where the printed setup link
// goes to die, and "Background task failed" reads to the agent as a broken
// command instead of "run it again".
export function claudeWaitBackgroundDeniedReason(urlLine: string, waitCommand: string): string {
  return [
    'This onboarding command was requested with run_in_background: true. A backgrounded run writes its output — including the setup link it prints — into a background task file the user never opens, and the turn ends with the user waiting on a link they were never shown.',
    urlLine,
    'Post the setup link to the user in a CHAT MESSAGE — plain clickable text on its own line, not inside a code block — then re-run this SAME command in the FOREGROUND of this turn (run_in_background: false, timeout ~9 minutes / 540000 ms) and keep the turn open. Follow its printed instructions when it finishes.',
    waitCommand,
  ].filter((line) => line !== '').join('\n\n');
}
