import { createHash } from 'crypto';

import { emittedWithin, stampEmitMarker } from '../once';
import { onboardingSyncSessionId } from './wait-command';

function markerLabel(token: string, sessionId?: string | null): string {
  // A wizard server/token is project-scoped and can outlive several host
  // conversations. Suppression is conversation-scoped: a new task must receive
  // its own clickable links even when it reuses the same live server. Hosts
  // without a stable session id retain the legacy project/token scope.
  const scope = onboardingSyncSessionId(sessionId) || 'session-unknown';
  const digest = createHash('sha256').update(`${token || 'pending'}\0${scope}`, 'utf8').digest('hex').slice(0, 20);
  return `wizard-links-shown-v3:${digest}`;
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
  sessionId?: string | null,
): boolean {
  if (!token || !dashboardUrl || !localWizardUrl) return false;
  const text = emittedPayloadText(payload);
  if (!text.includes(dashboardUrl) || !text.includes(localWizardUrl)) return false;
  stampEmitMarker(cwd, markerLabel(token, sessionId));
  return true;
}

export function wizardLinksShownWithin(
  cwd: string,
  token: string,
  ttlMs: number,
  sessionId?: string | null,
): boolean {
  return Boolean(token) && emittedWithin(cwd, markerLabel(token, sessionId), ttlMs);
}

export function wizardLinkLines(dashboardUrl: string, localWizardUrl: string): string[] {
  if (!dashboardUrl || !localWizardUrl) return [];
  return [
    `Open Traffic One setup: ${dashboardUrl}`,
    `If the hosted page is unavailable or returns 404, open the local wizard directly: ${localWizardUrl}`,
  ];
}
