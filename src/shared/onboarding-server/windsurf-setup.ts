// Compact, host-specific setup text for Windsurf's hook surfaces. Keep this
// verbatim with the matching onboarding-gate skill blocks so it remains a safe
// fallback when a generated skill file is unavailable.

import type { LocalFallback } from './wizard-links';

export function windsurfSetupReason(url: string, localFallback: LocalFallback, waitCommand: string): string {
  return [
    'Traffic One setup is required before building.',
    `Before running any tool, show the user this standalone clickable setup link — do not open it yourself:\n[Open Traffic One setup](${url})`,
    String(localFallback),
    `Keep the current turn active by running this wait command (timeout ~9 minutes): ${waitCommand}`,
    'When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, immediately continue the original request.',
  ].filter((line) => line !== '').join('\n\n');
}

export function windsurfSetupRepeatReason(url: string, localFallback: LocalFallback, waitCommand: string): string {
  return [
    'Traffic One setup is still pending.',
    `Before running any tool, show the user this standalone clickable setup link — do not open it yourself:\n[Open Traffic One setup](${url})`,
    String(localFallback),
    `Keep the current turn active by running this wait command: ${waitCommand}`,
    'When it prints `TRAFFIC_ONE_SETUP_COMPLETE`, continue the original request.',
  ].filter((line) => line !== '').join('\n\n');
}
