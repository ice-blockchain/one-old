// src/config/dashboard.ts
// The traffic.io dashboard config. Onboarding's UI now lives on the remote
// dashboard (Next.js + Clerk); the local onboarding server keeps all the logic
// and state writes and exposes its JSON API cross-origin. The gate surfaces a
// dashboard link — https://traffic.io/onboarding/agent#p=<port>&t=<token> — that
// carries the loopback server's port + token in the URL FRAGMENT so the token
// never reaches traffic.io's servers/logs. Override the base per-process with
// TRAFFIC_ONE_DASHBOARD_URL (e.g. http://localhost:3000 for dashboard dev).

export const DEFAULT_DASHBOARD_URL = 'https://traffic.io';

// Base dashboard origin, trailing slash stripped (mirrors endpointFromEnv in
// shared/auth). Never throws: a malformed override still returns a usable string.
export function dashboardUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.TRAFFIC_ONE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).trim();
  return raw.replace(/\/+$/, '');
}

// The agent-onboarding deep link. Port + token ride in the fragment (never sent
// to the dashboard server). Returns '' for the not-yet-listening placeholder
// (port 0 / missing token) so callers can guard on a non-empty string instead of
// leaking a ':0/pending'-style URL.
export function agentOnboardingUrl(
  env: NodeJS.ProcessEnv,
  port: number,
  token: string,
): string {
  if (!port || port <= 0 || !token) return '';
  return `${dashboardUrlFromEnv(env)}/onboarding/agent#p=${port}&t=${token}`;
}
