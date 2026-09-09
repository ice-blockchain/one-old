// src/runners/auth/validate-key.ts
// API-key validation against the fixed AUTH endpoint (`.../traffic-one-mcp/mcp`)
// — NOT the public first-look report endpoint, which accepts anything and can
// never reject a bad key. Two callers: the onboarding wizard's /answer route at
// intake, and the background revalidation worker (./revalidate.ts).
//
// HOW: `tools/call` on `updates`, carrying the key as Bearer. The gated
// endpoint's whole auth model is its Unkey Bearer gate — an invalid key is
// bounced 401 BEFORE method dispatch, a valid key reaches the tool and gets a
// 2xx JSON-RPC `result`.
//
// The rule this file has always carried — do NOT substitute a method that does
// not prove the Bearer key can reach the authenticated MCP TOOL SURFACE — is
// unchanged, and calling the only tool that surface exposes is the strongest
// form of it, not an exception to it. The earlier probe was `tools/list`, which
// proved the gate let us in; this one proves the gate let us in AND that the
// authenticated identity behind the key resolves all the way to a tool
// execution (the middleware seeds `mcpUserContext` from the key's Unkey
// identity, and the tool body reads it). What is still forbidden is the
// opposite move: probing the PUBLIC mount, or any endpoint that accepts
// anything and can never reject a bad key.
//
// One request serves both purposes on purpose. The server rate-limits at 60
// requests/min per USER identity across every machine that user owns, so the
// revalidation probe and the update-feed fetch are the SAME call — see
// probeAuthenticatedUpdates.
//
// ── the 401 is not one answer, it is four ───────────────────────────────────
// This used to map every 401/403 to `invalid-api-key`, and that was a
// fleet-scale hazard rather than a rounding error. The auth middleware emits
// FOUR distinct 401 codes and only ONE of them says anything about the key:
//
//   no_user                  Authorization header absent.
//   bad_authorization_header Non-Bearer scheme, or an empty token.
//   invalid_token            Wrong-shape bearer, Unkey REJECTED the key, or the
//                            identity fields are missing. The revoked/lapsed
//                            case, and the ONLY authoritative "no".
//   unkey_unavailable        `keys.verifyKey` THREW — the auth provider is down.
//                            A 401 that means "we could not check", not "your
//                            key is bad".
//
// Treating `unkey_unavailable` as a rejection would sign every Traffic One user
// out, on every machine, at their next session start, for the duration of
// someone else's outage — and they could not sign back in, because minting and
// verifying a replacement key run through the same provider. So it is routed to
// `auth-endpoint-unreachable`, i.e. into the offline grace window, which is
// exactly what that arm exists for. `no_user` and `bad_authorization_header`
// go the same way for the same reason with a different cause: both describe a
// malformed REQUEST, so they are reachable only from a bug in this client, and
// a client bug must not be able to log the fleet out either.
//
// The discriminator is the response BODY's `error.code`, never
// `WWW-Authenticate`: the header is IDENTICAL (`Bearer error="invalid_token",
// realm="traffic-one-mcp"`) for `invalid_token` and `unkey_unavailable`, so
// header-sniffing cannot tell a revoked key from a provider outage.
//
// Verified against the production endpoint on 2026-08-08 (three of the four
// codes; `unkey_unavailable` cannot be provoked without an Unkey outage and is
// taken from the server source, which routes all four through the same
// `errorHandler` envelope):
//   no Authorization    401 {"error":{"code":"no_user","message":"Authorization header is required","reqId":…}}
//   Basic scheme        401 {"error":{"code":"bad_authorization_header",…}}
//   `one_…` pool key    401 {"error":{"code":"invalid_token","message":"Bearer token is not a valid Unkey key",…}}
//   `traffic_one_mcp_…` 401 {"error":{"code":"invalid_token",…}}   (identical by design — the
//                       shape precheck deliberately mimics the post-verify rejection)
// Source of truth: one-dashboard-backend
//   supabase/functions/traffic-one-mcp/withMcpKey.ts   (the four `reject(...)` codes)
//   supabase/functions/_shared/http.ts `errorHandler`  (the `{error:{code,message,reqId}}` envelope)
//
// UNRECOGNISED means UNKNOWN, in both directions: a 401/403 whose body is not
// that envelope (a proxy, a captive portal, a WAF) is not the authority
// answering, and a 401 carrying a code this client has never heard of is not a
// rejection this client can claim to understand. Both fail to the grace arm.
// The cost of that choice is bounded and stated: a revocation this client
// cannot parse is granted the offline window instead of taking effect at once.
// The cost of the other choice is an unrecoverable lockout, because the way
// back in — the wizard's api-key page — runs this same function.
//
// Everything else that is neither a 2xx `result` nor a recognised rejection
// (timeout, DNS, non-HTTPS, 429 from the pre-auth rate limiters, 5xx, a 2xx
// carrying no JSON-RPC result) is likewise unreachable. The wizard fails CLOSED
// on both non-ok cases: a key is only stored once the gate confirms it.
//
// ── a failing TOOL is not a failing KEY ─────────────────────────────────────
// A throw inside the `updates` callback (zod parse, cursor decode, a DB fault)
// is collapsed by the server into one static message, `updates: temporary
// backend error`. VERIFIED against the SDK the server pins
// (@modelcontextprotocol/sdk@^1.29; dist/esm/server/mcp.js, the
// CallToolRequestSchema handler's catch → `createToolError`), that arrives as
//
//   HTTP 200 {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text",
//              "text":"updates: temporary backend error"}],"isError":true}}
//
// i.e. a JSON-RPC RESULT carrying `isError: true` — NOT a JSON-RPC `error`
// member. (MCP_SERVER_INSTRUCTIONS.md §7 and the server's own inline comment in
// tools/updates.ts both describe it as "a JSON-RPC error message"; the SDK that
// actually runs turns every tool throw into an isError RESULT, and only
// rethrows for `ErrorCode.UrlElicitationRequired`, which this tool cannot
// raise.)
//
// That distinction is worth more than a footnote, because it moves the verdict:
// the request passed the Bearer gate, resolved an identity, and reached tool
// dispatch. It is a CONFIRMATION of the key — the strongest one this probe can
// obtain — and it must not spend the offline grace window on a fault that has
// nothing to do with the subscription. So `isError: true` confirms the key and
// yields no items; it is the FEED that degrades, not the credential.
//
// A JSON-RPC top-level `error` member (no `result`) is treated as
// indeterminate. It also implies auth succeeded — the transport runs only after
// withMcpKey() in the Hono chain — but the conservative reading costs nothing
// here (an unreachable verdict is graced, never a rejection) and keeps the
// success test structural: a 2xx is a confirmation only when it is recognisably
// a JSON-RPC response from the MCP transport carrying a `result`, which a
// captive portal or proxy interstitial can never be.

import { DEFAULT_ENDPOINT } from '../../config/one-mcp';
import { recordUnknownAuthGate401 } from '../../shared/auth/auth-gate-drift';
import { mcpPost } from './mcp-client';

export type KeyValidation =
  | { ok: true }
  | { ok: false; reason: 'invalid-api-key' | 'auth-endpoint-unreachable'; error?: string };

/**
 * Every 401 code the auth middleware can emit, and whether it is an
 * authoritative statement ABOUT THE KEY. One table, so adding a server code is
 * one line here and a named test rather than a scattered condition.
 *
 * DRIFT: this is a cross-repository contract with no shared artifact and no
 * version. If the server ever renames `invalid_token`, revocation still fails
 * closed to grace — but an unknown `error.code` now writes a doctor finding
 * and a log line (shared/auth/auth-gate-drift.ts) instead of staying silent.
 * __tests__/validate-key.test.ts pins the four strings verbatim so a
 * deliberate change is a conversation; a shared contract fixture is a
 * server-repo follow-up.
 */
export const AUTH_GATE_401_CODES: Readonly<Record<string, 'rejects-the-key' | 'says-nothing-about-the-key'>> = {
  no_user: 'says-nothing-about-the-key',
  bad_authorization_header: 'says-nothing-about-the-key',
  invalid_token: 'rejects-the-key',
  unkey_unavailable: 'says-nothing-about-the-key',
};

/** The auth gate's error envelope, or null when this is not that envelope. */
export function authGateErrorCode(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

/** Does this 401/403 body authoritatively reject the key? Only `invalid_token` does. */
export function isAuthoritativeKeyRejection(body: string): boolean {
  const code = authGateErrorCode(body);
  return code !== null && AUTH_GATE_401_CODES[code] === 'rejects-the-key';
}

/**
 * A 401 envelope whose `error.code` this client has never heard of — the
 * silent-grace case KNOWN-ISSUES #8 named. Null when there is no code, or
 * when the code is one of the four this table understands.
 */
export function unrecognizedAuthGate401Code(body: string): string | null {
  const code = authGateErrorCode(body);
  if (code === null) return null;
  return Object.prototype.hasOwnProperty.call(AUTH_GATE_401_CODES, code) ? null : code;
}

/**
 * The JSON-RPC `result` member of a 2xx MCP response, or null when the body is
 * not recognisably one.
 *
 * STRUCTURAL, where this used to be `/"result"\s*:/` over the raw body. The
 * regex was adequate while the body was only ever a liveness signal; it is not
 * adequate now that the same body is parsed for prose that gets persisted, and
 * it would happily match the four characters inside an error message or an HTML
 * interstitial. Requiring `jsonrpc: "2.0"` plus an object `result` means the
 * only thing that can confirm a key is something that really is the MCP
 * transport answering — a captive portal returning 200 cannot forge it by
 * accident.
 *
 * Safe against SSE framing only because it does not have to be: the server
 * mounts its transport with `enableJsonResponse: true` (traffic-one-mcp/
 * index.ts), so a response is a single JSON document, never an event stream.
 */
export function jsonRpcResult(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const envelope = parsed as { jsonrpc?: unknown; result?: unknown };
  if (envelope.jsonrpc !== '2.0') return null;
  const result = envelope.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  return result as Record<string, unknown>;
}

export interface AuthProbeOptions {
  endpoint?: string;
  timeoutMs?: number;
  /**
   * The `nextCursor` from a previous page, passed back VERBATIM. Opaque,
   * server-issued, user-bound and version-tagged (`{v:2, after, u}` inside a
   * base64url envelope) — this client never parses, builds, trims or inspects
   * one, and a cursor minted for another user is rejected server-side.
   */
  cursor?: string;
  /** Where the unknown-401 sidecar is written. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface AuthProbe {
  readonly validation: KeyValidation;
  /**
   * The JSON-RPC `result` member when the tool answered at all — INCLUDING the
   * `{content, isError: true}` shape the SDK produces for a backend fault,
   * which is a valid answer about the KEY and a non-answer about the feed.
   * Absent on every other outcome. Raw and untrusted: the caller sanitises
   * before anything here reaches disk or agent context.
   */
  readonly result?: Record<string, unknown>;
}

/**
 * ONE request that answers two questions: is this key still good, and what is
 * in the user's feed?
 *
 * They are deliberately not two calls. The server rate-limits on verified
 * identity (60/min per user, across every machine that user owns), so a
 * separate liveness ping and feed fetch would double this lane's share of a
 * budget it does not control, to learn something the single call already
 * proves.
 *
 * `limit` is not sent. The server documents a default of 25 and clamps to
 * [1,100]; omitting the field takes that default, which is the only page size
 * in this system that neither side invented. A smaller page would be a number
 * chosen here with nothing behind it, and — at a 24-hour cadence — would turn a
 * backlog into weeks of drip-feed, one page per day.
 */
export async function probeAuthenticatedUpdates(
  apiKey: string,
  options: AuthProbeOptions = {},
): Promise<AuthProbe> {
  const key = String(apiKey || '').trim();
  if (!key) return { validation: { ok: false, reason: 'invalid-api-key' } };
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 10000;
  const cursor = typeof options.cursor === 'string' && options.cursor ? options.cursor : null;
  const params = { name: 'updates', arguments: cursor ? { cursor } : {} };

  let statusCode: number;
  let body: string;
  try {
    ({ statusCode, body } = await mcpPost(
      endpoint,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params },
      key,
      timeoutMs,
    ));
  } catch (error) {
    return { validation: { ok: false, reason: 'auth-endpoint-unreachable', error: (error as Error)?.message } };
  }

  if (statusCode === 401 || statusCode === 403) {
    if (isAuthoritativeKeyRejection(body)) return { validation: { ok: false, reason: 'invalid-api-key' } };
    // Unknown codes still grant grace — an unparseable revocation must not
    // lock the fleet out. Make the drift visible: a doctor finding + a log
    // line, never a quiet grant.
    if (statusCode === 401) {
      const unknown = unrecognizedAuthGate401Code(body);
      if (unknown) recordUnknownAuthGate401(unknown, options.env ?? process.env);
    }
    // The error string names the code so `doctor` and a bug report can tell an
    // outage from a proxy; it never carries server prose or the key.
    return {
      validation: {
        ok: false,
        reason: 'auth-endpoint-unreachable',
        error: `HTTP ${statusCode} ${authGateErrorCode(body) ?? 'unrecognised-body'}`,
      },
    };
  }

  if (statusCode >= 200 && statusCode < 300) {
    const result = jsonRpcResult(body);
    if (result) return { validation: { ok: true }, result };
  }
  return { validation: { ok: false, reason: 'auth-endpoint-unreachable', error: `HTTP ${statusCode || 'unknown'}` } };
}

/**
 * The wizard's intake call: the same probe, with the feed discarded. Kept as a
 * distinct export because /answer has no use for the payload and should not be
 * able to grow one by accident — a route that stores a credential is not the
 * place to start rendering server prose.
 */
export async function validateApiKey(
  apiKey: string,
  options: Omit<AuthProbeOptions, 'cursor'> = {},
): Promise<KeyValidation> {
  return (await probeAuthenticatedUpdates(apiKey, options)).validation;
}
