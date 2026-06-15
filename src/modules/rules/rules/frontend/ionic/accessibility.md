---
paths:
  - "apps/**/src/components/**"
  - "apps/**/src/features/**/components/**"
  - "apps/**/src/pages/**"
  - "packages/ui/**"
  - "src/components/**"
  - "src/features/**/components/**"
  - "src/pages/**"
---

# Ionic Accessibility Rules

The shared WCAG body — contrast, semantic markup, form labelling with
`aria-describedby`, live-region etiquette — is owned by
`rules/frontend/accessibility.md` and is not restated here. This file is the
WebView/Capacitor delta and the canonical home for the Ionic touch-target,
icon-label, focus, and reduced-motion thresholds that `core.md` and
`components.md` point to.

## Touch and focus (canonical for the Ionic stack)

- Interactive targets are at least 44x44 CSS pixels or have equivalent hit area.
- Icon-only buttons have translated accessible labels and visible focus states.
- Respect `prefers-reduced-motion`; avoid gesture-only controls without a
  button/menu alternative.

## WebView / Capacitor delta

- Focus remains visible in WebView and embedded browser contexts (not just the
  desktop browser the base rule assumes).
- Modal, sheet, and popover focus is trapped and restored on close.
- Android back and Escape close the topmost dismissible layer before leaving the
  route — dismissal order is part of the contract, not just "Escape closes".
- Ionic overlays expose accessible names, roles, and dismissal affordances.
