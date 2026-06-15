---
paths:
  - "apps/**/src/services/ws/**"
  - "apps/**/src/features/**/ws/**"
  - "packages/ws-client/**"
  - "**/use*Channel*.ts"
  - "**/use*Channel*.tsx"
---

# React Native Real-time Rules

WebSocket architecture, connection lifecycle, backoff/heartbeat, `wss://`, zod
frame validation, the `requestAnimationFrame` batching / 30 fps cap, and the
in-memory-fake testing matrix are framework-agnostic — see
`rules/frontend/realtime.md`. This file covers only the Expo/React Native delta.

## App lifecycle
- Pause or downgrade non-critical streams when the app backgrounds (`AppState`); resume and reconcile state on foreground.
- Use `startTransition` for non-urgent updates when supported by the current RN version.
