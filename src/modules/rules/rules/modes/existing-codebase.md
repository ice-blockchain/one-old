---
description: "Apply when working in an existing codebase Traffic One did not scaffold: surgical changes only, local conventions win."
# Loaded when mode = existing-codebase (>5 source files, no Supabase)
---

# Mode: Existing Codebase

New code only; the surgical-change discipline (no unrelated refactors, never
revert user edits, match local style) is owned by
`rules/common/execution-discipline.md`. The mode-specific deltas below are
quantitative and absolute.

## Setup gate
- Follow `rules/common/setup-gate.md` before normal feature work. Existing
  projects skip new-project-only MVP context and Mobile App prompts; preserve
  the detected architecture and ask only missing local-preference steps.

## Active constraints
- Do NOT rename, move, or restructure existing files
- Max function length: 50 lines on new code
- Max component length: 150 lines on new code
- No `any`, no inline styles, named exports only — on new code
- No backend or infrastructure suggestions
- Before normal feature work, run the `project-memory` baseline reconciliation:
  - Confirm root `.traffic-one/.one.json` exists and has a valid `mode` and `stack`;
    `.traffic-one/` memory does not replace stack/state selection.
  - If `.traffic-one/` is missing, create it from verified repo facts.
  - If memory files already exist, update them in place.
  - If legacy ADRs exist in root `adr/`, migrate or mirror them to
    `.traffic-one/decisions/` when safe.
  - Do not include secrets, production data, or fake MCP/deploy configuration.
- Before normal feature work, run the `auto-documentation-generator` baseline
  reconciliation per `rules/common/documentation.md` (create-or-update canonical
  docs in place, migrate legacy `docs/` copies, mark unknowns `Unverified`).
- Before normal feature work on any existing web surface, run the `seo` baseline
  reconciliation per `rules/common/seo.md` (inspect existing SEO first, then add
  or update route-aware metadata/assets/coverage in place).
- Before normal frontend/UI work, reconcile the i18n baseline per
  `rules/frontend/i18n.md` (extend an existing i18n module for changed UI; do
  not invent a parallel system for a narrow edit on a project without one).
- For existing Supabase-backed web/Ionic surfaces, repair any missing-config
  setup banner/card touched by the work so its setup CTA points to
  `https://traffic.io/` and has regression coverage for that exact `href`.

<!-- TODO: expand with project-specific incremental rules once structure is validated -->
