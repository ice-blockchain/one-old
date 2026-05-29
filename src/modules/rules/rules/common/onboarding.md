---
# Always loaded
---

# Traffic One Onboarding

How to conduct Traffic One onboarding and write `.traffic-one/.one.json`. The
SessionStart hook reads that file to decide which rules to inject; the PostToolUse
hook (`scripts/hook-runtime.cjs post-stack-setup`) auto-loads the matching bundle
the moment the file is written — no session restart required. The setup gate
(`rules/common/setup-gate.md`) defines when work is blocked; project routing
(`rules/common/project-routing.md`) defines mode/stack detection.

## When onboarding runs

### New project (sales-pitch onboarding)
When SessionStart shows the `FIRST-RUN ONBOARDING (new project)` directive, that
directive contains the full pitch script and is the source of truth. Run
onboarding in the current thread before asking implementation questions or
writing files. Use the host popup/input mechanism when available; if it is
unavailable, ask the same next unresolved question in chat and stop for the
user's typed answer.

Current-thread fallback: if the host's interactive prompt tool cannot be called,
the fallback is the next visible assistant response before any tool use — ask the
OpenCode opt-in (`1. Enable OpenCode delegation`, `2. Not now`), tell the user to
reply with the option number or label, and stop. Then ask Agent Mode, Team
Confirmation only for High/Balanced, project context, Mobile App, then Code
Graph.

### Mid-project reconfigure
When the user says "switch stack", "change stack", "reconfigure", "redo setup",
etc., read the existing `.traffic-one/.one.json`, ask only what they want to
change, preserve `mode`, and bump `confirmedAt`. Same write target, same
auto-load behaviour.

### Existing project on first session
For existing codebases the SessionStart hook does detection itself (scans
`package.json` deps + workspace config) and writes `.traffic-one/.one.json`
without new-project Q&A. After shared state is detected or written, the current
user still must complete local preferences for that target root before
implementation: OpenCode, Performance, Team Confirmation for High/Balanced, then
Code Graph. Existing projects do not ask MVP context or Mobile App prompts.

## Stack ids (the only valid values)

- `minimal` — no backend and no frontend framework necessary; simple
  landing/presentation/static projects.
- `default` — React/Vite frontend with Supabase backend. **Default for complex
  backend-backed projects.**
- `custom-frontend` — complex project with a non-default or mobile-only frontend;
  backend defaults to Supabase when unspecified.
- `custom-backend` — React/Vite frontend with a non-Supabase backend, external
  API, or no backend.
- `custom-stack` — non-default frontend/mobile choice plus non-Supabase backend.

Legacy ids (`react-realtime-monorepo`, `react-frontend-only`,
`react-native-expo-*`, `node-backend`) are normalized by hooks for old projects;
do not write them during onboarding or reconfigure.

Recommend `stack: "default"`, `frontend: "react-vite"`, and `backend: "supabase"`
first for new complex projects. If the user explicitly chooses another frontend
or backend, or an existing repo already uses one, use the matching
`custom-frontend`, `custom-backend`, or `custom-stack` state and load only the
selected technology rules.

## Onboarding order

When the resolved project mode is `new-project` (`mode === "new-project"`),
onboarding is mandatory until the choices are answered and the project plan is
ready. Run it in the current thread, using popup/input tools when available and
plain-chat fallback when they are not. OpenCode is the first prompt before
Performance.

Onboarding choices must use the host's prompt popup when available, not prose with
numbered options. When that tool is available, call it and
stop; do not print `Options:` in chat. Plain-text fallback is allowed only when
the popup tool is unavailable: ask the same blocking question in chat with
numbered options, tell the user to reply with the option number or label, and
stop. Do not choose a default, infer an answer, write `.traffic-one/.one.json`,
scaffold, or continue while an onboarding answer is pending.

Ask onboarding prompts in this order and stop after each unresolved answer:

1. OpenCode delegation opt-in: `Enable OpenCode delegation` or `Not now`.
2. Agent Mode / Performance: `High (Recommended)`, `Balanced`, or `Low`.
3. Team Confirmation for `High` / `Balanced`: show every role/tier/model row and
   wait for explicit `Approve`; skip this for `Low`.
4. Show: "Traffic One was successfully set up. Let's collect the project details
   next."
5. Ask one rich, dynamic MVP-context questionnaire based on the user's original
   request and save `projectContext` with `source`, `originalPrompt`, `summary`,
   `answers`, and `collectedAt`. Cover audience, core flows, v1 features,
   roles/auth, data model, admin/ops needs, business model, payments when
   applicable, integrations, content/data source, engagement, success metrics,
   constraints, visual/product tone, and domain-specific questions. Ask
   admin-area questions when the app has managed content/users/transactions/
   moderation/reporting/operations even if the user did not ask for admin.
6. Ask the mobile decision. If the user already asked for
   mobile/iOS/Android/Ionic/Capacitor/React Native/Expo/RN, web only, Next.js,
   frontend-only, no backend, no subagents, or "just build it", treat that as
   implementation intent rather than an onboarding answer. Use the host's prompt
   tool as a popup:

- header: `Mobile App`
- question: `Do you want a mobile app too?`
- options:
  - `Web only (Recommended)` — keep v1 to the responsive web/admin app.
  - `Ionic + Capacitor` — add the default hybrid iOS/Android app path.
  - `React Native / Expo` — add an explicit React Native/Expo app stack.

If the popup tool is unavailable, ask the same question in plain text with the
same numbered options and stop for the user's typed reply. The popup or typed
answer is the source of truth for `mobile.framework`; do not infer it from the
original prompt.

## Stack lock rule

Once `.traffic-one/.one.json` and `.traffic-one/stack.md` exist, treat them as the
project's locked stack. Do not suggest alternate frameworks, package managers,
databases, auth providers, test runners, or deploy targets unless the user asks
to reconfigure or an existing tool is impossible to use. If a locked choice looks
harmful, flag the concern but continue with the selected stack until the user
explicitly changes it.

## Backend values

`supabase` (default for the recommended stack) · `self-hosted` · `managed` ·
`other` · `external-api` (frontend-only) · `none` (minimal)

When the user describes a new product with auth, profiles, CRUD records, jobs,
applications, uploads/files, real-time updates, dashboards backed by user data, or
other durable user-owned data, select `backend: "supabase"` by default. Do not
present it as something to bolt on later unless the user explicitly asks for a
frontend-only prototype or rejects Supabase.

## Realtime values

`heavy` · `light` · `none`

## codeGraphProvider — REQUIRED (no skip, no default)

`gitnexus` · `graphify`

After the mobile popup is answered, ask this provider choice. Use the host's
prompt tool as a popup:

- header: `Code Graph`
- question: `Which provider should we use for the codebase graph?`
- options:
  - `GitNexus` — Node CLI; writes `.gitnexus/`; PolyForm Noncommercial; requires
    Node >=22.
  - `graphify` — Python CLI; writes `graphify-out/GRAPH_REPORT.md` + `graph.json`;
    MIT license.

If the popup tool is unavailable, ask the user verbatim with numbered options and
stop for the user's typed reply:

> Which provider should we use for the codebase graph: **gitnexus** or
> **graphify**? Both build a structural cache that subagents and skills read
> before falling back to `Glob`/`Grep`. Estimated 50–70% lower cross-session
> token usage and noticeably better cross-file refactor / "where does X live"
> answers.
>
> - **gitnexus** — Node CLI (`npm install -g gitnexus`); writes `.gitnexus/`.
>   **License: PolyForm Noncommercial — only usable on non-commercial projects.**
>   Optionally serves an MCP server for richer queries.
> - **graphify** — Python CLI (`pipx install graphifyy`); writes
>   `graphify-out/GRAPH_REPORT.md` + `graph.json`. **License: MIT.**

Treat the answer as required. Do NOT write `.traffic-one/.one.json` with
`codeGraphProvider` absent. If the user expresses uncertainty, explain the
license trade-off above; do not default-pick. List `gitnexus` first — do not add
a "(Recommended)" tag.

## File shape (write exactly this with the Write tool)

The schema is required for new projects: `mode`, `stack`, `frontend`, `backend`,
`projectContext`, `mobile`, `technologies`, `realtime`, `codeGraphProvider`,
`openCode`, `performance`, `team`, `toolchain`, `confirmed`, `onboardingComplete`,
`confirmedAt` (`version` is the current Traffic One plugin version; do not write a
separate `pluginVersion` field). `mobile.source` is an exact enum: use `prompted`
for the required Mobile App popup/chat answer, `explicit` for an explicit mobile
request, and `none` only when no mobile decision has been collected. Do not write
descriptive variants. `performance.level` is the source of truth for
cost/quality. `high` and `balanced` require the Team Confirmation popup and must
include `team.approved: true` only after the user explicitly approves the
role/tier/model line-up. `team.mode` is the source of truth for orchestration
after onboarding: `subagents` means the parent/orchestrator must spawn the named
senior-role agents and must not write feature source itself; `main-agent` means
the same role phases are simulated manually in the current thread. Use
`team.source: "prompted"` for the Team Confirmation popup/chat answer.

```json
{
  "version": "<current-plugin-version>",
  "mode": "<existing mode if reconfiguring; otherwise 'new-project'>",
  "stack": "<chosen id>",
  "frontend": "<chosen frontend>",
  "backend": "<chosen backend>",
  "projectContext": {
    "source": "prompted",
    "originalPrompt": "<user's original request>",
    "summary": "<short product summary>",
    "answers": {},
    "collectedAt": "<ISO-8601 UTC>"
  },
  "mobile": { "enabled": false, "framework": "none", "source": "<explicit|prompted|none>" },
  "technologies": { "frontend": [], "backend": [], "mobile": [] },
  "realtime": "<heavy|light|none>",
  "codeGraphProvider": "<gitnexus|graphify>",
  "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" },
  "performance": { "level": "<low|balanced|high>", "source": "prompted" },
  "team": { "mode": "<subagents|main-agent>", "source": "prompted", "approved": true },
  "toolchain": {
    "gitnexus": { "installedVersion": null, "installedAt": null },
    "graphify": { "installedVersion": null, "installedAt": null },
    "gitleaks": { "installedVersion": null, "installedAt": null },
    "trufflehog": { "installedVersion": null, "installedAt": null }
  },
  "confirmed": true,
  "onboardingComplete": true,
  "confirmedAt": "<ISO-8601 UTC>"
}
```

## After writing

Reply with ONE short line confirming the choice and continuing with the user's
original request:

> "Saved — using `<stack>` (backend `<backend>`, realtime `<realtime>`, graph `<codeGraphProvider>`). Continuing with your build."

The generic post-tool hook converges the project immediately after any host tool
event once the complete state exists. You'll see either `traffic-one rules loaded
for stack: <id>` or `project-local rules/skills materialized` in a system message
before your next action — those rules are now live, use them.

If the host runtime does not emit a post-tool hook, or you are repairing a state
file written by another agent, run the materializer from the project root before
feature work:

```bash
node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime.cjs" materialize-project
```

Do not continue until `.traffic-one/.one.json` has `version`, `materializedStack`,
`materializedAt`, and `materializedVersion`, and the project has
`.traffic-one/rules/**`, `.traffic-one/manifest.json`, `.traffic-one/skills/**`,
root `AGENTS.md`, and root `CLAUDE.md`. Do not write the `materialized*` fields
manually; they are valid only when the materializer wrote those generated
project-local assets.

After that system message, the next scaffold action for `mode: "new-project"`
must read and follow `rules/modes/new-project.md`. For `stack: "default"` or a
React/Vite new project with backend data, do not create a flat/root Vite app: no
root `src/`, root `index.html`, root `vite.config.ts`, or root `package.json`
without pnpm workspaces. Scaffold the Turborepo workspace (`apps/web` plus
required `packages/*`) before any feature code.

## Must-not-do

- Do NOT tell the user to restart the host. The PostToolUse hook handles
  loading.
- Do NOT ask the user to edit JSON.
- Do NOT use stack ids that aren't listed above.
- Do NOT change `mode` during a reconfigure.
- Do NOT proceed with feature work or other skills while onboarding is
  incomplete.
- Do NOT omit `codeGraphProvider`. The `runPostStackSetup` hook emits a blocking
  warning until the field is present and set to `gitnexus` or `graphify`.
