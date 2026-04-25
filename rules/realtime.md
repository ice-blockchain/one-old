---
paths:
  - "apps/**/src/services/ws/**"
  - "apps/**/src/features/**/ws/**"
  - "packages/ws-client/**"
  - "**/*.socket.ts"
  - "**/*.ws.ts"
---

# Real-time / WebSocket Rules

Live UIs (gameplay, betting, market data) must stay correct under jittery networks,
back-end blips, and bursty payloads. The rules below are non-negotiable for any code
that opens or consumes a WebSocket.

## Architecture

- **Singleton service per endpoint.** One module owns the connection. Components subscribe via hooks; never instantiate `new WebSocket()` from a component or page.
- **Place it in `packages/ws-client/`** if more than one app uses the same protocol; otherwise `apps/<name>/src/services/ws/`.
- **Three layers**:
  1. *Transport* — opens the socket, handles reconnect/heartbeat, exposes a typed event stream.
  2. *Protocol* — encodes/decodes frames, validates with zod, maps to typed events.
  3. *Bridge* — dispatches Redux actions or pushes to a subscriber registry.

## Connection lifecycle

- **Connect lazily** on the first subscriber, or eagerly on app mount if always needed (game UIs).
- **Heartbeat** with ping every 15–30 s; treat 2 missed pongs as disconnected.
- **Reconnect** with exponential backoff (1 s, 2 s, 5 s, 10 s, capped at 30 s) plus full jitter.
- **Cap retries** but never give up silently — surface a "reconnecting" banner after N attempts and an "offline" state after the cap.
- **Resume cleanly**: on reconnect, send a resume token / last-seen sequence id so the server replays missed frames.

## Back-pressure

- High-rate streams (>10 Hz): aggregate frames in a buffer and flush via `requestAnimationFrame` to Redux. Do not dispatch per frame.
- If the buffer grows beyond a threshold (e.g. 200 frames), drop oldest non-critical frames; never drop ordered messages without reporting it.
- Handle the `bufferedAmount` of the underlying socket — if it grows, throttle outbound sends.

## Consistency

- Every relevant frame carries a sequence id. Drop or reorder out-of-order frames.
- For state that must converge (scoreboard, balance), prefer authoritative snapshots over deltas, or send periodic snapshots to recover from delta drift.
- On reconnect with no resume support: invalidate dependent caches (RTK Query: `api.util.invalidateTags(...)`) and refetch.

## Errors & defensive UI

- Validate every inbound frame with zod before dispatching. A bad frame logs + drops, never crashes the connection.
- Components must render a sensible state for: `idle`, `connecting`, `live`, `reconnecting`, `offline`, `degraded`. Don't conflate `live` with `idle`.
- Use `aria-live="polite"` on the connection status region for assistive tech.

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

## Testing

- Unit-test the protocol layer with deterministic frames.
- Integration-test components against an in-memory WS fake (`packages/test-utils/ws-fake.ts`) that lets the test push frames synchronously.
- Cover the matrix: open, first message, malformed frame, disconnect, reconnect-with-replay, buffer overflow.

## Security

- Always `wss://` in production. Reject `ws://` outside localhost.
- Auth: send the token in the connection URL or first message, never in cookies (CSRF surface).
- Validate origin server-side; client-side cannot enforce this but rules engine must not assume otherwise.
- Strip PII from any client-side logs of frames.
