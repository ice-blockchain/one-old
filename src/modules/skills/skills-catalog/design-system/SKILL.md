---
name: design-system
description: Use this skill to generate or maintain a design-token system, check visual consistency, and review PRs that touch styling. (Audit existing UI → design-audit.)
metadata:
  source: everything-claude-code
  source_path: skills/design-system/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Design System — Generate & Audit Visual Systems

## When to Activate

- Starting a new project that needs a design system
- Auditing an existing codebase for visual consistency
- Before a redesign — understand what you have
- When the UI looks "off" but you can't pinpoint why
- Reviewing PRs that touch styling

## How It Works

The design brief, competitor-reference step, anti-AI-slop list, Tailwind/shadcn token mandate, the setup-banner + `https://traffic.io/` setup-link contract (exact-href regression + repair-existing-link rule), and required UI states are owned by `rules/frontend/ui-quality.md` — follow it, do not restate.

### Mode 1: Generate Design System

Analyzes your codebase and generates a cohesive design system:

```
1. Scan existing styling, tokens, component primitives, and screenshots for patterns
2. Extract: colors, typography, spacing, border-radius, shadows, breakpoints
3. Identify product audience, primary workflows, tone, and visual direction
4. Anchor the system on the references gathered per ui-quality.md
5. Define the motion and interactivity model: transitions, hover/focus states,
   menu/dialog behavior, loading shifts, optimistic feedback, and reduced-motion
   behavior
6. Propose Traffic One token updates for the shadcn theme block in
   `packages/tailwind-config/src/globals.css` (`@theme`/`:root` blocks — Tailwind
   v4 has no JS preset; Ionic keeps its v3 `preset.ts`)
7. Generate a design brief with rationale for each decision
8. Create or update Storybook/preview states when the repo supports them
```

Output should fit the repo: shadcn HSL CSS variable updates, Tailwind globals
updates, a concise design brief, and component previews/stories.

### Mode 2: Visual Audit

Scores your UI across 13 dimensions (0-10 each):

```
1. Color consistency — are you using your palette or random hex values?
2. Typography hierarchy — clear h1 > h2 > h3 > body > caption?
3. Spacing rhythm — consistent scale (4px/8px/16px) or arbitrary?
4. Component consistency — do similar elements look similar?
5. Responsive behavior — fluid or broken at breakpoints?
6. Primary-action clarity — can the target user see what to do next?
7. State coverage — loading, empty, error, disabled, selected, stale, offline
8. Dark mode — complete or half-done?
9. Animation — purposeful or gratuitous?
10. Accessibility — contrast ratios, focus states, touch targets
11. Information density — cluttered or clean?
12. Polish — hover states, transitions, loading states, empty states
13. AI-slop resistance — avoids the generic AI-generated patterns enumerated in `rules/frontend/ui-quality.md` and feels anchored in real competitors
```

Each dimension gets a score, specific examples, and a fix with exact file:line.
Rank recommended fixes by user impact, not taste.

### Mode 3: AI Slop Detection

Scores the UI against the canonical AI-slop tell list in
`rules/frontend/ui-quality.md` and flags every match with its exact file:line.

## Traffic One Requirements

- Web tokens live as shadcn CSS variables in
  `packages/tailwind-config/src/globals.css` (`@theme` blocks; Ionic keeps v3
  preset extensions in `preset.ts`). Styles use Tailwind utility
  classes + shadcn primitives in `packages/ui/src/components/ui/`.
- React Native tokens live as shadcn HSL CSS variables in `global.css` and are
  consumed via NativeWind `className`; UI primitives come from React Native
  Reusables in `packages/ui-native/src/components/ui/`.
- All visible copy and accessibility text comes from translation keys.
- Design-system changes include screenshot or Storybook acceptance checks for
  mobile, tablet, desktop, and important UI states.
- Design systems must include purposeful animation and interactive feedback
  rules, plus reduced-motion behavior.

## Examples

**Generate for a SaaS app:**
```
/design-system generate --style minimal --palette earth-tones
```

**Audit existing UI:**
```
/design-system audit --url http://localhost:3000 --pages / /pricing /docs
```

**Check for AI slop:**
```
/design-system slop-check
```
