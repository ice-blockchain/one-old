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

1. Defines the shadcn HSL CSS variables in `:root` (light) and `.dark` (dark).
2. Maps those vars to Ionic's `--ion-*` tokens so `IonButton`, `IonHeader`,
   `IonContent`, `IonTabBar`, etc. render in the shadcn palette.
3. Toggles dark mode via Ionic's `.ion-theme-dark` class on `<html>` (Ionic's
   convention) — the same selector also flips the shadcn `.dark` block.

Required mappings (extend with project tokens, but do NOT delete these):

```css
:root {
  /* shadcn HSL tokens (mirrors globals.css) */
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --primary: 222.2 47.4% 11.2%;
  --primary-foreground: 210 40% 98%;
  --secondary: 210 40% 96.1%;
  --secondary-foreground: 222.2 47.4% 11.2%;
  --muted: 210 40% 96.1%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --accent: 210 40% 96.1%;
  --accent-foreground: 222.2 47.4% 11.2%;
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 210 40% 98%;
  --border: 214.3 31.8% 91.4%;
  --ring: 222.2 84% 4.9%;
}

:root,
.ion-theme-dark {
  /* Ionic ← shadcn */
  --ion-background-color: hsl(var(--background));
  --ion-text-color: hsl(var(--foreground));
  --ion-border-color: hsl(var(--border));

  --ion-color-primary: hsl(var(--primary));
  --ion-color-primary-contrast: hsl(var(--primary-foreground));
  --ion-color-secondary: hsl(var(--secondary));
  --ion-color-secondary-contrast: hsl(var(--secondary-foreground));
  --ion-color-tertiary: hsl(var(--accent));
  --ion-color-tertiary-contrast: hsl(var(--accent-foreground));
  --ion-color-danger: hsl(var(--destructive));
  --ion-color-danger-contrast: hsl(var(--destructive-foreground));
  --ion-color-medium: hsl(var(--muted));
  --ion-color-medium-contrast: hsl(var(--muted-foreground));
}
```

The dark block in `globals.css` redefines the shadcn HSL vars; the bridge
re-evaluates the Ionic `--ion-*` tokens automatically because they reference
`var(--…)`.

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
