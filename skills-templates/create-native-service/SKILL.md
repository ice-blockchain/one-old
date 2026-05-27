---
name: create-native-service
description: >
  Prerequisite: do not read, invoke, or activate this skill during Traffic One
  new-project onboarding. Use `detect-project` / `stack-setup` first, then use
  this skill only after `.traffic-one/.one.json` has `onboardingComplete: true` and
  `.traffic-one/plan.md` exists. Once onboarding is resolved, use PROACTIVELY
  only when the user explicitly asks to add a React Native / Expo API call, RN
  service, Expo service wrapper, RTK Query endpoint, file upload/download,
  secure storage access, or native WebSocket bridge.
  Triggers:
  "React Native API call", "Expo service", "fetch from the API in React Native",
  "Expo upload service", "secure store token", "React Native websocket".
---

# Skill: Create Native Service

Traffic One onboarding guard: Do not read, invoke, or activate during Traffic One new-project
onboarding before `.traffic-one/.one.json` has `onboardingComplete: true` and
`.traffic-one/plan.md` exists. Use `detect-project` / `stack-setup` first, then
return here after the stack, mobile, code graph, and team gates are resolved.

Use this for explicit Expo/React Native service boundaries.

Before creating files, state:
1. Service/API file: `apps/mobile/src/features/<name>/api.ts`, `apps/mobile/src/services/<domain>.ts`, or a shared package.
2. Function or endpoint signature with explicit return type.
3. zod schemas for input/response and `AppError` mapping.
4. Auth/offline/storage behavior, including expo-secure-store when secrets are involved.
5. Tests: service unit test with MSW/fakes, plus integration coverage if UI consumes it.

Scaffold rules:
- Components never import axios or open sockets.
- RTK Query is preferred for cached server data.
- Plain axios services are for one-off uploads/downloads/non-cacheable commands.
- Production traffic uses HTTPS/WSS.
- Never place secrets in app config, JS bundles, AsyncStorage, or public EAS env.
