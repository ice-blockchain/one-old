---
name: jwt-security
description: >
  Guidelines for implementing or reviewing JWT authentication securely, including
  token creation, validation, claims, signing algorithms, key rotation, refresh
  token rotation, revocation, storage, transmission, and JWT-specific tests.
  Triggers: "JWT", "JSON Web Token", "bearer token", "access token",
  "refresh token", "jwks", "token validation", "token rotation", "jwt auth".
metadata:
  source: mindrally-skills
  source_url: https://github.com/Mindrally/skills/blob/main/jwt-security/SKILL.md
  adapted_for: traffic-one
---

Traffic One precedence: follow this skill only where it does not conflict with Traffic One AGENTS.md and rules/*.md. Forced stack choices, approved libraries, i18n, styling, services, state, testing, accessibility, security, and backend technology rules from Traffic One take precedence.

# JWT Security

Use this when implementing, modifying, or reviewing JWT validation and token
security. Apply it with `security-review` for broader auth, secrets, input
validation, logging, CSRF, rate limiting, and endpoint authorization concerns.

JWT is not the default end-user auth system. For user auth, prefer the active
stack's provider first: NextAuth/Auth.js for explicit Next.js apps, Supabase
Auth + RLS for Supabase apps, and official framework/provider auth elsewhere.
Use this skill for provider-issued tokens, service-to-service JWTs, or cases
where a custom token layer remains necessary after the provider-first check.

## Core Principles

- JWT security depends on implementation; never treat signed tokens as inherently safe.
- Validate tokens server-side on every protected request, including internal service calls.
- Prefer asymmetric signing (`RS256`, `ES256`, or `EdDSA`) with explicit algorithm allowlists.
- Keep access tokens short-lived and pair them with secure refresh-token rotation when needed.
- Never store sensitive data, secrets, credentials, or high-risk PII in JWT payloads.
- Do not introduce JWT libraries without the Traffic One dependency quality gate.

## Token Contents

Required claims:

- `iss`: trusted issuer.
- `sub`: stable subject identifier.
- `aud`: intended audience.
- `exp`: expiration timestamp.
- `iat`: issued-at timestamp.

Recommended claims:

- `nbf`: not-before timestamp.
- `jti`: unique token id for revocation, replay detection, and rotation.

Header requirements:

- Include `typ: "JWT"` and a `kid` when keys can rotate.
- Reject missing or unknown `kid` values when using JWKS or multiple signing keys.
- Reject `alg: "none"` and any algorithm outside the configured allowlist.

## Signing Algorithms

- Prefer asymmetric algorithms for APIs and multi-service systems: `RS256`, `ES256`, or `EdDSA`.
- When using asymmetric keys, never allow symmetric algorithms in the same verifier; this prevents key-confusion attacks.
- If symmetric HMAC is required, use secrets from environment or a secret manager, never hardcoded values.
- HMAC secrets must be at least 256 bits for `HS256`, 384 bits for `HS384`, and 512 bits for `HS512`.
- Rotate keys with overlapping validity windows and expose only valid public keys through JWKS.

## Token Creation

- Set explicit `issuer`, `audience`, `algorithm`, `expiresIn`, and `keyid`.
- Keep custom claims minimal and authorization-oriented; fetch sensitive or frequently changing user data server-side.
- Use short token lifetimes:
  - Access token: about 15 minutes for sensitive apps.
  - Password reset token: about 15 minutes.
  - ID token: about 1 hour.
  - Email verification token: about 24 hours.
  - Refresh token: short enough for the risk profile, rotated on every use.

## Token Validation

Every verifier must:

- Parse the header only to find metadata such as `kid`; never trust decoded claims before signature verification.
- Select the signing key by trusted `kid` lookup.
- Verify signature with an explicit algorithm allowlist.
- Validate `iss`, `aud`, `exp`, `iat`, and `nbf` with a small clock-skew tolerance.
- Require `sub`; require `jti` for tokens that support revocation or refresh rotation.
- Check revocation state for refresh tokens and any access tokens that must support early invalidation.
- Return typed auth errors without leaking raw token contents or stack traces.

## Storage and Transmission

- Browser apps: prefer httpOnly, `Secure`, `SameSite=Strict` cookies when backend support exists.
- If cookies are not viable, keep access tokens in memory and accept that refresh/page reload handling must be designed deliberately.
- Never store JWT access tokens in `localStorage`; avoid `sessionStorage` for sensitive tokens.
- Never place tokens in URLs, query strings, redirects, logs, analytics events, or error reports.
- Use the `Authorization: Bearer <token>` header for API transmission unless cookie-based auth is intentionally chosen.
- In production, transmit tokens only over HTTPS.

## Refresh Tokens and Revocation

- Store refresh tokens in httpOnly cookies or secure server-side storage.
- Rotate refresh tokens on every use and revoke the previous token by `jti`.
- Detect reuse of revoked refresh tokens and invalidate the token family when appropriate.
- Bind refresh tokens to a client, device, or session when the product risk model requires it.
- Keep revocation state in durable storage such as Redis or the database; in-memory sets are only acceptable for tests or local prototypes.

## Key Rotation

- Publish current and still-valid previous public keys through JWKS.
- Include `kid` in issued tokens and remove old keys only after all tokens signed by them expire.
- Cache JWKS with bounded TTL and rate limits.
- Treat unknown `kid`, malformed JWKS, duplicate key ids, and unsupported algorithms as authentication failures.

## Common Vulnerabilities to Prevent

- Accepting whatever algorithm appears in the token header.
- Allowing `alg: "none"`.
- Mixing symmetric and asymmetric algorithms in one verifier.
- Weak, reused, or hardcoded HMAC secrets.
- Missing issuer, audience, expiry, or not-before validation.
- JWTs used as a dumping ground for permissions or sensitive user data.
- Refresh tokens without rotation or reuse detection.
- Logging full tokens or decoded payloads.

## Verification

Add focused tests that reject:

- Expired tokens.
- Tokens with the wrong issuer or audience.
- Tokens before `nbf`.
- Tokens with missing required claims.
- Tokens signed with disallowed algorithms, including `none`.
- Tokens using an unknown `kid`.
- Revoked or reused refresh tokens.
- Malformed tokens and malformed JWKS responses.
