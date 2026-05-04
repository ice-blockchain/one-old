---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use when the user asks to build web components, pages, or applications and the visual direction matters as much as the code quality.
metadata:
  origin: ECC
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

Traffic One precedence: follow this skill only where it does not conflict with Traffic One AGENTS.md and rules/*.md. Forced stack choices, approved libraries, i18n, styling, services, state, testing, accessibility, security, and backend technology rules from Traffic One take precedence. Treat upstream examples that use unapproved frameworks or libraries as conceptual patterns to adapt.

# Frontend Design

Use this when the task is not just "make it work" but "make it look designed."

This skill is for product pages, dashboards, app shells, components, or visual systems that need a clear point of view instead of generic AI-looking UI.

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
strong, coherent aesthetic with a few bold choices.

## Design Workflow

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
product-specific point of view.

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
Traffic One web uses vanilla-extract and `@app/design-tokens`; React Native uses
`StyleSheet.create` and platform-neutral design tokens.

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

Use animation to:

- reveal hierarchy
- stage information
- reinforce user action
- create one or two memorable moments

Do not scatter generic micro-interactions everywhere. One well-directed load sequence is usually stronger than twenty random hover effects.

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
- the result does not read like generic AI UI
- the implementation is production-grade, not just visually interesting
- page-level web output optimizes Lighthouse mobile Performance on a built preview when runnable, with 100 as ideal; if not runnable, page speed is reported as unverified with concrete risks
- screenshot or Storybook verification covers the important breakpoints and states, or the final response explains why it could not be run
