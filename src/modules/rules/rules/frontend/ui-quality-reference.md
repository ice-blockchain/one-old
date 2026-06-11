---
description: "Apply when finishing or reviewing UI work: the detailed checklists behind rules/frontend/ui-quality.md — responsive/state completeness, animation and interactivity, material honesty, variety techniques, foundational principles, and the rule-breaking checklist."
---

# UI Quality — Reference Checklists

Read-on-demand companion to `rules/frontend/ui-quality.md`. Before calling UI
work done (and when reviewing it), run these checklists.

## Material honesty — affordance through real digital properties

Digital materials have real properties. Don't fake physical depth.

- **Buttons**: communicate via colour, weight, spacing, hover/focus state — NOT drop shadows imitating relief.
- **Cards / containers**: use 1px borders, subtle background shifts, generous padding — not heavy elevation shadows by default.
- **Hierarchy**: scale, weight, spacing — not stacked z-shadows.
- **Functional depth (allowed)**: modals over content, dropdowns over UI, tooltips over everything. That's purpose, not decoration.
- **Animations**: follow physics adapted to digital — eased timings, not linear; respect `prefers-reduced-motion`.

## Force variety (anti-sameness)

Across multiple screens / pages / sites you generate, vary:
- Colour temperature (warm vs cool dominance).
- Type personality (geometric vs humanist; serif vs sans).
- Density (generous whitespace vs editorial intensity).
- Accent strategy (one bold accent vs duotone vs grayscale-with-color-pop).

Don't converge on a single safe formula. Each project deserves a distinct fingerprint.

## Concrete techniques that elevate over generic

- **Atmosphere**: photography, patterns, grain, textures over flat solid colours.
- **Custom cursors / focus rings** that fit the aesthetic.
- **Dominant + accent colour pairs** instead of evenly-distributed palettes.
- **Gradient meshes / layered transparencies** — when intentional, not as a "AI portfolio" tell.
- **Typography pairings** (serif display + sans body, or two contrasting sans) — only when justified, never just to look "designed".
- **Slow background motion** (CSS / SVG, looping, subtle) — adds life without distraction. Respect reduced-motion.

## Responsive and state completeness

- Design mobile first for generic mobile requests and for any surface where the
  user is likely to act from a phone.
- **Mobile navigation must be designed for touch, not auto-shrunk from desktop.**
  For responsive web/Ionic work, integrate a hamburger / drawer menu by default
  unless the user explicitly opts out. Use shadcn's `Sheet` primitive
  (`npx shadcn@latest add sheet`) for the mobile menu. For React Native, use the
  React Native Reusables `Sheet` / `Drawer` primitive on native (`npx @react-native-reusables/cli@latest add sheet`).
  Keep top-level nav visible on desktop (`md:flex`) and collapse to the Sheet on
  mobile (`md:hidden`). Bottom tab bars are an alternative for app-shell flows
  with ≤5 destinations; do not use both at once.
- Important content and the primary action must appear before excessive mobile
  scrolling. Fixed bottom actions must respect safe areas and keyboards.
- Text must fit inside controls and containers at desktop and mobile sizes.
  Resize the container or wrap the label; do not let text overlap or clip.
- Every meaningful UI state must be intentionally styled and localized:
  loading, empty, error, disabled, selected, stale, offline, reconnecting, and
  permission-denied where applicable.
- Visual-heavy work must include screenshot or Storybook verification at
  mobile, tablet, and desktop breakpoints before delivery.

## Animation and interactivity

UI without motion feels static and AI-generated. Use motion to clarify
causality and make the surface feel responsive — not to decorate.

- **Default motion library:** `framer-motion` on web/Ionic (already in the
  forced stack) and `react-native-reanimated` on Expo. `tailwindcss-animate`
  covers shadcn primitive transitions out of the box.
- **Where motion is required, not optional:** menu open/close (`Sheet`,
  `Dialog`, `DropdownMenu`, `Popover`), tab switches, route transitions,
  optimistic state changes, list item enter/exit, and loading-state shifts.
  Static `display: none` toggles for these patterns are a code smell.
- **Eased timings, never linear.** Prefer `ease-out` for enters (180–240ms)
  and `ease-in` for exits (140–200ms). Spring physics for drag/swipe gestures.
- **Hover and focus states ship the same energy as the animation system.**
  Subtle scale / colour / border transitions on interactive elements; never a
  jolt. Pair with visible focus rings.
- **Respect `prefers-reduced-motion`** — gate non-essential motion with the
  CSS media query (or `useReducedMotion()` from framer-motion); essential
  affordances (a menu opening) stay, decorative parallax/auto-play stops.
- **Don't animate to decorate.** No gratuitous bouncing logos, scroll-jacked
  parallax, or full-page reveals on every navigation. Motion that delays the
  primary action is worse than no motion.

## Foundational principles (in priority order)

1. **Simplicity through reduction** — start with everything you think you need, then cut until removing more breaks meaning.
2. **Material honesty** — see above.
3. **Functional layering, not visual depth** — hierarchy via type scale + colour contrast + spatial relationships, not skeuomorphic shadows.
4. **Obsessive detail** — every pixel intentional. Excellence is hundreds of small decisions.
5. **Coherent design language** — every element communicates its function; nothing arbitrary.
6. **Invisibility of technology** — the best UI disappears into the user's intent.

## Rule-breaking checklist

Guidelines exist to prevent mediocrity, not to limit excellence. Break a rule above when:

1. You can articulate the creative intent in one sentence.
2. It's a conscious choice, not laziness or a default.
3. It serves the user / brand / context.
4. A senior designer could defend it.

If yes to all four → break it confidently. Otherwise keep the rule.
