// Compact, host-specific setup text for Windsurf's hook surfaces. Keep this
// verbatim with the matching onboarding-gate skill blocks so it remains a safe
// fallback when a generated skill file is unavailable.

export function windsurfSetupReason(url: string, localUrl: string, waitCommand: string): string {
  return [
    'Traffic One setup is required before building.',
    `Before running any tool, show the user this standalone clickable setup link:\n[Open Traffic One setup](${url})`,
    `If the hosted page is unavailable or returns 404, use the direct local wizard:\n[Open local Traffic One setup](${localUrl})`,
    `Keep the current turn active by running this wait command (timeout ~9 minutes): ${waitCommand}`,
    'When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, immediately continue the original request.',
  ].join('\n\n');
}

export function windsurfSetupRepeatReason(url: string, localUrl: string, waitCommand: string): string {
  return [
    'Traffic One setup is still pending.',
    `Before running any tool, show the user this standalone clickable setup link:\n[Open Traffic One setup](${url})`,
    `Direct local fallback: [Open local Traffic One setup](${localUrl})`,
    `Keep the current turn active by running this wait command: ${waitCommand}`,
    'When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, continue the original request.',
  ].join('\n\n');
}
