# Senior-engineer team orchestration

- For non-trivial multi-layer builds, all supported runtimes mirror Claude Code's Traffic One flow exactly: architect first, frontend and backend in parallel, reviewer and tester in parallel, shipper only on explicit deploy intent.
- Claude Code auto-spawns the named agents from `agents/*.md` when the orchestrator triggers.
- Claude Code subagents do not inherit the parent agent's skills; each `agents/senior-*.md` frontmatter must declare its needed `skills:` explicitly.
- Codex must announce the Traffic One team before starting a non-trivial multi-layer build. If the active Codex runtime requires explicit user intent before using subagents, ask for that confirmation first; otherwise auto-spawn. If confirmation is not granted or subagents are blocked, continue with per-role prompts in the same thread and state that the Traffic One team is being simulated by the main agent.
- Codex uses available Codex subagents to emulate the Traffic One roles after confirmation/runtime approval:
  - `senior-architect` → `worker`, owned write scope `.traffic-one/plan.md` and ADR/docs only.
  - `senior-frontend` → `worker`, owned write scope frontend/UI/i18n files only.
  - `senior-backend` → `worker`, owned write scope backend/API/database files only.
  - `senior-reviewer` → `explorer` or `default`, read-only.
  - `senior-tester` → `worker`, owned write scope test files and test infrastructure only.
  - `senior-shipper` → `worker`, deploy/release only after the shipper gate is satisfied.
- Cursor uses available Cursor/background-agent/task facilities to run the same roles. If Cursor exposes no callable agent facility, keep the same phase order manually with the mirrored `00-agent-senior-*.mdc` role contexts and state that the Traffic One team is being simulated by the main agent because the runtime has no subagent adapter.
- Include the relevant Traffic One role instructions from `agents/senior-*.md` or a concise equivalent in every Codex/Cursor subagent prompt.
- If subagents are unavailable or blocked in any runtime, continue manually in the same dependency order and state that the Traffic One team is being simulated by the main agent.
- Do not ask for subagents on single-component, single-page, single-service, read-only audit, or small refactor tasks; route those directly to the matching specialist skill.
- Shipper remains gated: deploy/release/publish actions require explicit deploy intent, reviewer `APPROVED`, tester `TESTS_GREEN`, and user confirmation in the same turn.
