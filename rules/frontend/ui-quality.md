---
paths:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.css"
  - "**/*.scss"
  - "**/tailwind.config.*"
  - "**/globals.css"
  - "**/global.css"
  - "apps/**/src/**"
  - "packages/ui/**"
  - "packages/ui-native/**"
  - "packages/tailwind-config/**"
---

# UI Quality — design gate + material honesty

Distilled from bencium-marketplace (impact-designer + controlled-ux-designer).
Rules apply silently when generating any UI; the goal is interfaces that look
intentionally designed, not machine-generated. Pair with `rules/frontend/typography.md`
for character-level rules and `rules/frontend/accessibility.md` for WCAG.

## Central design gate

Before writing or changing UI for a new screen, feature, component set, or
mobile flow, establish a compact design brief. If the user has not already
named competitor sites, design references, or a preferred style, ask for the
websites/designs they want to emulate and explicitly offer to analyze 2–3
best-in-class competitors yourself. If the user chooses self-analysis or has
already delegated visual direction, pick the references, state them, and proceed.
Derive the rest from the user request, existing product, screenshots, and
codebase; ask only when a missing answer would materially change the design
direction.

- **Purpose**: the user problem and target audience.
- **Primary action**: the one action or decision the screen should make easier.
- **Competitor reference**: pick **2–3 best-in-class real products** in the same
  domain from the user's preferred references or your own competitor analysis
  (not AI showcases — actual companies users use). Note one specific thing each
  does well: layout pattern, mobile nav style, type system, motion feel,
  interaction model, density, content structure. The goal is "looks like a real
  product team shipped this", not "looks like an LLM generated this." Keep the
  references concrete (URL or product name) so the choice is auditable.
- **Visual direction**: a concrete tone such as refined minimal, editorial,
  Swiss grid, industrial, warm utility, playful, or monochrome high-contrast.
- **Hierarchy plan**: what the eye should read first, second, and third.
- **Token plan**: the existing or proposed design tokens for colour, type,
  spacing, radii, border, motion, and state treatment.
- **Interactivity and motion plan**: the gestures, transitions, hover/focus
  feedback, optimistic state shifts, and memorable but restrained animation
  moments that make the UI feel alive.
- **Responsive plan**: mobile, tablet, desktop layout behavior and breakpoint
  risks.
- **State plan**: default, hover, focus, active, disabled, loading, empty,
  error, offline/degraded, and permission-denied states where applicable.
- **Acceptance checks**: screenshots or Storybook states to capture, plus the
  overflow, clipping, focus, contrast, reduced-motion, and anti-AI-slop checks
  that must pass.

For tweaks to existing screens, match the established aesthetic first and make
only scoped improvements. For new products, choose a direction and commit to it.

## Design-to-code loop

Use AI design work as a loop, not a vague "make it prettier" pass:

0. **Reference**: before designing anything new, ask for the competitor sites /
   design references the user likes and offer to analyze the relevant
   competitors yourself. Then look at 2–3 real competitor / best-in-class
   products in the same domain. Identify the specific patterns worth borrowing
   (mobile nav, type pairing, density, motion language, interaction model) and
   the AI-tells worth avoiding. Skip this step only when matching an existing
   in-app aesthetic.
1. **Audit**: inspect the existing UI or planned surface and rank design issues
   by user impact.
2. **Brief**: convert the critique into an implementation brief with component,
   token, responsive, state, and accessibility requirements.
3. **Implement**: make the smallest scoped UI changes that satisfy the brief;
   preserve product logic and data flow.
4. **Verify**: capture screenshots at representative breakpoints or Storybook
   states, then check hierarchy, spacing, text fit, overflow, focus, contrast,
   loading/empty/error states, and reduced motion.
5. **Refine**: fix the top remaining visual regressions before delivery.

Never treat "modern" or "clean" as an instruction to add decoration. It means
clear hierarchy, low visual noise, strong typography/spacing, complete states,
mobile polish, purposeful motion, interactive feedback, and a product-specific
point of view.

## Anti-AI-slop — NEVER ship these without a reason you can defend

| Category | Avoid by default |
|---|---|
| **Fonts (web)** | Inter, Roboto, Arial as primary; Space Grotesk (overused by AI); system fonts as default body |
| **Fonts (RN)** | The platform default for everything — pick a real type system |
| **Colours** | SaaS blue `#3B82F6`; purple-on-white gradients; "AI portfolio" pastel-glass |
| **Effects** | Glass morphism / Apple mimicry; liquid blob backgrounds; rainbow conic gradients without purpose |
| **Layout** | Cookie-cutter centered hero + 3-card-grid + CTA; predictable component arrangements |
| **Vibe** | Anything that looks "Claude-generated" — generic SaaS, lifeless, evenly-spaced palette, timid |

If the user's brand or brief explicitly calls for one of the above (e.g. they ARE building Apple-like polish), commit fully — half-execution looks worse than the rule-break.

## Modern clean defaults

- Make the first screen useful: apps, tools, dashboards, and games open on the
  actual working experience, not a marketing shell.
- Generated app/site prompts must produce a product-specific, content-rich first
  screen. Missing backend/env configuration is not a reason to ship a blank or
  nearly blank UI: show one shared setup banner at the app boundary, then render
  polished demo, seed, empty, loading, and error states that demonstrate the
  real workflow after the backend contract and security baseline exist.
- Do not duplicate missing-config banners or cards on the same page. If an
  app-level `<EnvBanner />` is visible, feature surfaces should use lighter
  contextual empty states rather than repeating the same setup CTA.
- Make the UI interactive by default: menus, filters, tabs, selection, loading,
  optimistic actions, and route changes should respond with purposeful motion
  and visible state feedback instead of static swaps.
- Use fewer, stronger elements: one primary action per region, restrained
  supporting actions, and enough spacing contrast to make scanning effortless.
- Prefer crisp surfaces: 1px borders, subtle background shifts, tokenized
  radius, and honest layering over heavy shadows or decorative glass.
- Use colour for meaning: priority, status, selection, risk, and affordance.
  Pair colour with text, iconography, or shape.
- Keep layouts domain-specific: operational SaaS should be dense and quiet;
  editorial/product pages may be more expressive; games/tools should show the
  playable or usable object immediately.
- Avoid visual monoculture across generated projects. Vary typography, density,
  colour temperature, and accent strategy to fit the product.

## Material honesty — affordance through real digital properties

Digital materials have real properties. Don't fake physical depth.

- **Buttons**: communicate via colour, weight, spacing, hover/focus state — NOT drop shadows imitating relief.
- **Cards / containers**: use 1px borders, subtle background shifts, generous padding — not heavy elevation shadows by default.
- **Hierarchy**: scale, weight, spacing — not stacked z-shadows.
- **Functional depth (allowed)**: modals over content, dropdowns over UI, tooltips over everything. That's purpose, not decoration.
- **Animations**: follow physics adapted to digital — eased timings, not linear; respect `prefers-reduced-motion`.

## The reduction filter — apply to every element you ship

For each visible element, before commit:

- Can it be removed without losing meaning? → Remove.
- Would a user need to be told this exists? → Redesign until obvious.
- Is visual weight proportional to functional importance? → If not, fix hierarchy.
- Does it feel inevitable? → If not, it's not done.

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

## Don't

- Don't propose vanilla-extract, styled-components, or `@emotion`. The active stacks use **Tailwind + shadcn/ui** (web + Ionic) or **NativeWind + React Native Reusables** (Expo).
- Don't hardcode colours, spacing, sizes — use Tailwind tokens (`bg-primary`, `text-muted-foreground`, `rounded-lg`, …) backed by the shadcn HSL CSS variables (`--background`, `--foreground`, `--primary`, …) defined in `globals.css`.
- Don't add motion that delays user actions.
- Don't ship without states: default, hover, focus, active, disabled, loading, error, empty.
- Don't validate accessibility as a "constraint that limits creativity" — it's a baseline that enables it.
- Don't ship generic centered heroes, decorative card grids, or dashboards that
  do not answer the user's real workflow question.
- Don't accept a design pass without visual QA artifacts or a clear note about
  why screenshots could not be captured.
