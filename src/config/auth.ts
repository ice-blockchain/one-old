// src/config/auth.ts
// Auth-state read service + credential-store knobs. THE auth config: the default
// MCP endpoint, state/credential schema versions, expiry skew, and refresh
// resilience policy. The read/freshness functions live in shared/auth; the
// credential-store bridge lives in runners/auth/credential-store.ts.

// Master switch for Traffic One auth ENFORCEMENT. When disabled, authGateForHook
// reports authenticated, so the session-start / prompt-submit / materialize /
// pre-tool gates stop blocking and prompting — the plugin runs without
// authenticating. Lower-level predicates (isAuthenticatedLocal) still report the
// real session state, so optional remote features that genuinely need a token
// (e.g. the one-mcp report) stay correctly gated. This is the committed default;
// the TRAFFIC_ONE_AUTH env var overrides it per-process (1/true/on → enforce,
// 0/false/off → bypass) for ops + tests (see authEnforced in session/auth-gate).
export const AUTH_ENABLED = false;

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787/mcp';
export const AUTH_STATE_VERSION = 1;
export const EXPIRY_SKEW_MS = 30 * 1000;
export const REMOTE_AUTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Silent-refresh resilience. When a stale/expired session cannot refresh (a
// transient network blip or server hiccup), retry INVISIBLY with a small
// exponential backoff for up to REFRESH_FAILURE_THRESHOLD consecutive failures
// before surfacing a re-auth prompt. The consecutive-failure count and the
// next-eligible-attempt time are persisted on the auth state (`refreshFailures`
// / `nextRefreshAt`) and reset to zero on any successful (re)authentication.
export const REFRESH_FAILURE_THRESHOLD = 5;
export const REFRESH_BACKOFF_CAP_MS = 64 * 1000;

export const FRESHNESS_REASON = {
  OK: 'ok',
  MISSING: 'missing-auth-state',
  VERSION_MISMATCH: 'version-mismatch',
  MALFORMED_TOKEN: 'malformed-token',
  MALFORMED_EXPIRY: 'malformed-expiry',
  ENDPOINT_MISMATCH: 'endpoint-mismatch',
  EXPIRED: 'expired',
} as const;

// ── Credential store (runners/auth/credential-store.ts) ──────────────────────
export const CREDENTIAL_REF_VERSION = 1;
export const SERVICE = 'traffic-one';
