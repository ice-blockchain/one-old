// src/config/auth.ts
// Canonical API-key auth configuration. The MCP endpoint is used only to
// validate wizard-submitted keys with an authenticated tools/list request.

// Master switch for Traffic One auth ENFORCEMENT. When disabled, session-start /
// prompt-submit / materialize / pre-tool gates stop blocking and prompting — the
// plugin runs without authenticating. The gate is a pure local boolean read of
// the wizard-validated API key (shared/auth/simple-auth
// isLocallyAuthenticated). Anonymous public MCP sync/reporting has its own
// exact per-project pluginUse.enabled gate and never reads this credential.
// This is the committed default; TRAFFIC_ONE_AUTH explicitly overrides it per
// process (1/true/on → enforce, 0/false/off → bypass).
export const AUTH_ENABLED = true;
