---
name: create-native-feature
description: >
  Use PROACTIVELY whenever the user asks to create, add, build, or scaffold a React Native
  feature, mobile module, native flow, Redux slice, RTK Query domain, or Expo app capability.
  Triggers: "create a native feature", "add a mobile feature", "build the RN module",
  "scaffold native functionality", "add mobile CRUD", "React Native feature".
---

# Skill: Create Native Feature

Use this for Expo/React Native feature slices.

Before creating files, state:
1. Feature folder: `apps/mobile/src/features/<name>/`.
2. Files to create: `types.ts`, `api.ts` or `services/`, `hooks/`, `components/`, optional `slice.ts`, `index.ts`.
3. Route/screen files under `apps/mobile/app/` if the feature needs navigation.
4. API endpoints, schemas, and state ownership: RTK Query, Redux slice, zustand, or local state.
5. Tests: reducer/selector/service unit tests, RNTL integration tests, and Maestro flow when critical.

Scaffold rules:
- Server state goes in RTK Query or Redux fed by a WS service.
- UI-only ephemeral state may use zustand.
- Validate external input and responses with zod.
- Do not add native dependencies without the dependency quality gate and Expo Doctor compatibility check.
- Keep route files thin; feature logic lives in the feature folder.
