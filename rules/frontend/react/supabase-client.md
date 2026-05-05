---
paths:
  - "**/lib/supabase.ts"
  - "**/lib/supabase.tsx"
  - "**/services/supabase.ts"
  - "**/services/supabase.tsx"
  - "apps/**/src/services/**"
  - "packages/api-client/**"
---

# Supabase Client — never crash on missing env

A beginner running `pnpm dev` for the first time should see the app render
immediately, even before they've created their Supabase project. The pattern
below makes that possible: lazy client creation + null-safe fallback +
visible "configure me" banner.

## Hard rules

- **Never call `createClient` at module top level.** A throw at import time
  hard-crashes the whole app — the user can't even see what they're building.
- **Never throw / `process.exit` / `console.error` fatal** when env vars are
  missing. Render the banner instead.
- **Components access Supabase via `getSupabase()`**, never via a top-level
  exported `supabase` constant. If `getSupabase()` returns `null`, render the
  empty / "configure" state.
- **Server keys are server-only.** Never expose `SUPABASE_SERVICE_ROLE_KEY`
  to the client (no `VITE_*` prefix). It belongs in Edge Function secrets or
  a Node service.

## Canonical client (`apps/web/src/lib/supabase.ts` or `packages/api-client/src/supabase.ts`)

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && key);

let cached: SupabaseClient | null = null;

/** Returns null when env vars are missing — callers must handle null. */
export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!cached) {
    cached = createClient(url!, key!, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return cached;
}

/** UI hook — read in components / banners that need to know setup status. */
export function useSupabaseStatus() {
  return {
    isConfigured: isSupabaseConfigured,
    dashboardUrl: "https://supabase.com/dashboard",
    setupSteps: [
      "Create project at supabase.com",
      "Settings → API",
      "Copy Project URL + anon key",
      "Paste into .env.local",
      "Restart pnpm dev",
    ],
  };
}
```

## Required `<EnvBanner />` primitive (`packages/ui/src/EnvBanner/`)

A sticky, dismissible top banner that renders **only** when
`!isSupabaseConfigured`. Mount it in the app shell at the top of `<App />`.

```tsx
import { useSupabaseStatus } from "@app/api-client";

export function EnvBanner() {
  const { isConfigured, dashboardUrl, setupSteps } = useSupabaseStatus();
  if (isConfigured) return null;
  return (
    <aside role="status" aria-live="polite">
      <strong>Supabase not configured.</strong> Run the <code>supabase-setup</code>{" "}
      skill or follow these steps:
      <ol>{setupSteps.map((step) => <li key={step}>{step}</li>)}</ol>
      <a href={dashboardUrl} target="_blank" rel="noreferrer">
        Open Supabase dashboard →
      </a>
    </aside>
  );
}
```

Style it with Tailwind utility classes (`bg-destructive text-destructive-foreground p-3 ...`); promote to a shared `Banner` shadcn primitive once a second consumer appears. The banner is visible on every screen until env vars are filled in.

## Components — graceful empty-state pattern

```tsx
import { getSupabase } from "@app/api-client";

export function PostsList() {
  const supabase = getSupabase();
  if (!supabase) {
    return <ConfigurePromptCard />;     // empty state, not a crash
  }
  // …normal data fetching…
}
```

`ConfigurePromptCard` lives in `packages/ui` and links to the same setup steps.

## Don't

- Don't paper over with `createClient(url ?? "", key ?? "")` — Supabase will
  silently send requests to nowhere; debug experience is worse than the banner.
- Don't read env vars more than once at module load. Vite inlines them at build
  time; runtime checks against `import.meta.env.VITE_*` are stable per build.
- Don't put `getSupabase()` inside a hot render path without memoisation if
  you're calling it 100s of times per second — once per component lifecycle is
  fine.

## When env vars finally land
After the user pastes their keys into `.env.local` and restarts `pnpm dev`,
`isSupabaseConfigured` becomes `true`, the banner unmounts, `getSupabase()`
returns a real client, and components transition from empty-state to live data
on their next render. No code change required.
