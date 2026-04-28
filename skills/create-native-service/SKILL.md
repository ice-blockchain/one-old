---
name: create-native-service
description: >
  Use PROACTIVELY whenever the user asks to add a React Native API call, mobile service,
  Expo service wrapper, RTK Query endpoint, file upload/download, secure storage access,
  or native WebSocket bridge. Triggers: "create a native service", "add a mobile API call",
  "fetch from the API in React Native", "Expo upload service", "secure store token",
  "mobile websocket".
---

# Skill: Create Native Service

Use this for Expo/React Native service boundaries.

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
