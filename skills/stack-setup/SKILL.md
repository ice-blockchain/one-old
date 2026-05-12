---
name: stack-setup
description: PROACTIVELY drive the traffic-one onboarding when SessionStart shows the "FIRST-RUN ONBOARDING" directive (new project, no auto-detection possible) — pitch our stack and write `.traffic-one.json` based on the user's first message. Also TRIGGER when the user says "change stack", "switch stack", "reconfigure", "redo setup", "use a different stack", "I picked the wrong one". For existing projects with a detectable stack, the SessionStart hook auto-writes `.traffic-one.json` itself — this skill is NOT needed there.
---

# traffic-one Stack Setup

Persist the user's rule-stack choice into `.traffic-one.json`. The SessionStart
hook reads this to decide which rules to inject. The PostToolUse hook
(`scripts/hook-runtime.cjs post-stack-setup`) auto-loads the matching bundle the moment the
file is written — **no session restart required**.

## When this skill fires

### Path A — New project, sales-pitch onboarding
SessionStart shows `═══ traffic-one — FIRST-RUN ONBOARDING (new project) ═══`.
The directive itself contains the full pitch script (paths A "features only"
and B "tech specified"). Follow it. The directive is the source of truth — this
skill exists so the user can also invoke it explicitly ("set up the stack").

### Path B — Mid-project reconfigure
User says "switch stack", "change stack", "reconfigure", etc. Read the existing
`.traffic-one.json`, ask only what they want to change, preserve `mode`, bump
`confirmedAt`. Same write target, same auto-load behaviour.

### NOT this skill: existing project on first session
For existing codebases the SessionStart hook does the detection itself
(scans `package.json` deps + workspace config) and writes `.traffic-one.json`
without any Q&A. Don't trigger here. The user only sees a one-line confirmation
on the model's first reply (auto-detected stack: X, backend: Y, realtime: Z).

## Stack ids (the only valid values)

- `react-realtime-monorepo` — React + Supabase monorepo. **Default for new projects.**
- `react-frontend-only` — Single React app, no monorepo.
- `react-native-expo-monorepo` — Expo RN monorepo. Only when user explicitly says React Native / Expo.
- `react-native-expo-app` — Single Expo RN app. Same condition.
- `minimal` — clean-code + security baseline, language-agnostic.

`node-backend` exists for backwards compatibility with old config files. **Do
not offer it during onboarding or reconfigure** — backends now live alongside a
frontend stack via the `backend` field.

Next.js is not a first-class Traffic One stack id. If the user explicitly wants
Next.js after the React/Vite pitch, use `stack: "minimal"` and add
`"frontend": "nextjs"` so provider-first Next.js recommendations apply.

## Stack lock rule

Once `.traffic-one.json` and `.traffic-one/stack.md` exist, treat them as the
project's locked stack. Do not suggest alternate frameworks, package managers,
databases, auth providers, test runners, or deploy targets unless the user asks
to reconfigure or an existing tool is impossible to use. If a locked choice
looks harmful, flag the concern, but continue with the selected stack until the
user explicitly changes it.

## Backend values

`supabase` (default for our recommended stack) · `self-hosted` · `managed`
· `other` · `external-api` (frontend-only) · `none` (minimal)

When the user describes a new product with auth, profiles, CRUD records, jobs,
applications, uploads/files, real-time updates, dashboards backed by user data,
or other durable user-owned data, select `backend: "supabase"` by default. Do
not present it as something to bolt on later unless the user explicitly asks for
a frontend-only prototype or rejects Supabase.

## Realtime values

`heavy` · `light` · `none`

## codeGraphProvider — REQUIRED (no skip, no default)

`gitnexus` · `graphify`

Ask the user verbatim:

> Which provider should we use for the codebase graph: **gitnexus** or
> **graphify**? Both build a structural cache that subagents and skills read
> before falling back to `Glob`/`Grep`. Estimated 50–70% lower cross-session
> token usage and noticeably better cross-file refactor / "where does X live"
> answers.
>
> - **gitnexus** — Node CLI (`npm install -g gitnexus`); writes
>   `.gitnexus/`. **License: PolyForm Noncommercial — only usable on
>   non-commercial projects.** Optionally serves an MCP server for richer
>   queries.
> - **graphify** — Python CLI (`pipx install graphifyy`); writes
>   `graphify-out/GRAPH_REPORT.md` + `graph.json`. **License: MIT.**

Treat the answer as required. Do NOT write `.traffic-one.json` with
`codeGraphProvider` absent. If the user expresses uncertainty, explain the
license trade-off above; do not default-pick. List `gitnexus` first — do
not add a "(Recommended)" tag.

## File shape (write exactly this with the Write tool)

The schema is **8 required fields** for new projects: `mode`, `stack`,
`backend`, `realtime`, `codeGraphProvider`, `confirmed`,
`onboardingComplete`, `confirmedAt` (`version` makes 9 with bookkeeping).

```json
{
  "version": 2,
  "mode": "<existing mode if reconfiguring; otherwise 'new-project'>",
  "stack": "<chosen id>",
  "backend": "<chosen backend>",
  "realtime": "<heavy|light|none>",
  "codeGraphProvider": "<gitnexus|graphify>",
  "confirmed": true,
  "onboardingComplete": true,
  "confirmedAt": "<ISO-8601 UTC>"
}
```

If the user explicitly chose Next.js, add `"frontend": "nextjs"` and use
`"stack": "minimal"`. Otherwise omit `frontend`.

## After writing

Reply with ONE short line confirming the choice and continuing with the user's
original request:

> "Saved — using `<stack>` (backend `<backend>`, realtime `<realtime>`, graph `<codeGraphProvider>`). Continuing with your build."

The PostToolUse hook injects the full stack rules into THIS session immediately.
You'll see `traffic-one rules loaded for stack: <id>` in a system message
before your next action — those rules are now live, use them.

## Must-not-do
- Do NOT tell the user to restart Claude Code. The PostToolUse hook handles loading.
- Do NOT ask the user to edit JSON.
- Do NOT use stack ids that aren't listed above.
- Do NOT change `mode` during a reconfigure.
- Do NOT proceed with feature work or other skills while onboarding is incomplete.
- Do NOT omit `codeGraphProvider`. The `runPostStackSetup` hook will emit a
  blocking warning until the field is present and set to `gitnexus` or
  `graphify`.
