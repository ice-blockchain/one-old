---
name: create-native-feature
description: >
  Prerequisite: do not read, invoke, or activate this skill during Traffic One
  new-project onboarding. Use `detect-project` / `stack-setup` first, then use
  this skill only after `.traffic-one.json` has `onboardingComplete: true` and
  `.traffic-one/plan.md` exists. Once onboarding is resolved, use PROACTIVELY
  only when the user explicitly asks to create, add, build, or scaffold a React
  Native / Expo feature, RN module, native flow, Redux slice, RTK Query domain,
  or Expo app capability.
  Triggers: "React Native feature",
  "Expo feature", "build the RN module", "React Native CRUD", "Expo app capability".
  If hooks are absent or auth status is unknown, do not infer "Traffic One inactive";
  ask the auth choice or run doctor, then stop before implementation.
---

# Skill: Create Native Feature

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
onboarding before `.traffic-one.json` has `onboardingComplete: true` and
`.traffic-one/plan.md` exists. Use `detect-project` / `stack-setup` first, then
return here after the stack, mobile, code graph, and team gates are resolved.

Use this for explicit Expo/React Native feature slices.

Before creating files, state:
1. Feature folder: `apps/mobile/src/features/<name>/`.
2. Files to create: `types.ts`, `api.ts` or `services/`, `hooks/`, `components/`, optional `slice.ts`, `index.ts`.
3. Route/screen files under `apps/mobile/app/` if the feature needs navigation.
4. API endpoints, schemas, and state ownership: RTK Query, Redux slice, zustand, or local state.
5. Native design brief: user goal, primary workflow, first-screen hierarchy, CTA placement, density, safe-area/keyboard behavior, and state coverage.
6. Tests: reducer/selector/service unit tests, RNTL integration tests, and Maestro flow when critical.
7. i18n namespace/key pattern and catalog location in `packages/i18n`.
8. Translation consumption in feature UI: `useTranslation`, `t`, or `<Trans>`.
9. Visual QA plan: small phone and larger device screenshots, plus loading/empty/error/offline states.

Scaffold rules:
- Server state goes in RTK Query or Redux fed by a WS service.
- UI-only ephemeral state may use zustand.
- Validate external input and responses with zod.
- Do not add native dependencies without the dependency quality gate and Expo Doctor compatibility check.
- Keep route files thin; feature logic lives in the feature folder.
- Feature UI copy, placeholders, validation errors, accessibility labels/hints, and loading/error/empty states use translation keys.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
- Keep server state in RTK Query/Redux and design the UI around native scan order, touch targets, and dynamic type instead of desktop layout parity.
