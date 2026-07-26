// Compact, host-specific setup text for Cursor's hook surfaces. Keep this
// verbatim with the matching onboarding-gate skill block so it remains a safe
// fallback when a generated skill file is unavailable.
//
// Cursor collapses a blocked command into a "ran N commands" summary, so a deny
// body is agent-visible but NOT user-visible. Observed live (cursor-17c): the
// agent received this block, never reposted the URL, and then told the user to
// "use the setup link from the previous message" — a message that never had one.

export function cursorWaitLinkFirstReason(url: string, localUrl: string, waitCommand: string): string {
  return [
    'This notice is NOT visible to the user: Cursor renders a blocked command inside a collapsed "ran N commands" block, so the setup link has still never appeared in the conversation.',
    'Post these two lines to the user in your NEXT CHAT MESSAGE, each on its own line, as plain clickable text — not inside a code block, and do not open them with a browser tool:',
    `Open Traffic One setup: ${url}`,
    `Direct local fallback: ${localUrl}`,
    'Only after that message is written, re-run the wait command in the FOREGROUND of the same turn and keep the turn open:',
    waitCommand,
    'When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, continue the original request.',
  ].join('\n\n');
}
