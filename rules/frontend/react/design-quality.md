---
paths:
  - "apps/web/src/**"
  - "packages/ui/**"
  - "src/components/**"
  - "src/features/**/components/**"
  - "src/pages/**"
---

# React Web Design Quality

Design-quality rules for React web surfaces. Component structure lives in
`frontend/react/components.md`; styling implementation stays in vanilla-extract
`.css.ts` files with values from `@app/design-tokens`.

## Product-specific UI

- Do not ship generic template-looking UI. The interface should feel specific to the product, workflow, and audience.
- Build the actual usable experience as the first screen for apps, tools, and games; do not default to a marketing landing page.
- Choose a concrete style direction before coding, then express it through tokens, layout, typography, interaction states, and motion.
- Default library styling is a starting point only; finish hover, focus, active, loading, empty, and error states intentionally.

## Required qualities

Meaningful frontend surfaces should show several of these, chosen for the product:

- Clear hierarchy through scale, density, and spacing contrast.
- Intentional rhythm instead of uniform padding everywhere.
- Depth or layering through surfaces, overlap, elevation, or motion when it improves comprehension.
- Typography with a deliberate pairing and readable sizes for the UI density.
- Color used semantically for state and priority, not only as decoration.
- Designed hover, focus, active, disabled, loading, empty, and error states.
- Data visualizations treated as part of the design system.
- Motion that clarifies cause, continuity, or state changes and respects reduced-motion preferences.

## Must not do

- Do not create decorative card grids, generic hero sections, or dashboard layouts with no workflow point of view.
- Do not use hardcoded colors, spacing, font sizes, radii, or shadows; extend shared design tokens first.
- Do not put page sections inside floating cards. Use cards for repeated items, modals, and genuinely framed tools.
- Do not rely on color alone for state; pair it with text, iconography, or shape.
- Do not introduce visual flourishes that make text harder to scan, overlap content, or hide real product state.

## Verification

- Check desktop and mobile breakpoints for overflow, text clipping, and incoherent overlap.
- Confirm keyboard focus states are visible and match the visual system.
- For visual-heavy changes, capture Playwright screenshots at representative breakpoints.
