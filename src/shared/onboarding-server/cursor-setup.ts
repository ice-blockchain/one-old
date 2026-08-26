// Compact, host-specific setup text for Cursor's hook surfaces. Keep this
// verbatim with the matching onboarding-gate skill block so it remains a safe
// fallback when a generated skill file is unavailable.
//
// Cursor's user_message surface shows this deny to the user, so the block must
// not claim it is invisible. Observed live (cursor-17c): the agent received the
// block, never reposted the URL, and then told the user to "use the setup link
// from the previous message" — a message that never had one. The same failure
// recurred in 2cu/5cu, which is why this still asks the agent to check its own
// last VISIBLE message rather than trust "I already shared it".

import type { LocalFallback } from './wizard-links';

export function cursorWaitLinkFirstReason(url: string, localFallback: LocalFallback, waitCommand: string): string {
  return [
    'Check your own last VISIBLE chat message. Tool output and collapsed command blocks do not count — if the link is not in a message you wrote, the user has not seen it.',
    'Post this to the user in your NEXT CHAT MESSAGE, on its own line, as plain clickable text — not inside a code block. Do NOT open it yourself with a browser tool or an `open`/`xdg-open`/`start` command; the user clicks it:',
    `Open Traffic One setup: ${url}`,
    String(localFallback),
    'Only after that message is written, re-run the wait command in the FOREGROUND of the same turn and keep the turn open:',
    waitCommand,
    'When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, continue the original request.',
  ].filter((line) => line !== '').join('\n\n');
}
