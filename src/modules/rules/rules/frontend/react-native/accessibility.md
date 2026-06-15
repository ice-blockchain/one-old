---
paths:
  - "apps/**/app/**"
  - "apps/**/src/components/**"
  - "apps/**/src/features/**/components/**"
  - "packages/ui-native/**"
  - "src/components/**"
  - "src/features/**/components/**"
---

# React Native Accessibility Rules

WCAG floor, colour/contrast, reduced motion, flash limits, focus management, and
localized accessibility copy are the framework-agnostic contract in
`rules/frontend/accessibility.md`. This file is the native delta only.

## Screen readers (VoiceOver / TalkBack)
- Support VoiceOver and TalkBack for every critical journey.
- Interactive controls expose `accessibilityRole`, `accessibilityLabel`, and
  `accessibilityState` where needed; icon-only controls always carry a label.
- Hide decorative images from assistive tech (`accessibilityElementsHidden` /
  `importantForAccessibility="no"`); label meaningful images.

## Touch and focus
- Minimum touch target: 44x44 points; use `hitSlop` for compact controls.
- Manage focus after modals, auth redirects, and destructive confirmations; do
  not move focus on real-time updates.

## Dynamic type
- Respect dynamic type; do not lock text into fixed-height containers. Use
  `numberOfLines` only when truncation is intentional.

## Testing
- RNTL tests assert roles/labels for important controls.
- Maestro flows prefer accessibility selectors where possible.
- Release smoke includes manual VoiceOver/TalkBack checks for login and the primary flow.
