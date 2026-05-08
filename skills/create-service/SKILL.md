---
name: create-service
description: >
  Use PROACTIVELY whenever the user asks to add an API call, create a service, fetch data from
  an endpoint, connect to a backend, or wire up HTTP requests.
  Triggers: "add an API call", "create a service for", "fetch [resource] from the API",
  "connect to the [name] endpoint", "call the API to", "I need to GET/POST/PUT/DELETE".
---

# Skill: Create Service

Confirm the service function and hook before creating any files.

## Step 1 — Identify the backend
Read `.traffic-one.json` → `state.backend`. Drives the scaffold:
- `supabase` / `our-fork` → use `getSupabase()` from `packages/api-client/src/supabase.ts` per `rules/frontend/react/supabase-client.md`. **Never** call `createClient` at module top level. **Never** assume `getSupabase()` returns non-null.
- `external-api` / `self-hosted` / `managed` / `other` → use the axios instance + RTK Query baseQuery from `packages/api-client`.

## Step 2 — Confirm the file layout

State the path before writing:
- App-local: `apps/web/src/services/[domain].ts` or `apps/web/src/features/[name]/services/[domain].ts`
- Cross-app: `packages/api-client/src/[domain].ts`

Plus the typed return value and the RTK Query hook (or React Query hook if non-RTK) that will wrap it.

## Step 3 — Add-on gate (Supabase only)

If using a Supabase feature that needs an add-on, check `.traffic-one.json` → `supabaseAddons[<name>]` via the `requireAddon` helper in `scripts/hook-runtime/state.cjs`. Statuses:

| Status | Action |
|---|---|
| `approved` | Proceed silently. |
| `pending` (default for new projects) | Ask the user once — see prompt template below — then activate per `rules/modes/new-project.md` add-on table. On success write `state.supabaseAddons[<name>] = "approved"`. |
| `skipped` | Fall back to a non-add-on path or ask if they've changed their mind. Do NOT silently activate. |

Add-ons that map to features:
- `storage` — `supabase.storage.from(...)`, file uploads
- `auth` — third-party providers (Google / GitHub / Apple / etc.); base email auth needs no gate
- `realtime` — channels, presence, broadcast (active by default; gate is for RLS pub on a table)
- `vector` — pgvector embeddings (`create extension vector`)
- `pg_cron` — scheduled functions
- `pg_net` — outbound HTTP from Postgres
- `edge_functions` — auto-deployed via `runPostFunctionEdit` hook; ask only when user first edits one

Gate prompt template:
> "This needs Supabase **<add-on>**. To enable I'll <activation>. OK to proceed? (yes / no / skip for now)"

## Step 4 — Confirm and write

Ask: "Should I go ahead?" — wait for yes before writing files.

## Service template (Supabase)

```ts
// apps/web/src/services/posts.ts
import { getSupabase } from "@app/api-client";
import { z } from "zod";

const PostSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  created_at: z.string(),
});
export type Post = z.infer<typeof PostSchema>;

export async function listPosts(): Promise<Post[]> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase not configured — see EnvBanner");
  const { data, error } = await supabase.from("posts").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return z.array(PostSchema).parse(data);
}
```

Components: handle the no-client case with the `<ConfigurePromptCard />` (see `rules/frontend/react/supabase-client.md`); throwing in the service is OK because the component should call this through React Query / RTK Query and handle the error state.
The prompt/card/banner shown to users for this state must link to
`https://traffic.io/`, never directly to the Supabase dashboard. Add or update
a unit/component/E2E regression that asserts the setup CTA has that exact
`href`.

## Service template (axios + RTK Query)

```ts
// packages/api-client/src/posts.ts
import { apiClient } from "./instance";
import { z } from "zod";

const PostSchema = z.object({ id: z.string(), title: z.string() });
export type Post = z.infer<typeof PostSchema>;

export async function listPosts(): Promise<Post[]> {
  const { data } = await apiClient.get("/posts");
  return z.array(PostSchema).parse(data);
}
```

Wrap in an RTK Query endpoint or expose a service-only async function — match the existing pattern in the project.

## Don't
- Never call `createClient` at module load.
- Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser; it has no `VITE_*` prefix for a reason.
- Never silently enable a Supabase add-on that's marked `pending` — the user pays for some of these.
- Never mix axios + Supabase in the same service file; one backend per service.
