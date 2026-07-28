// Verbatim TS fallback for the onboarding-gate `browser-open-denied` block, so a
// missing generated SKILL.md never turns this deny into an empty reason.

export function browserOpenDeniedReason(): string {
  return [
    'Traffic One does not open the setup link for the user — they open it themselves.',
    'Post the setup link in a CHAT MESSAGE instead, on its own line, as plain clickable text (not inside a code block), then run the wait command and keep your turn open.',
    'An agent that opens the link tends to then believe it has "already shared" it and never posts it, which leaves the user with no link at all. Look at your own last visible chat message: if the link is not there, the user has not seen it.',
  ].join('\n\n');
}
