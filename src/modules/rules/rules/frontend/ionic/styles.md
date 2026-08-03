---
paths:
  - "apps/**/src/styles/**"
  - "apps/**/src/**/*.css"
  - "web/**/src/**"
  - "frontend/**/src/**"
  - "client/**/src/**"
  - "packages/**/src/**"
  - "src/styles/**"
  - "src/**/*.css"
---

# Ionic Styling Rules

The compiled web profile owns the styling stack. Preserve its design tokens,
CSS strategy, component library, formatter, and framework conventions; an
Ionic/Capacitor overlay never forces Tailwind, shadcn, React CSS imports, or a
different major version of existing tooling.

## Theme bridge

- Add a single theme bridge only when full Ionic UI primitives are selected.
- Map the application's semantic colors, typography, radii, spacing, and
  light/dark state to Ionic `--ion-*` tokens without duplicating source values.
- Import the bridge once at the base framework's compiled entrypoint or global
  style boundary.
- Keep Ionic core CSS ordering compatible with the matching React, Vue, or
  Angular adapter. Do not invent a React `main.tsx` path for another profile.
- Create or change the bridge/config only when its exact path is present in the
  compiled assignment. Otherwise request a recompile.

## Layout and platform behavior

- Respect safe-area insets for fixed headers, tab bars, sheets, and bottom
  actions.
- Keep one scroll container per screen; verify nested overlays and keyboard
  resizing on both requested platforms.
- Use semantic design tokens instead of raw platform-specific colors.
- Platform-specific adjustments stay narrow and documented; the shared web
  application remains the source of truth.

## Validation

- Verify light/dark parity, focus visibility, reduced motion, dynamic text,
  keyboard overlap, and no horizontal overflow in the web preview.
- Packaging changes also require the requested emulator/device smoke evidence
  described by `rules/frontend/ionic/testing.md`.
