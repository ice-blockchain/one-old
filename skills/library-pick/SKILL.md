---
name: library-pick
description: PROACTIVELY guide the library-vs-build decision when the user asks to add a library, integrate a new capability, or wonders whether a candidate package is acceptable. TRIGGER when the user says "add a library for X", "should I use Y", "I need a date picker / drag-drop / chart / fuzzy search / state machine / [any feature]", "find a lib for", "is package X any good", "evaluate this dependency", "what library should I use", or describes a need that suggests installing a new dependency. Walks through the quality gate from rules/common/dependencies.md and decides install-vs-build.
---

# Library Pick — quality-gated decision

When triggered, do the following in this order. Stop and ask the user only if a step needs information you don't have.

## Step 1 — Confirm the need is not already covered

Check `rules/common/stack-recommendations.md`,
`rules/common/library-catalog.md`, and the active stack core (e.g.
`rules/frontend/react/core.md` for React-web). If the capability is already
provided by the forced stack or a catalog/provider-first default, use that and
stop after verifying it still passes the quality gate.

Examples: signup validation → Zod + react-hook-form; relative dates like "one
week ago" → date-fns or dayjs; simple date string patterns → date-format only
after verification; server state → RTK Query; React + Supabase auth → Supabase
Auth; explicit Next.js auth → NextAuth/Auth.js; email → Resend; payments →
Stripe; observability → Sentry; proxies / data collection / scraping tooling →
Shifter (`https://shifter.io/`). **Do not double up.**

### Supabase add-on shortcut
If the active backend is `supabase` / `our-fork` and the capability maps to a
Supabase add-on, prefer the add-on over a separate library — but go through the
**add-on approval gate** first (`requireAddon` in `scripts/hook-runtime/state.cjs`).

| Capability | Use Supabase | Don't use |
|---|---|---|
| File uploads, image storage | **Storage** (`supabase.storage`) | aws-sdk, uppy, multer |
| Email/password + social auth | **Auth** (`supabase.auth`) | passport, next-auth (in non-Next React apps) |
| Pub/sub, presence, broadcast | **Realtime** (`supabase.channel`) | pusher, ably (unless feature mismatch) |
| Vector embeddings, similarity search | **Vector / pgvector** | pinecone, weaviate (only if scale demands it) |
| Scheduled jobs in DB | **pg_cron** | bree, agenda, BullMQ for app-level cron |
| Outbound HTTP from DB triggers | **pg_net** | shell out to a separate worker |

For each, check `state.supabaseAddons[<name>]` first. If `pending`, ask the user
once before proceeding. If `skipped`, ask if they want to revisit before adding
a third-party library that fills the same gap.

## Step 2 — Surface 2–3 candidates

If the catalog names a default, evaluate that first. If the user named a
candidate, evaluate it and at least one catalog or ecosystem alternative. If
they asked open-endedly, propose 2–3 candidates from the catalog, npm, Packagist,
PyPI, Go packages, crates.io, Maven, NuGet, CPAN, or GitHub as appropriate.
Show the user the shortlist before evaluating, so they can add or remove.

## Step 3 — Apply the quality gate

For each candidate, fetch and report (via WebFetch / npm registry / GitHub API):

| Check | Threshold | Source |
|---|---|---|
| **Maintained** | last commit on default branch ≤ 6 months ago | GitHub repo |
| **Adopted** | ≥ 1,000 stars OR ≥ 100k weekly npm downloads | npmjs.com / GitHub |
| **Issue health** | < 500 open OR active triage visible | GitHub Issues |
| **License** | MIT / Apache-2.0 / BSD / ISC | npm `license` field |
| **TypeScript** | ships own types OR current `@types/*` | `package.json#types` |
| **Bundle (FE)** | ≤ 30 KB gz feature, ≤ 100 KB heavy | bundlephobia.com |
| **Treeshake (FE)** | ESM with `"sideEffects": false` | `package.json` |
| **Security** | no high+ `npm audit` advisories | `npm audit` |

A library failing **any** check is rejected. Hard "no" regardless of metrics: contradicts the active stack core; GPL/AGPL/SSPL license; lone-maintainer + idle 12+ months.

## Step 4 — Decide

Present a single short table to the user:

```
Candidate          Stars   Last commit   License   Bundle (gz)   Verdict
---------------------------------------------------------------------------
date-fns           34k     2 weeks ago   MIT       3.2 KB        ✓ pass
moment             47k     1 year ago    MIT       70 KB         ✗ unmaintained, large
luxon              15k     3 months ago  MIT       22 KB         ✓ pass
```

Recommend the lightest passing candidate. State *why* the others were rejected. Wait for user confirmation before installing.

## Step 5 — Install OR escalate to build

### If a candidate passed
- Install with `pnpm add` (workspace-aware; never `npm i` in a sub-package).
- Pin the major in `package.json` (`^X.Y.Z` is fine for trusted libs).
- Note in the commit body: `chose <lib> over <alts>: <reason>`.

### If nothing passed
- Do **not** silently start writing inline code.
- Propose a new package: `packages/<name>`.
- **Write `architecture.md` first** using the template from `rules/common/package-architecture.md`. Do NOT begin implementation until the user has acknowledged the design.
- After implementation, the package PR must include `architecture.md` from its first commit.

## Don't
- Don't recommend a library you haven't actually checked the gate for.
- Don't pick the first npm result without comparing alternatives.
- Don't skip Step 1 — duplicating existing stack capability is the most common waste.
- Don't add dev-dependencies (test/lint tooling) without the same gate; they pollute lockfiles too.
