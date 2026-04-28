---
name: create-native-feature
description: >
  Use PROACTIVELY only when the user explicitly asks to create, add, build, or
  scaffold a React Native / Expo feature, RN module, native flow, Redux slice,
  RTK Query domain, or Expo app capability. Triggers: "React Native feature",
  "Expo feature", "build the RN module", "React Native CRUD", "Expo app capability".
---

# Skill: Create Native Feature

Use this for explicit Expo/React Native feature slices.

Before creating files, state:
1. Feature folder: `apps/mobile/src/features/<name>/`.
2. Files to create: `types.ts`, `api.ts` or `services/`, `hooks/`, `components/`, optional `slice.ts`, `index.ts`.
3. Route/screen files under `apps/mobile/app/` if the feature needs navigation.
4. API endpoints, schemas, and state ownership: RTK Query, Redux slice, zustand, or local state.
5. Tests: reducer/selector/service unit tests, RNTL integration tests, and Maestro flow when critical.
6. i18n namespace/key pattern and catalog location in `packages/i18n`.
7. Translation consumption in feature UI: `useTranslation`, `t`, or `<Trans>`.

Scaffold rules:
- Server state goes in RTK Query or Redux fed by a WS service.
- UI-only ephemeral state may use zustand.
- Validate external input and responses with zod.
- Do not add native dependencies without the dependency quality gate and Expo Doctor compatibility check.
- Keep route files thin; feature logic lives in the feature folder.
- Feature UI copy, placeholders, validation errors, accessibility labels/hints, and loading/error/empty states use translation keys.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
