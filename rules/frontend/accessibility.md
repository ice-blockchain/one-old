---
paths:
  - "apps/**/src/**"
  - "packages/ui/**"
  - "src/**"
---

# Accessibility — framework-agnostic

WCAG 2.1 AA is the floor. Real-time UIs add their own pitfalls — handle them.
React-specific testing helpers live in `frontend/react/testing.md`.

## Semantic HTML first

- `<button>` for in-page actions; `<a href>` for navigation. Never an interactive `<div>`.
- `<dialog>` (or a focus-trapping modal primitive) for modals.
- `<nav>`, `<main>`, `<header>`, `<footer>`, `<section>`, `<article>` — give the page a real outline.
- `<table>` only for tabular data, with `<caption>` and proper `<th scope>`.

## Localized accessibility copy

- All user-facing text used for accessibility comes from translation keys: visible labels, `aria-label`, `aria-describedby` text, live-region copy, image `alt`, form helper text, errors, and empty states.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
- Keep translation values as complete phrases so screen readers announce natural copy; avoid concatenating translated fragments in JSX.

## Keyboard

- Every interactive element reachable by Tab in document order.
- Visible focus styles. Never `outline: none` without a replacement.
- Match widget role: arrow keys for menus/tabs/listboxes, Esc to close dialogs.
- Skip-link (`Skip to main content`) at the top of every layout.

## Focus management

- Modals trap focus; restore to the trigger on close.
- After route changes, move focus to `<main>` or the new page heading.
- Live regions: `aria-live="polite"` for non-urgent updates (chat, score ticks); `"assertive"` only for critical (errors, payment confirmations).
- Don't move focus on real-time data updates — disorienting.

## Forms

- Every input has a `<label htmlFor>`; placeholder is not a label.
- Group related inputs with `<fieldset>` + `<legend>`.
- Errors: associate via `aria-describedby` and announce with `role="alert"` on first show.
- Disabled fields convey "not now" — explain why nearby. Prefer hidden over disabled when permanent.

## Images & media

- All images: meaningful `alt` text. Decorative: `alt=""`.
- Icon-only buttons: `aria-label` describing the action.
- Video: captions for prerecorded; live captions where available.
- Avoid auto-playing media with sound; if you must, give a visible mute control immediately.

## Colour & contrast

- Text contrast ≥ 4.5:1 (3:1 for ≥18pt or bold ≥14pt).
- Never use colour alone to convey state. Pair with icon, text, or pattern.
- Themes (light/dark): both must pass contrast checks; verify in Storybook.

## Motion

- Respect `prefers-reduced-motion: reduce` — disable parallax, large transforms, looping animations.
- Avoid flashes ≥ 3 per second (seizure risk).
- Game animations: provide a "reduced motion" toggle that's discoverable, not buried.

## Real-time UI gotchas

- Don't yank focus when a frame arrives.
- Live score updates use `aria-live="polite"` with `aria-atomic="true"` so SR users hear the whole new value, not deltas.
- Disable rapid-fire actions (place bet) under reduced motion / slow input — debounce, don't drop.

## Testing

- `@axe-core/playwright` on every E2E spec for the page under test.
- Manual smoke with VoiceOver / NVDA on critical journeys before each release.
- Framework-specific helpers: see `frontend/react/testing.md`.
