---
paths:
  - "apps/**/src/services/ws/**"
  - "apps/**/src/features/**/ws/**"
  - "packages/ws-client/**"
  - "**/use*Channel*.ts"
  - "**/use*Channel*.tsx"
---

# React Real-time — subscription hooks + Redux bridge

Framework-agnostic WebSocket architecture (transport / protocol / bridge, lifecycle,
back-pressure, consistency, security) lives in `frontend/realtime.md`. This file covers
React-specific patterns.

## Subscription hooks

```ts
// good — components subscribe through a hook, the singleton owns the socket
const { phase, balance } = useGameTick(gameId);

// bad — never do this inside a component
useEffect(() => {
  const ws = new WebSocket("wss://…");
  // …
}, []);
```

- The hook returns a snapshot of relevant state and unsubscribes on unmount.
- Multiple components subscribing to the same channel share the same socket — no duplicate connections.
- Hooks live in `packages/ws-client/src/hooks.ts` (shared) or `apps/<n>/src/features/<feature>/ws/use<Thing>.ts` (app-specific).
- Keep hook output stable: derive minimal state, pre-select via the bridge so React doesn't churn.

## Redux bridge (the recommended pattern)

- A WS service module dispatches Redux actions on relevant frames.
- Components read derived state via selectors — they never touch the socket directly.

```ts
// packages/ws-client/src/redux-bridge.ts
import type { Middleware } from "@reduxjs/toolkit";

export const wsBridge: Middleware = (store) => {
  const transport = createTransport({
    onFrame: (frame) => {
      const decoded = ProtocolSchema.safeParse(frame);
      if (!decoded.success) return;
      // route to slices via discriminated kind
      switch (decoded.data.kind) {
        case "gameTick":   return store.dispatch(gameTickReceived(decoded.data));
        case "oddsUpdate": return store.dispatch(oddsUpdated(decoded.data));
      }
    },
    onStatusChange: (status) => store.dispatch(connectionStatusChanged(status)),
  });
  return (next) => (action) => {
    if (sendFrame.match(action)) transport.send(action.payload);
    return next(action);
  };
};
```

## Subscription via `useSyncExternalStore` (low-level, when not using Redux)

For app-local channels that don't need to live in Redux:

```ts
export function useChannel<T>(name: string, decoder: (frame: unknown) => T): T | null {
  return useSyncExternalStore(
    (cb) => channelRegistry.subscribe(name, cb),
    () => channelRegistry.snapshot<T>(name),
    () => null,
  );
}
```

- `getServerSnapshot` returns `null` (or a safe default) — never the live value.
- The registry is a module-level singleton; tests inject a fake via DI.

## Render rate

- Hook output should change at most ~30× / second for non-game UIs (60× for canvases).
- Apply `requestAnimationFrame` batching in the bridge or hook adapter — see `frontend/performance.md`.

## Testing

- Wrap render with `renderWithProviders` (see `frontend/react/testing.md`) where the store has the WS bridge middleware wired to the in-memory fake.
- Push frames synchronously and `await screen.findByText(...)`.
- Cover: connect → first message, disconnect → reconnecting banner visible, malformed frame ignored, reconnect-with-replay → state converges.
