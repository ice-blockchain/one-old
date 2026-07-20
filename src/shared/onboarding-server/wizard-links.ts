import { createHash } from 'crypto';

import { emittedWithin, stampEmitMarker } from '../once';

function markerLabel(token: string): string {
  const digest = createHash('sha256').update(token || 'pending', 'utf8').digest('hex').slice(0, 20);
  return `wizard-links-shown-v2:${digest}`;
}

function emittedPayloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return '';
  }
}

// Commit the cross-surface marker only for a payload that already contains the
// complete recovery recipe. This prevents an exception, stale generated block,
// or hosted-only branch from suppressing the wait runner's direct /local link.
// Hash the token so it is never copied into a path.
export function commitWizardLinksShown(
  cwd: string,
  token: string,
  payload: unknown,
  dashboardUrl: string,
  localWizardUrl: string,
): boolean {
  if (!token || !dashboardUrl || !localWizardUrl) return false;
  const text = emittedPayloadText(payload);
  if (!text.includes(dashboardUrl) || !text.includes(localWizardUrl)) return false;
  stampEmitMarker(cwd, markerLabel(token));
  return true;
}

export function wizardLinksShownWithin(cwd: string, token: string, ttlMs: number): boolean {
  return Boolean(token) && emittedWithin(cwd, markerLabel(token), ttlMs);
}

export function wizardLinkLines(dashboardUrl: string, localWizardUrl: string): string[] {
  if (!dashboardUrl || !localWizardUrl) return [];
  return [
    `Open Traffic One setup: ${dashboardUrl}`,
    `If the hosted page is unavailable or returns 404, open the local wizard directly: ${localWizardUrl}`,
  ];
}
