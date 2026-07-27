---
name: frontend-design
description: >
  Create
  distinctive, production-grade frontend interfaces with high design quality.
  Use when the user asks to build web components, pages, or applications and
  the visual direction matters as much as the code quality.
metadata:
  source: everything-claude-code
  source_path: skills/frontend-design/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Frontend Design

Use this when the task is not just "make it work" but "make it look designed."

This skill is for product pages, dashboards, app shells, components, or visual systems that need a clear point of view instead of generic AI-looking UI.

For generated apps/sites, this is a mandatory pre-code gate whenever the user
asks for "modern", "polished", "UX optimized", "complete", "beautiful", or a
new user-facing product. The output must not stop at a technically correct app
shell; it needs a product-specific first screen, complete states, and visual QA.

## When To Use

- building a landing page, dashboard, or app surface from scratch
- upgrading a bland interface into something intentional and memorable
- translating a product concept into a concrete visual direction
- implementing a frontend where typography, composition, and motion matter

## Core Principle

Use a design-to-code loop: critique or infer the design problem, write a compact
implementation brief, make scoped changes, verify with screenshots or Storybook
states, then refine the top remaining visual issues.

Pick a direction and commit to it. Safe-average UI is usually worse than a
strong, coherent aesthetic with a few bold choices. Design-led UI should feel
clean, modern, interactive, and intentionally animated without becoming noisy.

## Design Workflow

The design brief, competitor-reference step, anti-AI-slop list, Tailwind/shadcn token mandate, the setup-banner + `https://traffic.io/` setup-link contract (exact-href regression + repair-existing-link rule), and required UI states are owned by `rules/frontend/ui-quality.md` — follow it, do not restate.

### 1. Frame the interface first

Before coding, settle or infer:

- purpose
- audience
- primary action
- emotional tone
- visual direction
- responsive behavior
- state coverage
- one thing the user should remember
- page-speed budget for the first screen: media weight, font choices, motion
  cost, dependency splits, and any explicit compiled performance thresholds

Possible directions:

- brutally minimal
- editorial
- industrial
- luxury
- playful
- geometric
- retro-futurist
- soft and organic
- maximalist

Do not mix directions casually. Choose one and execute it cleanly. If the user
only asks for "modern" or "clean", interpret that as clear hierarchy, low
visual noise, strong typography/spacing, complete states, mobile polish, and a
product-specific point of view. It also means the interface responds to input
with purposeful motion instead of feeling like a static mockup.

### 2. Build the visual system

Define:

- type hierarchy
- color tokens
- spacing rhythm
- layout logic
- motion rules
- surface / border / shadow treatment
- state treatment for loading, empty, error, disabled, selected, stale, and offline states

Use the project's token system so the interface stays coherent as it grows; the
Tailwind/shadcn token mandate and the missing-credentials setup-banner contract
are owned by `rules/frontend/ui-quality.md`.

### 3. Compose with intention

Prefer:

- asymmetry when it sharpens hierarchy
- overlap when it creates depth
- strong whitespace when it clarifies focus
- dense layouts only when the product benefits from density

Avoid defaulting to a symmetrical card grid unless it is clearly the right fit.
Do not put page sections inside floating cards; reserve cards for repeated
items, modals, and genuinely framed tools.

### 4. Make motion meaningful

UI without motion feels static and AI-generated. Default motion library:
`framer-motion` on web/Ionic and `react-native-reanimated` on Expo;
`tw-animate-css` (web v4) / `tailwindcss-animate` (Ionic v3) already covers shadcn primitive transitions.

Every design-led surface needs an interactivity and motion plan. At minimum,
menus, dialogs, tabs, route transitions, list/filter changes, loading shifts,
hover/focus states, and optimistic actions should feel responsive and animated
where the platform supports it.

Use animation to:

- reveal hierarchy
- stage information
- reinforce user action (button press, optimistic state shift, list item enter)
- mark route / tab / menu transitions as causally linked
- create one or two memorable moments

Eased timings, never linear: ~180–240ms ease-out for enters, ~140–200ms ease-in
for exits, springs for drag/swipe. Always respect `prefers-reduced-motion` —
gate non-essential motion behind the media query (or `useReducedMotion()`);
keep essential affordances (a menu opening) but stop decorative parallax /
auto-play. Do not scatter generic micro-interactions everywhere. One
well-directed load sequence is usually stronger than twenty random hover
effects.

### 4b. Mobile-first navigation

Mobile UI is designed for touch, not auto-shrunk from desktop. For responsive
web/Ionic work, integrate a hamburger / drawer menu by default unless the user
explicitly opts out. Use shadcn's `Sheet` primitive (`npx shadcn@latest add sheet`)
for the mobile menu; for React Native, use the React Native Reusables
`Sheet` / `Drawer` primitive (`npx @react-native-reusables/cli@latest add sheet`).
Keep top-level nav visible on desktop (`md:flex`) and collapse to the Sheet on
mobile (`md:hidden`). Bottom tab bars are a valid alternative for app-shell
flows with ≤5 destinations; do not use both at once.

### 5. Verify visually

Before delivery, capture or request representative screenshots:

- mobile, tablet, and desktop for web/Ionic
- at least one small phone and one larger device for React Native
- default, loading, empty, error, disabled, and focused states where relevant

Check against the design brief: primary action clarity, scan order, spacing,
text fit, overflow, clipping, contrast, focus visibility, and reduced motion.

## Strong Defaults

### Typography

- pick fonts with character
- pair a distinctive display face with a readable body face when appropriate
- avoid generic defaults when the page is design-led

### Color

- commit to a clear palette
- one dominant field with selective accents usually works better than evenly weighted rainbow palettes
- avoid cliché purple-gradient-on-white unless the product genuinely calls for it

### Background

Use atmosphere:

- gradients
- meshes
- textures
- subtle noise
- patterns
- layered transparency

Flat empty backgrounds are rarely the best answer for a product-facing page.

### Layout

- break the grid when the composition benefits from it
- use diagonals, offsets, and grouping intentionally
- keep reading flow obvious even when the layout is unconventional

## Execution Rules

- preserve the established design system when working inside an existing product
- match technical complexity to the visual idea
- keep accessibility and responsiveness intact
- preserve page speed: avoid design choices that require oversized media, blocking font loads, excessive animation, root-bundle bloat, or third-party scripts on the critical path
- frontends should feel deliberate on desktop and mobile
- keep product logic, API calls, state ownership, and routing behavior unchanged during visual-only passes
- implement one scoped design improvement at a time when the requested surface is large
- use translation keys for visible copy and accessibility text

## Quality Gate

Before delivering:

- the interface has a clear visual point of view
- typography and spacing feel intentional
- color and motion support the product instead of decorating it randomly
- the user either supplied design references or you stated the competitors you analyzed yourself
- the result does not read like generic AI UI or an AI-generated website
- the UI has purposeful interactivity and animation, with reduced-motion support
- the implementation is production-grade, not just visually interesting
- missing backend/env config still leaves a credible app surface, with at most
  one repeated setup banner pattern per page
- page-level web output meets explicit performance thresholds when the compiled
  contract requires Lighthouse; otherwise performance observations are advisory
- screenshot or Storybook verification covers only the widths/states required
  by the compiled verification contract, or the run is `blocked-environment`
