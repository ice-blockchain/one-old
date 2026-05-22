---
name: frontend-design
description: >
  Prerequisite: do not read, invoke, or activate this skill during Traffic One
  new-project onboarding. Use `detect-project` / `stack-setup` first, then use
  this skill only after `.traffic-one.json` has `onboardingComplete: true` and
  `.traffic-one/plan.md` exists. Once onboarding is resolved, create
  distinctive, production-grade frontend interfaces with high design quality.
  Use when the user asks to build web components, pages, or applications and
  the visual direction matters as much as the code quality.
  If hooks are absent or auth status is unknown, do not infer "Traffic One inactive";
  ask the auth choice or run doctor, then stop before implementation.
metadata:
  source: everything-claude-code
  source_path: skills/frontend-design/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

Traffic One precedence: follow this skill only where it does not conflict with Traffic One AGENTS.md and rules/*.md. Forced stack choices, approved libraries, i18n, styling, services, state, testing, accessibility, security, and backend technology rules from Traffic One take precedence.

## Traffic One Auth Preflight

Before applying this skill, verify Traffic One auth unless the user is explicitly
asking to authenticate, check auth status, log out, or run doctor.

If status is not authenticated, do not apply this skill yet. Present the auth
choice as a host modal selector when available:
- Authenticate Traffic One (Recommended)
- Continue without Traffic One

If the user chooses Authenticate Traffic One, ask for the API key and run the
authentication command internally with `TRAFFIC_ONE_AUTH_KEY`; then verify status
internally. Internally means: invoke `scripts/traffic-one-auth.cjs login` (then
`status`) through your own Bash tool with `TRAFFIC_ONE_AUTH_KEY=<key>` in env —
the pre-tool gate explicitly bypasses `scripts/traffic-one-auth.cjs (login|status|logout)`
shell invocations even while unauthenticated. Do not Write or Edit `auth.json`
directly; only the script can mint a valid session token.
Do not ask the user to run bash or shell commands. If the user chooses
Continue without Traffic One, continue the user's request without Traffic One
features and do not repeat the auth prompt while that choice remains active.
Stop and wait for the choice or API key as appropriate. Do not ask Traffic One
onboarding questions, write `.traffic-one.json`, create `.traffic-one/`, run
Traffic One agents, or use Traffic One reporting unless the user authenticates.

If hooks are absent or auth status is unknown, do not infer "Traffic One
inactive" and continue. Treat Traffic One as unverified: run or recommend
`node scripts/doctor.cjs` (or `node scripts/doctor.cjs --session <id>` when
debugging a transcript), ask the auth choice, and stop before scaffolding,
installs, source edits, Traffic One agents, or implementation skills. Only
continue ordinary work without Traffic One after the user explicitly chooses
"Continue without Traffic One".

Traffic One onboarding guard: Do not read, invoke, or activate during Traffic One new-project
onboarding before `.traffic-one.json` has `onboardingComplete: true` and
`.traffic-one/plan.md` exists. Use `detect-project` / `stack-setup` first, then
return here after the stack, mobile, code graph, and team gates are resolved.

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

### 0. Reference real products before designing

Before opening the editor, if the user has not already named websites,
competitors, or design references, ask which websites/designs they want to
emulate and explicitly offer to analyze 2–3 competitors yourself. If the user
chooses self-analysis or has already delegated visual direction, pick
**2–3 best-in-class real products** in the same domain (Linear, Vercel, Stripe
Dashboard, Notion, Arc, Things, Figma, Pitch, Raycast, Posthog, Resend,
ramp.com, etc. — match the vertical). Note, in one or two lines each:

- Mobile nav style (drawer, bottom tabs, segmented).
- Type pairing and density.
- Motion language (snappy, restrained, expressive).
- Interaction model (filters, command menus, inline editing, optimistic states).
- Surface treatment (borders vs subtle fills vs neon accent).
- One specific thing each does well that fits this product.

The goal is "looks like a real product team shipped this", not "looks like an
LLM generated this." Skip this step only when extending an existing in-app
aesthetic. State the chosen references so the visual direction is auditable.

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
- page-speed budget for the first screen: media weight, font choices, motion cost, dependency splits, and Lighthouse mobile Performance optimized toward 100

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

Use the project's token system so the interface stays coherent as it grows.
Traffic One web (and Ionic) uses **Tailwind v3.4 + shadcn/ui** with HSL CSS
variables in `globals.css` (themed via the preset in `packages/tailwind-config`);
React Native uses **NativeWind v4 + React Native Reusables** with the same HSL
CSS-variable theme block in `global.css`. Reference values via Tailwind tokens
(`bg-primary`, `text-muted-foreground`, `rounded-lg`, …); never hardcode.

When live backend credentials are missing, keep the first screen useful: render
one shared setup banner at the app boundary, then show polished demo/seeded or
empty/degraded states for the actual workflow. Do not repeat the same
configuration CTA in multiple banners/cards on one page, and do not leave the
screen as only filters, blank panels, or "not configured" alerts.

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
`tailwindcss-animate` already covers shadcn primitive transitions.

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

## Anti-Patterns

Never default to:

- interchangeable SaaS hero sections
- generic card piles with no hierarchy
- random accent colors without a system
- placeholder-feeling typography
- motion that exists only because animation was easy to add

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
- page-level web output optimizes Lighthouse mobile Performance on a built preview when runnable, with 100 as ideal; if not runnable, page speed is reported as unverified with concrete risks
- screenshot or Storybook verification covers the important breakpoints and states, or the final response explains why it could not be run
