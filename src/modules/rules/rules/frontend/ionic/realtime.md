---
paths:
  - "apps/**/src/services/ws/**"
  - "apps/**/src/features/**/realtime/**"
  - "web/**/src/**"
  - "frontend/**/src/**"
  - "client/**/src/**"
  - "packages/**/src/**"
  - "packages/ws-client/**"
  - "src/services/ws/**"
  - "src/features/**/realtime/**"
---

# Ionic Real-time Rules

The shared WebSocket contract — connection ownership in service singletons,
`wss://` in production, validation with the selected schema tool,
`requestAnimationFrame` batching
with a 30 fps non-game cap, connection-state labels (idle/connecting/live/
reconnecting/offline/degraded), and PII-stripped frame logs — lives in
`rules/frontend/realtime.md` and applies in full. Ionic adds the Capacitor app
lifecycle delta below.

## Capacitor lifecycle delta

- No component talks directly to Capacitor network plugins; the real-time
  service owns network awareness.
- Pause, resume, background, and foreground transitions are handled by the
  real-time service.
- On resume from background, reconnect or resync stale channels explicitly.
