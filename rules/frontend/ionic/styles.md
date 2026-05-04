---
paths:
  - "apps/**/src/styles/**"
  - "apps/**/src/**/*.css.ts"
  - "packages/ui/**"
  - "src/styles/**"
  - "src/**/*.css.ts"
---

# Ionic Styling Rules

vanilla-extract remains the styling system for React and packaged Ionic mobile
delivery. Ionic CSS variables may be bridged from design tokens only at the app
theme boundary.

## Theme integration

- Source colors, spacing, type, radii, and motion from `@app/design-tokens`.
- Map Ionic CSS variables in a single theme/global style boundary.
- Do not scatter raw `--ion-*` assignments through feature components.
- Support light/dark themes and platform safe-area insets.

## Layout

- Use CSS safe-area env vars for fixed headers, footers, and bottom actions.
- Avoid nested independent scroll containers inside `IonContent` or mobile shell
  layouts unless the interaction is intentionally tested.
- Fixed bottom actions leave room for keyboard, home indicator, and browser-like
  WebView chrome.
- Mobile density should feel native and calm: large enough tap targets, clear
  type hierarchy, restrained borders/fills, and no decorative layers that fight
  the main task.
- Use tokenized responsive spacing to simplify layouts on narrow screens instead
  of shrinking text or cramming desktop controls.

## Must not do

- No Tailwind, NativeWind, styled-components, Emotion, CSS modules, or inline
  `style={{}}`.
- No hardcoded visual values in components.
- No decorative UI that obscures tappable controls on small screens.
- No unverified mobile visual changes. Capture at least one narrow viewport
  screenshot for visual-heavy Ionic/Capacitor work.
