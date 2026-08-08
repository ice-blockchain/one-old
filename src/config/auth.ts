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

// How long after a SUCCESSFUL validation this machine may re-accept THE SAME
// key while the validator is UNREACHABLE (shared/auth/offline-grace.ts). It
// never applies to a key the validator REJECTED — that is an authoritative no
// and is not a candidate for grace at any age.
//
// Seven days is borrowed, not chosen: it is the span this repo already uses for
// a locally cached artifact that only a remote can truly re-confirm —
// CURSOR_MODELS_TTL_MS (shared/materialize/cursor-models.ts, a capability
// capture invalidated by plan/fingerprint change or this TTL, the closest
// structural analogue), and the two report-freshness windows REPORT_FRESH_MS
// (config/gitnexus.ts) and GRAPHIFY_FRESH_MS (modules/graphify/post-build.ts).
// __tests__/offline-grace.test.ts pins it to CURSOR_MODELS_TTL_MS so the two
// cannot drift apart silently.
//
// The window is an upper bound on a trust this machine ALREADY holds, never a
// new one: a stored auth record is read by a pure local predicate
// (isLocallyAuthenticated) that expires nothing, so between two revalidations
// the same key on the same machine is trusted unconditionally. Grace only
// re-grants, for a bounded time, access the product would still be granting had
// the endpoint answered — which is why the generous direction costs little
// measured against that baseline, while the tight direction strands a paying
// user with no network.
//
// Measured from `auth.updatedAt`, which is stamped by the ONLY writer of the
// record (shared/auth/simple-auth.ts writeSimpleAuth) and only after
// validateApiKey returned ok — at wizard intake AND now at every successful
// background revalidation (runners/auth/revalidate.ts). So the window runs from
// the last time the endpoint actually confirmed the key, not from intake.
export const AUTH_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// How often this machine re-asks the authenticated MCP surface whether the
// stored key is still good (shared/auth/revalidation.ts, fired detached from
// SessionStart). NOT once per session: SessionStart is a hook on the critical
// path with a 150 ms p95 dispatch budget (tests/hook-timing/hook-timing.test.ts)
// and auth is MACHINE-level, so a per-session probe would cost one network call
// per project per session for one machine-wide answer.
//
// Twenty-four hours is borrowed, not chosen. Between two revalidations a
// revoked key keeps working, so the cadence IS the size of an enforcement hole
// that nothing closes early — the exact thing OVERRIDE_MAX_TTL_MS
// (shared/override/token.ts) already bounds for this product: "A token is a
// hole in enforcement that nothing closes early, so the window has to be
// bounded by something other than the operator's typing. 24h is the point past
// which 'I am fixing this right now' stops being the true description." A
// deliberate override of a gate and a stale answer from the gate's authority
// are the same hole seen from two sides, so they get the same bound.
// shared/auth/__tests__/revalidation.test.ts pins the two together, the way
// AUTH_OFFLINE_GRACE_MS is pinned to CURSOR_MODELS_TTL_MS.
//
// It must also stay STRICTLY BELOW AUTH_OFFLINE_GRACE_MS, and the same test
// pins that: the grace window is what an unreachable endpoint spends, and a
// cadence at or above it would let the record fall out of grace before the
// product ever retried the probe that could have refreshed it. Strictly, not
// "at most": at equality the probe that could refresh the record is scheduled
// for the same instant the record stops being graced, so which of the two wins
// is left to the order two comparisons happen to run in.
export const AUTH_REVALIDATION_CADENCE_MS = 24 * 60 * 60 * 1000;

// ── bounds on the update feed's server-controlled prose ─────────────────────
// The same probe that revalidates the key returns the user's `updates` feed,
// whose `title`/`body` are rows in a remote database bound for agent-visible
// context (shared/auth/updates-feed.ts explains the injection hazard). All
// three bounds below are BORROWED from the constants this repo already uses for
// the same job, so the feed cannot end up with a laxer ceiling than the surfaces
// it sits beside — and so none of them is a number somebody picked here.
//
// Per field: shared/qa-report/schema.ts's MAX_SAFE_SUMMARY_LENGTH, which bounds
// exactly this — one untrusted string that will be rendered. Applied to `title`
// and `body` alike; a headline under the same ceiling as a summary is generous
// for the honest case and irrelevant to the hostile one.
export const UPDATE_TEXT_MAX_LENGTH = 500;
// Per page: qa-report/schema.ts's MAX_ROUTES, this repo's existing answer to
// "how many untrusted records may one payload repeat?". The server's own page
// default is 25 and its ceiling is 100, so this can only bite when the server
// breaks its own contract — which is the case a cap is for.
export const UPDATE_ITEMS_MAX = 100;
// Per rendered block: shared/onboarding/seed-prompt.ts's SEED_PROMPT_MAX_LENGTH,
// which is this codebase's standing bound on text IT INJECTS INTO A PROMPT. The
// update block has the same destination, so it inherits the same allowance
// rather than arguing for a private one.
export const UPDATES_BLOCK_MAX_LENGTH = 2000;
