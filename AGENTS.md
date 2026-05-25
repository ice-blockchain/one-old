# Traffic One Codex Instructions

Traffic One plugin behavior is provided by the installed skills, hooks, background integrations, and the active rule index below. Keep this mirror aligned with the plugin-root rules so Codex, Claude Code, Cursor, and local plugin tests all see the same baseline.

## New-Project Gate

- When `mode === "new-project"`, Traffic One onboarding runs in the current thread before `.traffic-one.json`, `.traffic-one/plan.md`, subagent prompts, file writes, installs, or scaffolding.
- Use host popup input for onboarding when available. If popup input is unavailable, ask the same next unresolved onboarding question in chat and stop for the user's typed answer.
- Before onboarding is resolved, mention only the project-detection/onboarding flow. Do not read, invoke, announce, or activate implementation skills such as create-feature, create-page, frontend-design, or tdd-workflow yet.
- Treat explicit user requests as implementation intent, not onboarding answers.
- The OpenCode delegation opt-in (token economy) is the FIRST onboarding prompt, asked before Agent Mode; persist `openCode` (`enabled`, `source`, `decidedAt`). It also surfaces once (non-blocking) for existing codebases. Delegation itself is a later task — this only records the choice so a future performance update can split work across Traffic One subagents and free OpenCode agents.
- Persist Agent Mode/Performance in `.traffic-one.json`; Balanced/High require Team Confirmation and `team.approved=true` before any subagent spawn.
- After Agent Mode and Team Confirmation, collect a rich dynamic MVP `projectContext`, then ask Mobile App, then Code Graph.
- `team.mode="subagents"` remains the source of truth for subagent-enabled runs; never satisfy it with generic helper agents instead of the named senior-role workflow.

## Active Rules

- .traffic-one/rules/common/auth-gate.md
- .traffic-one/rules/common/senior-engineer-team.md
- .traffic-one/rules/common/project-memory.md
- .traffic-one/rules/common/documentation.md
- .traffic-one/rules/common/seo.md
- .traffic-one/rules/common/stack-recommendations.md
- .traffic-one/rules/frontend/i18n.md
- .traffic-one/rules/frontend/ui-quality.md
- .traffic-one/rules/frontend/typography.md
- .traffic-one/rules/frontend/react/design-quality.md
- .traffic-one/rules/modes/new-project.md
- .traffic-one/rules/modes/existing-codebase.md

## Active Skills

- .traffic-one/skills/project-memory/SKILL.md
- .traffic-one/skills/auto-documentation-generator/SKILL.md
- .traffic-one/skills/verification-loop/SKILL.md
- .traffic-one/skills/observability/SKILL.md
- .traffic-one/skills/app-launch-checklist/SKILL.md

## Baseline Requirements

- Authenticate with the `mcp-auth` server before using Traffic One. Until auth succeeds, hooks surface the auth instruction, keep Traffic One inactive, prevent Traffic One prompt continuation, and let ordinary work proceed without Traffic One features.
- If a stored auth session expires, the auth client may call `refresh` internally with `TRAFFIC_ONE_AUTH_KEY` when the key is still available in the current process environment. If refresh fails or the key is unavailable, keep Traffic One gated and ask the user to authenticate again.
- If Traffic One skills are visible but hooks or these root instructions were not injected, do not infer "Traffic One inactive" and continue. Treat Traffic One as unverified: ask the auth choice, run or recommend `node scripts/doctor.cjs` (or `node scripts/doctor.cjs --session <id>` for incident debugging), and stop before scaffolding, installs, source edits, Traffic One agents, or implementation skills. Continue ordinary work without Traffic One only after the user explicitly chooses "Continue without Traffic One".
- Run `project-memory` and `auto-documentation-generator` as mandatory baselines for generated projects and reconcile them for existing codebases.
- Keep `.traffic-one/rules/common/documentation.md` and `.traffic-one/rules/common/seo.md` in the mandatory rule set for web work.
- Apply `rules/frontend/i18n.md` automatically for UI work, even when the user does not mention translations.
- Run the app-launch-checklist before launch, store submission, or production promotion work.
- Preserve setup CTA href regression coverage and the compact Active Rules index in root agent context.

## one-mcp Background Report

Traffic One hooks handle the one-mcp first-look report in the background for full end-user projects. Do not call `one-mcp.report_codebase_metadata` from the assistant.

- The reporter is skipped until `mcp-auth` authentication succeeds; `.one-mcp-id` must not be created before auth.
- If `.one-mcp-id` exists at the project root, the background reporter stops and makes no additional report attempt for that project.
- If `.one-mcp-id` does not exist and the project has real codebase markers, the hook writes a UUID v7 as the only line of `.one-mcp-id`, stages that file when the project is a git repository, gathers anonymous structural metadata, and sends one background HTTPS request to the one-mcp endpoint.
- The report is fire-and-forget. Success, failure, timeout, invalid response, or skipped submission must stay silent and must never block onboarding completion, materialization, tool use, scaffolding, or development.
- The reporter is not run during plugin install and is not used for snippets, examples, or single files.
- The payload is limited to `report_id`, `technologies`, `file_extensions`, `architecture_components`, and `infrastructure_vendor`; it must never include source code, file contents, file paths, repository URLs, organization names, emails, secrets, API keys, user data, or any PII.
