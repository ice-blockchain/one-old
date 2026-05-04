---
name: browser-qa
description: Use this skill to automate visual testing, Lighthouse/page speed checks, Core Web Vitals, accessibility, and UI interaction verification using browser automation after deploying or building features. Triggers: "browser QA", "visual QA", "Lighthouse", "page speed", "Core Web Vitals", "performance score", "responsive testing", "accessibility audit".
metadata:
  origin: ECC
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

Traffic One precedence: follow this skill only where it does not conflict with Traffic One AGENTS.md and rules/*.md. Forced stack choices, approved libraries, i18n, styling, services, state, testing, accessibility, security, and backend technology rules from Traffic One take precedence. Treat upstream examples that use unapproved frameworks or libraries as conceptual patterns to adapt.

# Browser QA — Automated Visual Testing & Interaction

## When to Use

- After deploying a feature to staging/preview
- When you need to verify UI behavior across pages
- Before shipping — confirm layouts, forms, interactions actually work
- When reviewing PRs that touch frontend code
- Accessibility audits and responsive testing
- After visual design work — confirm the implementation matches the design brief
- Lighthouse, page speed, Core Web Vitals, or best-score performance verification

## How It Works

Uses the browser automation MCP (claude-in-chrome, Playwright, or Puppeteer) to interact with live pages like a real user.

Before running visual QA, identify the design brief or acceptance criteria:
primary action, intended hierarchy, responsive behavior, state coverage, and
screenshots required. If no brief exists, infer it from the user request and
the current UI, then state the assumption.

### Phase 1: Smoke Test
```
1. Navigate to target URL
2. Check for console errors (filter noise: analytics, third-party)
3. Verify no 4xx/5xx in network requests
4. Screenshot above-the-fold on desktop + mobile viewport
5. Run Lighthouse against the built production preview with mobile emulation
6. Record Lighthouse Performance and Core Web Vitals: LCP < 2.5s, CLS < 0.1, INP < 200ms, TBT < 200ms where available
```

Do not run Lighthouse against a dev server unless the user explicitly asks for
a diagnostic-only result. If the built preview is unavailable, report
"Lighthouse mobile performance: unverified" and list the concrete page-speed
risks instead of claiming the page-speed standard was verified.

### Phase 2: Interaction Test
```
1. Click every nav link — verify no dead links
2. Submit forms with valid data — verify success state
3. Submit forms with invalid data — verify error state
4. Test auth flow: login → protected page → logout
5. Test critical user journeys (checkout, onboarding, search)
```

### Phase 3: Visual Regression
```
1. Screenshot key pages at 3 breakpoints (375px, 768px, 1440px)
2. Compare against baseline screenshots (if stored)
3. Flag layout shifts > 5px, missing elements, overflow
4. Check dark mode if applicable
5. Compare hierarchy, spacing, primary CTA clarity, and state styling against the design brief
```

### Phase 4: Accessibility
```
1. Run axe-core or equivalent on each page
2. Flag WCAG AA violations (contrast, labels, focus order)
3. Verify keyboard navigation works end-to-end
4. Check screen reader landmarks
```

### Phase 5: Design State Coverage
```
1. Capture loading, empty, error, disabled, focused, and active states where the UI exposes them
2. Verify text fits in controls and cards at each breakpoint
3. Verify reduced-motion mode does not hide essential feedback
4. Verify mobile primary actions are reachable and not hidden by keyboard/safe areas
```

## Output Format

```markdown
## QA Report — [URL] — [timestamp]

### Smoke Test
- Console errors: 0 critical, 2 warnings (analytics noise)
- Network: all 200/304, no failures
- Build mode: production preview
- Route audited: /dashboard
- Lighthouse mobile Performance: 98 (100 ideal)
- Core Web Vitals: LCP 1.2s ✓, CLS 0.02 ✓, INP 89ms ✓, TBT 72ms ✓
- Page-speed blockers: none

### Interactions
- [✓] Nav links: 12/12 working
- [✗] Contact form: missing error state for invalid email
- [✓] Auth flow: login/logout working

### Visual
- [✗] Hero section overflows on 375px viewport
- [✓] Dark mode: all pages consistent
- [✓] Primary CTA remains visible and dominant on mobile
- [✗] Empty state spacing does not match the design brief

### Accessibility
- 2 AA violations: missing alt text on hero image, low contrast on footer links

### Verdict: SHIP WITH FIXES (2 issues, page speed verified with minor opportunities)
```

## Integration

Works with any browser MCP:
- `mChild__claude-in-chrome__*` tools (preferred — uses your actual Chrome)
- Playwright via `mcp__browserbase__*`
- Direct Puppeteer scripts

Pair with `/canary-watch` for post-deploy monitoring.
