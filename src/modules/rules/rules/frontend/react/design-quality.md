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
`frontend/react/components.md`; styling uses Tailwind utility classes composed
on top of shadcn/ui primitives, with theme values pulled from the shadcn HSL
CSS variables (`--background`, `--foreground`, `--primary`, `--muted`,
`--accent`, `--destructive`, `--border`, `--ring`, …) defined in
`src/styles/globals.css`.

## Product-specific UI

- Do not ship generic template-looking UI. The interface should feel specific to the product, workflow, and audience.
- Build the actual usable experience as the first screen for apps, tools, and games; do not default to a marketing landing page.
- Missing Supabase or other environment configuration may show one shared
  setup banner, but it must not dominate or replace the product experience.
  Continue rendering a credible demo, seeded, empty, or degraded state for the
  actual workflow. Never ship a page whose main visible surface is duplicated
  "not configured" banners plus inactive filters or blank panels.
- Before coding design-led UI, ask for preferred competitor websites / design
  references if the user has not supplied them, and explicitly offer to analyze
  2–3 competitors yourself. State the selected references before implementation.
- Choose a concrete style direction before coding, then express it through tokens, layout, typography, interaction states, and motion. Record the design brief when the direction is not already documented.
- Default library styling is a starting point only; finish hover, focus, active, loading, empty, and error states intentionally.
- Preserve product logic and data flow during design passes; visual polish should be scoped to layout, styling, copy structure, and states.

## Required qualities

Meaningful frontend surfaces should show several of these, chosen for the product:

- Clear hierarchy through scale, density, and spacing contrast.
- Intentional rhythm instead of uniform padding everywhere.
- Depth or layering through surfaces, overlap, border treatment, or motion when it improves comprehension.
- Typography with a deliberate pairing and readable sizes for the UI density.
- Color used semantically for state and priority, not only as decoration.
- Designed hover, focus, active, disabled, loading, empty, and error states.
- Data visualizations treated as part of the design system.
- Motion that clarifies cause, continuity, or state changes and respects reduced-motion preferences.
- Purposeful interactive feedback for menus, filters, tabs, selections, forms,
  optimistic actions, loading shifts, hover/focus, and route changes.
- A responsive layout plan for mobile, tablet, and desktop before implementing new screens.

## Modern clean defaults

- Prefer restrained, high-clarity surfaces: crisp borders, subtle fills, strong type hierarchy, and fewer competing accents.
- Keep operational dashboards dense but calm: grouped controls, scan-friendly tables, meaningful empty/error states, and no vanity panels.
- Keep product/marketing pages inspection-friendly: the actual product, place, media, or workflow should be visible early.
- Use lucide icons or the project icon set for recognizable actions instead of text-only tool buttons when an icon is clearer.
- Use cards only for repeated items, modals, and framed tools. Page sections should be full-width bands or unframed layouts.

## Anti-template checklist

Before delivery, remove generic defaults that make the UI feel machine-spun:

- A centered hero plus identical feature cards with no product-specific first
  workflow.
- Stock-looking placeholder media, dark blurred atmospherics, or imagery that
  hides the actual product/place/object the user needs to inspect.
- Unmodified shadcn/default component states, default gray/white with one accent,
  timid headings, or browser/system font stacks on a design-led page without a
  deliberate reason.
- Decorative metrics, charts, or dashboard panels that do not answer an
  operator, buyer, or user question.
- Motion that is only decorative. Keep motion tied to navigation, continuity,
  feedback, optimistic state, filtering, loading, or hierarchy.

## Must not do

- Do not create decorative card grids, generic hero sections, or dashboard layouts with no workflow point of view.
- Do not ship generic AI-generated website tells: centered stock-gradient heroes,
  decorative card piles, purple-blue defaults, timid type, or static mockup-like
  screens without interaction.
- Do not use hardcoded colors, spacing, font sizes, radii, or shadows; use Tailwind tokens (`bg-primary`, `text-muted-foreground`, `rounded-lg`, …) backed by the CSS variables in `globals.css`. Extend the `@theme` tokens in `packages/tailwind-config/globals.css` before introducing new tokens.
- Do not put page sections inside floating cards. Use cards for repeated items, modals, and genuinely framed tools.
- Do not rely on color alone for state; pair it with text, iconography, or shape.
- Do not introduce visual flourishes that make text harder to scan, overlap content, or hide real product state.
- Do not copy desktop layouts directly onto mobile. Reorder content, simplify controls, and keep primary actions thumb-accessible.

## Verification

- Check desktop, tablet, and mobile breakpoints for overflow, text clipping, and incoherent overlap.
- Confirm keyboard focus states are visible and match the visual system.
- For visual-heavy changes, capture Playwright screenshots at representative breakpoints and compare against the design brief.
- Verify loading, empty, error, disabled, hover/focus/active, and reduced-motion states for touched components.
