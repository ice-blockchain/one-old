---
name: app-launch-checklist
description: >
  Use PROACTIVELY when the user asks for an app launch checklist, pre-launch
  readiness, public launch, soft launch, App Store / Play Store submission,
  launch compliance, SEO metadata, cookie consent, privacy/terms/account
  deletion/data export, status page, support form, admin hardening, payment
  production testing, or web/mobile launch parity for React, Ionic, Capacitor,
  or Supabase-backed products.
metadata:
  source: traffic-one-local
  adapted_for: traffic-one
---

# App Launch Checklist

Use this skill to turn launch requirements into plugin-side guidance,
generator tasks, and verification evidence. Keep provider dashboards, store
console submissions, legal decisions, payment tests with real cards, and
external messages behind explicit current-turn approval.

## Scope

- Generate app artifacts and TODOs only for the surfaces present in the repo.
- For policy-sensitive facts, use `documentation-lookup` and official sources
  before making claims about current Apple, Google Play, WCAG, GDPR/UK GDPR,
  CCPA/CPRA, analytics consent, or Core Web Vitals requirements.
- Do not invent legal text. Create placeholders, links, routes, and checklists;
  tell the user when counsel or store-console completion is required.
- If a requirement belongs to the backend/provider rather than the generated
  plugin output, record it as an external launch task with owner/evidence.

## Required Launch Evidence

### Web SEO and metadata

Apply this section only when the capability profile includes `web-ui`.

- This baseline is generated or reconciled during normal website work through
  the `seo` skill and `rules/common/seo.md`; the launch checklist verifies it
  rather than discovering it for the first time.
- Every public route has a unique `<title>`, meta description, canonical URL,
  and primary-entity JSON-LD that matches visible page content.
- Open Graph and Twitter Card images are PNG/JPG at 1200x630 for default and
  dynamic pages; generated routes have an image-generation path or a fallback.
- Favicon set includes `favicon.ico`, `apple-touch-icon`, and
  `manifest.webmanifest` for PWA installs when the app is installable.
- `robots.txt` and `sitemap.xml` reflect intended public routes. SPA critical
  public pages need prerendering or equivalent host support before claiming SEO
  parity.
- Enforce Lighthouse or Core Web Vitals thresholds only when they are explicit
  in the compiled performance contract. Otherwise record them as advisory. If
  CrUX/RUM field data is unavailable, mark field performance `UNVERIFIED`.

### Analytics and monitoring

- Analytics choice is explicit: PostHog, Plausible, or GA4. Non-essential
  analytics, replay, and ad tags must not load before consent where required.
- Error tracking follows the observability skill: Sentry releases tied to git
  SHA, source-map upload in CI, and mobile/native crash reporting for
  Capacitor when applicable.
- Consent state is durable, revocable, and respected by feature flags,
  analytics, replay, and marketing tags.

### Legal and compliance

- Privacy Policy and Terms of Service are linked in the footer and signup flow.
- Cookie consent has granular Accept, Reject, and Manage choices; honors Global
  Privacy Control where applicable; and blocks non-essential cookies/scripts
  before consent.
- Critical flows meet WCAG 2.2 Level AA: keyboard navigation, text contrast
  >= 4.5:1, focus not obscured by sticky/floating UI, accessible forms, clear
  errors, and manual screen-reader smoke on release paths.
- Products serving EU consumers treat the European Accessibility Act as a
  launch risk for covered services after June 28, 2025.
- Account creation requires an in-product account deletion path, especially for
  Apple submission. GDPR/UK GDPR access requests require a data export or
  right-to-access flow with owner and evidence.

### Operational readiness

- Contact/support form submits to a monitored inbox and has spam/rate-limit
  handling.
- Admin panels are hardened: separate domain or path, MFA required, audit log
  for admin actions, and optional IP allowlist for high-risk products.
- Backups are verified with a test restore, not only "enabled".
- Payment launch includes production-mode tests for success, refund, failed
  cards, 3-D Secure, and webhook idempotency. Digital goods in mobile apps use
  Apple IAP / Google Play Billing unless a documented store-policy exception
  applies.
- Production env vars live in the host's encrypted store; `.env.production`
  must not be committed.
- Staging soft-launch runs 24-72 hours of synthetic and real traffic before
  public launch when risk warrants it.
- Status page exists or is explicitly deferred with rationale.

### Ionic and Capacitor mobile launch

- App Store Connect evidence includes App Privacy answers, Privacy Policy URL,
  support URL, age rating, review notes/demo access, and a valid
  `PrivacyInfo.xcprivacy` for the app plus required third-party SDK manifests
  and required-reason API declarations.
- Google Play evidence includes Data Safety answers, privacy policy, current
  target API compliance, Android App Bundle readiness, and Play App Signing.
- ASO assets are ready: app name, subtitle/keywords for iOS, short/long
  description for Android, localized screenshots for required device sizes,
  app icon, content rating, and release notes.
- Permission prompts are asked in context after an education screen, never on
  app launch.
- Universal Links and Android App Links are served and verified:
  `/.well-known/apple-app-site-association` and
  `/.well-known/assetlinks.json`. Deep-link auth callbacks are tested on a
  physical device.
- TestFlight and Play Internal Testing have evidence from at least five
  external testers before public release unless the user explicitly accepts a
  smaller private launch risk.

## Output Shape

Use this compact shape for launch reviews:

```text
Verdict: READY | READY_WITH_RISKS | STAGING_ONLY | NOT_READY

Blockers:
- ...

Launch Checklist:
- Web SEO: PASS / RISK / MISSING / UNVERIFIED
- Analytics and monitoring: ...
- Legal and compliance: ...
- Operational: ...
- Mobile launch: ...

Evidence Checked:
- ...

External Owner Tasks:
- Store console / legal / payment / provider task: owner, evidence, due date

Next Fix:
- One smallest actionable fix, with file/provider surface named
```

## Related Skills

- `documentation-lookup`
- `seo`
- `accessibility`
- `observability`
- `deployment-patterns`
- `verification-loop`
- `ionic-mobile`
