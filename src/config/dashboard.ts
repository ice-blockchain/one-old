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

export interface AgentOnboardingUrls {
  /** Hosted dashboard entry shown to the user first. */
  dashboardUrl: string;
  /** Direct loopback wizard. This must never point at the redirecting root. */
  localWizardUrl: string;
  /** Loopback root which redirects to the hosted dashboard. */
  redirectUrl: string;
}

// Keep the three onboarding URLs coupled. In particular, callers must not use
// `redirectUrl` as a local recovery link: the root redirects straight back to
// the hosted dashboard and therefore loops when that route is unavailable.
export function agentOnboardingUrls(
  env: NodeJS.ProcessEnv,
  port: number,
  token: string,
): AgentOnboardingUrls {
  if (!port || port <= 0 || !token) {
    return {
      dashboardUrl: '',
      localWizardUrl: '',
      redirectUrl: 'http://127.0.0.1:0/?t=pending',
    };
  }
  const encoded = encodeURIComponent(token);
  return {
    dashboardUrl: agentOnboardingUrl(env, port, token),
    localWizardUrl: `http://127.0.0.1:${port}/local?t=${encoded}`,
    redirectUrl: `http://127.0.0.1:${port}/?t=${encoded}`,
  };
}
