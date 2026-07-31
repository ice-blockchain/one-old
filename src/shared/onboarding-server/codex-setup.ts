// Compact, host-specific setup text for Codex's hook surfaces. Keep this
// verbatim with the matching onboarding-gate skill block so it remains a safe
// fallback when a generated skill file is unavailable.
//
// On Codex the PreToolUse DENY REASON is the ONLY output surfaced to the model
// (additionalContext is rejected on PreToolUse, and the prompt hook's context is
// version-flaky — see the onboarding-gate handler). So this deny must be fully
// self-contained: it carries the link, the repost order, and the exact wait
// command, with no reliance on any earlier surface having landed.

import type { LocalFallback } from './wizard-links';

export function codexWaitLinkFirstReason(url: string, localFallback: LocalFallback, waitCommand: string): string {
  return [
    'The setup link has not been posted to the user in this conversation yet, and this deny reason is the only channel that reaches you — so the user still has no link to click.',
    'Post this to the user in your NEXT MESSAGE, on its own line, as plain clickable text — not inside a code block. Do NOT open it yourself; the user clicks it and completes setup in their browser:',
    `Open Traffic One setup: ${url}`,
    String(localFallback),
    'Only after that message is written, re-run the wait command in the foreground of the same turn and keep the turn open:',
    waitCommand,
    'When it prints TRAFFIC_ONE_SETUP_COMPLETE, continue the original request.',
  ].filter((line) => line !== '').join('\n\n');
}
