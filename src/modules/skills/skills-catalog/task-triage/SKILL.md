---
name: task-triage
description: "Post-build maintenance triage: classify each request by complexity and scale the machinery — trivial → cheap quick-fix worker, small → single role, complex → orchestrator run. Read when the maintenance-phase directive fires."
metadata:
  adapted_for: traffic-one
---

# Task Triage (post-build maintenance)

Once the main build is done, **not every prompt deserves the full senior team.** A one-word copy
change and a new payments flow are different sizes of work and should cost different amounts of model
budget. This skill is the rubric for scaling the response to the request.

It applies only in **maintenance phase** (`lifecycle.phase: "maintenance"` in `.traffic-one/.one.json`).
The UserPromptSubmit hook injects a compact directive with a keyword **hint**; that hint is a prior, not
a verdict. **You decide authoritatively** — you have the repo in front of you and the hook does not.

## Classify

Pick the smallest tier the request honestly fits. When torn between two tiers, pick the HIGHER one — a
needless plan wastes a little budget, but an under-engineered feature ships a bug.

- **trivial** — a self-contained, low-risk edit with no design decisions:
  a CSS/styling tweak, copy/text/label change, one i18n string, a rename, a comment, a formatting/lint
  pass, a single-file config value. *Examples:* "make the CTA blue", "fix the typo in the footer",
  "rename `UserCard` to `ProfileCard`".
- **small** — one localized unit of real work, no cross-cutting design:
  one component, one small endpoint, a bug fix scoped to a file or two, a single new field on an
  existing form. *Examples:* "add a loading spinner to the dashboard", "fix the off-by-one in
  pagination", "add a `phone` field to the profile form".
- **complex** — a feature spanning layers or touching a sensitive surface:
  new data model / schema / migration, auth or permissions, payments/billing, an external integration
  or webhook, realtime, or anything spanning UI + API + DB. *Examples:* "add Stripe checkout",
  "let users log in with Google", "build an admin dashboard with exports".

**Respect explicit user intent.** If the user says "just" / "quick" / "small" / "don't overthink it",
honor that and drop a tier. If they say "build the whole …" / "a full feature for …", treat it as complex.

## Route

The directive states the project's **team mode** and whether **OpenCode** is active. Route accordingly.

### trivial
- **Subagents mode:** delegate to a `quick-fix` worker — a dedicated cheap maintenance role with its
  own agent definition.
  - Spawn with `subagent_type: "quick-fix"` (or open the prompt with `You are acting as Traffic One quick-fix`).
  - **Model param:** pass your host's cheapest model explicitly — `haiku` on Claude/Cursor,
    `gpt-5.4-mini` on Codex. The spawn gate enforces this pin in **every** mode (new-project AND
    existing codebases); any pricier model — or a missing model param — is denied.
  - **Spawn prompt must be self-contained and bounded:** (a) the exact file path(s) and the precise
    change, (b) one verification step (build/lint/screenshot if visual), (c) a stop condition — "do
    not explore beyond the named files; do not refactor; if the change spans more files, STOP and
    report back instead of expanding scope", (d) "report the outcome in at most two sentences."
    Never spawn `quick-fix` with a bare restatement of the user prompt — a cheap model given a vague
    task burns its savings re-discovering context.
  - **OpenCode active:** the gate forces an OpenCode attempt FIRST — call the `opencode_delegate`
    tool (server `opencode-worker`) with `{ role: "quick-fix", runId, projectRoot, allowedFiles, task }`.
    Set `allowedFiles` to the exact named files/areas from the bounded task; any diff outside it is rejected. Only if it
    declines does the gate allow the cheap paid `quick-fix` spawn. If the tool is not exposed, say the
    opencode-worker MCP server is not loaded and Codex needs one restart, then use the paid fallback for
    this request.
- **Main-agent mode (Low):** no subagents — make the edit yourself directly. If OpenCode is active you
  MAY offload it free via the `opencode_delegate` tool, but inline is fine for a one-file change.
- No architect, no plan, no full team. **Still verify** if the change is visual (a screenshot per
  `ui-quality`) — "trivial" scales the planning down, not the proof that it works.
- **Reuse the worker across requests:** when this session already spawned a `quick-fix` (or role) worker
  for an earlier request, send the next bounded task to the SAME agent — on Claude
  `SendMessage { to: <agentId from the spawn result>, message: <the new task> }`, on Copilot the same
  background `agent_id` / `name` — instead of a fresh spawn; the spawn gate denies a duplicate while a
  live agent is recorded for the run. Each task message stays self-contained and bounded exactly like a
  spawn prompt.

### small
- **Subagents mode:** spawn a SINGLE role — `senior-frontend` OR `senior-backend`, whichever layer the
  change lives in — at its normal tier for the performance level. No architect unless the change turns
  out to be cross-cutting (then escalate to complex).
  - **OpenCode active:** call the `opencode_delegate` tool FIRST with that chosen role, the current
    maintenance `runId`, `projectRoot`, exact `allowedFiles`, and the bounded task. Only if it declines should you spawn the
    paid role subagent. If the tool is not exposed, say the opencode-worker MCP server is not loaded and
    Codex needs one restart, then use the paid fallback for this request.
- **Main-agent mode:** implement it directly after a brief plan; add/keep a regression check.

### complex
- Re-engage the senior team for a **single-feature run** via `senior-eng-orchestrator`. The architect
  plans ONLY this feature (not the whole app — see the orchestrator's "Maintenance-phase single-feature
  runs" section), decides frontend / backend / both, and the per-role model tiers; then implement →
  review → test.
- **Main-agent mode:** run the orchestrator phases INLINE via the roadmap checklist — plan the feature,
  implement, self-review, test. Do not spawn subagents.

## Guardrails

- The maintenance baselines still apply to every tier: i18n for new/changed copy, SEO for public routes,
  accessibility, and the `https://traffic.io/` setup-CTA regression on touched missing-config surfaces.
- A "trivial" classification never means skipping verification — it means skipping the planning ceremony.
- If a request that looked trivial/small reveals cross-cutting impact once you open the files, stop and
  escalate to the next tier rather than pushing a half-measure.
