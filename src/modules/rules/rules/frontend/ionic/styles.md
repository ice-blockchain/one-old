---
paths:
  - "apps/**/src/styles/**"
  - "apps/**/tailwind.config.*"
  - "apps/**/postcss.config.*"
  - "packages/ui/**"
  - "src/styles/**"
  - "tailwind.config.*"
  - "postcss.config.*"
---

# Ionic Styling Rules

The Ionic stack styles app content with **Tailwind v3.4 + shadcn/ui**, plus a
small in-repo bridge that maps shadcn HSL CSS variables to Ionic's
`--ion-color-*` tokens so Ionic primitives match the shadcn theme.

## Tailwind config

- `tailwindcss@^3.4` (NOT v4 — the preflight-off Ionic bridge below is
  validated on v3's JS config; this pin is deliberate, do not "upgrade" it to
  match the web stack). Pair with `postcss` and `autoprefixer`.
- `corePlugins.preflight: false` — Tailwind's reset stomps the styling Ionic
  components rely on. Ship your own minimal reset only if needed.
- `content` covers `index.html`, `src/**/*.{ts,tsx}`, and `packages/ui/**`.
- Extend `theme.colors` and `theme.borderRadius` from the shadcn HSL CSS
  variables (`hsl(var(--background))`, `hsl(var(--primary))`, …).

## Theme bridge file

Create exactly one file: `src/styles/ionic-theme-bridge.css`. It is imported
once in `src/main.tsx` (after the Ionic core CSS, before `globals.css`).

The bridge:

1. Defines the shadcn HSL CSS variables in `:root` (light) and `.dark` (dark) —
   mirror the same token set used in `globals.css`, do not fork values.
2. Maps every Ionic `--ion-*` token to the matching shadcn var via
   `hsl(var(--…))` so `IonButton`, `IonHeader`, `IonContent`, `IonTabBar`, etc.
   render in the shadcn palette. Cover at minimum: `--ion-background-color`,
   `--ion-text-color`, `--ion-border-color`, and the `--ion-color-*`
   (+ `-contrast`) families — primary←primary, secondary←secondary,
   tertiary←accent, danger←destructive, medium←muted.
3. Toggles dark mode via Ionic's `.ion-theme-dark` class on `<html>` (Ionic's
   convention) — the same selector also flips the shadcn `.dark` block.

Representative excerpt (extend with project tokens; never hardcode the Ionic
values — always reference the shadcn var):

```css
:root,
.ion-theme-dark {
  --ion-background-color: hsl(var(--background));
  --ion-text-color: hsl(var(--foreground));
  --ion-border-color: hsl(var(--border));
  --ion-color-primary: hsl(var(--primary));
  --ion-color-primary-contrast: hsl(var(--primary-foreground));
  /* …repeat for secondary←secondary, tertiary←accent,
     danger←destructive, medium←muted, each with its -contrast */
}
```

Because the Ionic tokens reference `var(--…)`, redefining the shadcn HSL vars in
the `globals.css` dark block re-evaluates the `--ion-*` tokens automatically.

## className conventions

- Tailwind utility classes for static styling. Merge with `cn()` (= `clsx` +
  `tailwind-merge`). Variants via `class-variance-authority`.
- Pull values via Tailwind tokens (`bg-background`, `text-foreground`,
  `text-muted-foreground`, `rounded-lg`, …) — never hardcode hex / px / rem
  values.
- Platform-specific tweaks via Tailwind variants (`ios:` / `md:`) defined in
  `tailwind.config.ts` `screens` (use a custom variant via
  `addVariant('ios', '.plt-ios &')` and `addVariant('md', '.plt-md &')`).

## Layout

- Use CSS safe-area env vars (`env(safe-area-inset-*)`) for fixed headers,
  footers, and bottom actions.
- Avoid nested independent scroll containers inside `IonContent` or mobile
  shell layouts unless the interaction is intentionally tested.
- Fixed bottom actions leave room for keyboard, home indicator, and
  browser-like WebView chrome.
- Mobile density should feel native and calm: large enough tap targets, clear
  type hierarchy, restrained borders/fills, and no decorative layers that fight
  the main task.
- Use tokenized responsive spacing (Tailwind utilities) to simplify layouts on
  narrow screens instead of shrinking text or cramming desktop controls.

## Prohibited

- No vanilla-extract, `.css.ts`, styled-components, `@emotion`, CSS modules.
- No `@aparajita/tailwind-ionic` (upstream is stale; we own the bridge).
- No raw `--ion-*` assignments scattered through feature components — keep
  them in the bridge file.
- No hardcoded hex / rgb / px values in components when a token exists.
- No inline `style={{ ... }}` for static styling. Inline `style` is reserved
  for dynamic/derived values (animation, computed positioning).
- No decorative UI that obscures tappable controls on small screens.
- No unverified mobile visual changes. Capture at least one narrow viewport
  screenshot for visual-heavy Ionic/Capacitor work.
