---
paths:
  - "package.json"
  - "**/package.json"
  - "pnpm-workspace.yaml"
---

# Dependencies — library-first, with a quality gate

When you need a capability not covered by the active stack core:

0. **Search locally first**: the search-repo-before-adding-code rule is owned by
   `rules/common/execution-discipline.md` — reuse or extend existing helpers,
   services, hooks, schemas, and tests before adding any dependency.
1. **Check defaults first**: use `rules/common/stack-recommendations.md`,
   `rules/common/library-catalog.md`, and the active stack core before
   searching. Do not build auth, validation, date formatting, email, storage,
   cache, queues, payments, observability, or deployment plumbing from scratch
   when a catalog/provider-backed default applies.
2. **Search externally** for 2–3 candidates on npm + GitHub and verify current
   usage in official docs when API shape or setup behavior matters. If a search
   channel is unavailable, say so instead of claiming full coverage.
3. **Apply the quality gate**: maintained (commit ≤ 6 months old) · adopted (≥ 1k stars OR ≥ 100k weekly downloads) · permissive license (MIT/Apache/BSD/ISC) · ships types · no high+ `npm audit` advisories. Frontend extras: bundle ≤ 30 KB gz feature / 100 KB heavy, ESM treeshakeable.
4. **If a candidate passes** → install + lock major. Note the decision (chosen + rejected with reason) in the commit body.
5. **If none pass** → build it under `packages/<name>` and update `.traffic-one/plan.md` **before** code with the package responsibility, boundaries, public API, and ADR link when needed.

Hard "no" regardless of metrics: anything contradicting the active stack core; GPL/AGPL/SSPL; lone-maintainer libs idle 12+ months.

When in doubt, trigger the **library-pick** skill — it walks the gate against your specific candidates.
