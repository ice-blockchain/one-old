// Canonical API-key auth helpers. The wizard validates a submitted key with an
// authenticated MCP `tools/call` on the `updates` tool (runners/auth/validate-key.ts,
// which explains why calling a gated tool proves more than listing them), then
// simple-auth persists that key in one.json.auth.

import * as net from 'net';

import { AUTH_ENABLED } from '../../config/auth';
import { oneSettingsPath } from '../one-settings';
import { isLocallyAuthenticated } from './simple-auth';

export { readSimpleAuth, isLocallyAuthenticated, writeSimpleAuth, clearAuthentication } from './simple-auth';
export {
  offlineGraceVerdict,
  type AuthValidationFailure,
  type OfflineGraceVerdict,
} from './offline-grace';
export {
  revalidationAction,
  sessionRevalidationPlan,
  type AuthValidationOutcome,
  type RevalidationAction,
  type SessionRevalidationPlan,
} from './revalidation';
// NOT re-exported here: ./start-revalidation, which imports `authEnforced` from
// THIS file. Adding it would close a require cycle through the barrel for no
// gain — it has exactly one caller (modules/session/session-start.ts), which
// imports it directly.

function isLoopbackHostname(hostname: string): boolean {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const ipVersion = net.isIP(host);
  // 0.0.0.0 is the wildcard address, not loopback. Keep the plaintext-HTTP
  // exception restricted to genuine loopback development endpoints.
  if (ipVersion === 4) return host.startsWith('127.');
  if (ipVersion === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return host === 'localhost' || host === 'localhost.';
}

export function authEndpointUrl(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid Traffic One MCP auth endpoint: ${endpoint}`);
  }
  if (url.username || url.password) {
    throw new Error('Traffic One MCP auth endpoint must not include URL credentials.');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url;
  throw new Error('Refusing to send Traffic One credentials to a non-HTTPS MCP auth endpoint. Use HTTPS for remote endpoints; HTTP is allowed only for loopback local development.');
}

// Production auth is enabled by default. The process override remains useful
// for explicit operational and hermetic-test opt-outs.
//
// CLASSIFICATION of `TRAFFIC_ONE_AUTH=0|false|off|no`, since a shipped switch
// that turns authentication off invites the question. It is an opt-out, not an
// override an agent can mint, and these are the measurements behind that:
//
//  - It has exactly ONE production reader: the line below. A parsed census
//    (property/element/assignment nodes, not grep lines) over `src/**` +
//    `tests/**` found 104 accesses in 29 files, of which 1 is a non-test read
//    (here) and 77 are WRITES that all live in tests and in the two harnesses
//    (`src/test-environment/**`, `src/build/compiled-smoke.ts`) — neither of
//    which ships: the built plugin root contains this name in three files
//    (`config/auth.js` and `shared/onboarding-server/flow.js`, both comments,
//    plus this predicate). So no shipped code path sets it. The only writer of
//    the variable an installed plugin has is the environment its host process
//    was launched with.
//
//  - Nothing an agent authors can reach a gate through it. Gate decisions run
//    in hook processes the HOST spawns; an `env`-assignment prefix on a `Bash`
//    tool call applies to that child alone and never to a sibling hook process
//    spawned later from the host's own environment. It cannot take effect
//    mid-session at all. The one place a command's argv is admitted past a gate
//    (shared/tool-classify.ts's doctor exemption) anchors on
//    `words[0] === 'node'`, so `TRAFFIC_ONE_AUTH=0 node …/doctor.cjs` is not
//    exempt — the prefix costs the command its exemption rather than buying it
//    anything. __tests__/auth-enforced.test.ts pins both halves.
//
//  - The direction is the opposite of a bypass for most consumers. `off` makes
//    authSatisfied() TRUE, and every authSatisfied() consumer (graphify,
//    page-speed, materialize/post-stack-setup) stands DOWN when auth is not
//    satisfied — so turning this off makes that enforcement RUN. What it
//    genuinely stands down is only the auth DEMAND: the pre-tool auth block
//    (modules/session/auth-gate.ts), the session-start prompt, the wizard's
//    api-key step, and background revalidation. Measured against the
//    `--unblock` precedent (deliberately kept out of the gate-exempt grammar
//    because it mints an in-band, mid-run switch-off of a QUALITY gate the
//    agent has just been denied by), this switches off nothing an agent is
//    being denied by, in-band or otherwise. Different class; it stays.
//
// What it IS, and is not hardened against, because this predicate cannot see an
// env var's origin: a host settings `env` block is a PROJECT file on some hosts
// (`.claude/settings.local.json`, read by Claude at startup — this product
// writes to that very block for CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS), so a
// repository can ship an enforcement opt-out that applies to whoever opens it
// and restarts. That is an entitlement exposure — the user's key stops being
// demanded — and entitlement must therefore never rest on this boolean alone;
// paid capability is settled where the key is validated, not here.
//
// Invariants for anything editing this: keep the reader count at one, never
// source the value from project state, a project dotfile Traffic One itself
// parses, or tool argv, and never add a spelling that a gate deny can print.
export function authEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = (env.TRAFFIC_ONE_AUTH ?? '').trim().toLowerCase();
  if (override === '1' || override === 'true' || override === 'on' || override === 'yes') return true;
  if (override === '0' || override === 'false' || override === 'off' || override === 'no') return false;
  return AUTH_ENABLED;
}

export function authSatisfied(env: NodeJS.ProcessEnv = process.env): boolean {
  return !authEnforced(env) || isLocallyAuthenticated(env);
}

// Entry hooks use this only as a fallback context when the canonical wizard
// cannot yet open. Key intake and persistence are owned by the wizard.
export function authRequiredMessage(env: NodeJS.ProcessEnv = process.env): string {
  return [
    'Traffic One authentication is required before this plugin can be used.',
    '',
    'Open the Traffic One onboarding wizard and enter the Traffic One API key.',
    // Deliberately does not name the wire method. This sentence said "tools/list"
    // long after the probe became a `tools/call` on `updates`, so it was telling
    // users a mechanism the product does not perform. The method is pinned where
    // it is load-bearing (validate-key.test.ts asserts the probe), and nothing a
    // reader of THIS message can do depends on which request was sent — they are
    // being told where the key goes and how to supply it.
    `The wizard validates it against the Traffic One MCP endpoint and stores it under auth in ${oneSettingsPath(env)}.`,
    'Do not pass the key through a shell command or edit the auth state manually.',
  ].join('\n');
}
