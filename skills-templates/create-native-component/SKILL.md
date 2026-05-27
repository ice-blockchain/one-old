---
name: create-native-component
description: >
  Prerequisite: do not read, invoke, or activate this skill during Traffic One
  new-project onboarding. Use `detect-project` / `stack-setup` first, then use
  this skill only after `.traffic-one/.one.json` has `onboardingComplete: true` and
  `.traffic-one/plan.md` exists. Once onboarding is resolved, use PROACTIVELY
  only when the user explicitly asks to create, add, build, make, scaffold, or
  generate a React Native / Expo component, RN UI element, native screen
  component, card, modal, form, button, list item, or shared React Native
  primitive.
  Triggers: "React Native component", "Expo component",
  "RN UI", "native component in React Native", "React Native form".
  If hooks are absent or auth status is unknown, do not infer "Traffic One inactive";
  ask the auth choice or run doctor, then stop before implementation.
---

# Skill: Create Native Component

## Traffic One Auth Preflight

Before applying this skill, verify Traffic One auth unless the user is explicitly
asking to authenticate, check auth status, log out, or run doctor.

If status is not authenticated, do not apply this skill yet. Present the auth
choice as a host modal selector when available:
- Authenticate Traffic One (Recommended)
- Continue without Traffic One

If hooks are absent or auth status is unknown, do not infer "Traffic One
inactive" and continue. Treat Traffic One as unverified: run or recommend
`node scripts/doctor.cjs` (or `node scripts/doctor.cjs --session <id>` when
debugging a transcript), ask the auth choice, and stop before scaffolding,
installs, source edits, Traffic One agents, or implementation skills. Only
continue ordinary work without Traffic One after the user explicitly chooses
"Continue without Traffic One".

Traffic One onboarding guard: Do not read, invoke, or activate during Traffic One new-project
onboarding before `.traffic-one/.one.json` has `onboardingComplete: true` and
`.traffic-one/plan.md` exists. Use `detect-project` / `stack-setup` first, then
return here after the stack, mobile, code graph, and team gates are resolved.

Use this for explicit Expo/React Native UI. Keep generic mobile variants in
`ionic-mobile` and React web component work in `create-component`.

Before creating files, state:
1. Placement: `apps/mobile/src/components/`, `apps/mobile/src/features/<name>/components/`, or `packages/ui-native/`.
2. Component name and explicit `ComponentNameProps` interface.
3. Whether a React Native Reusables (RNR) primitive already covers the need. If yes, install with `npx @react-native-reusables/cli@latest add <name>` (lands in `packages/ui-native/src/components/ui/`) and compose it; do NOT hand-roll a button / dialog / dropdown / form control.
4. Styling approach: NativeWind utility classes via `className`, merged with `cn()` (= `clsx` + `tailwind-merge`). Variants via `class-variance-authority` (`cva`) for shared primitives.
5. State/data boundary: presentational only, local state, or hook-backed.
6. Native design brief: user goal, primary action, visual direction, density, touch target needs, and required states.
7. Token plan: spacing, typography, color, radius, borders, motion, and safe-area/dynamic-type behavior — pull values from Tailwind tokens (`bg-primary`, `text-muted-foreground`, `rounded-lg`, …) backed by the HSL CSS variables in `global.css`.
8. Tests: colocated RNTL test when the component has interaction or state.
9. i18n namespace/key pattern and catalog location in `packages/i18n`.
10. Translation consumption: `useTranslation`, `t`, or `<Trans>`.
11. Visual QA plan: small phone and larger device screenshots or Storybook/native preview states when available.

Scaffold rules:
- Named export only.
- Compose RNR primitives and React Native primitives (`View`, `Text`, `Pressable`, `TextInput`, `Image`, `FlatList`, `SectionList`).
- Style with NativeWind `className`. No sibling `*.styles.ts` files.
- No DOM tags. No inline `style={{}}` for static styling — Tailwind className only. Inline `style` is reserved for dynamic/animated values (Reanimated worklets, computed positioning).
- No `StyleSheet.create` for static styles. `StyleSheet.create` is only for dynamic/derived stylesheets that NativeWind cannot model.
- No vanilla-extract / `.css.ts` / styled-components / `@emotion`.
- No axios calls inside components.
- Loading/error/empty states are explicit when rendering async data.
- Visible copy, placeholders, accessibility labels/hints, image accessibility copy, and loading/error/empty states use translation keys.
- Accessibility labels/roles are part of the component contract for interactive UI.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
- Do not translate web card grids into native wrappers. Native components must be thumb-friendly, dynamic-type-safe, and visually quiet unless the brief calls for expressiveness.
