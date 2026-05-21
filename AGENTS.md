# Traffic One Codex Instructions

Traffic One plugin behavior is provided by the installed skills, hooks, background integrations, and the active rule index below. Keep this mirror aligned with the plugin-root rules so Codex, Claude Code, Cursor, and local plugin tests all see the same baseline.

## New-Project Gate

- When `mode === "new-project"`, Codex and Claude Code must switch to Plan mode before onboarding questions, `.traffic-one.json`, `.traffic-one/plan.md`, subagent prompts, file writes, installs, or scaffolding.
- Codex default-mode fallback is a visible first-response requirement. If Plan mode or popup input is unavailable, ask the fallback onboarding questions in chat and stop for the user's typed answers.
- Before onboarding is resolved, mention only the project-detection/onboarding flow. Do not claim that implementation skills such as create-feature, create-page, frontend-design, or tdd-workflow are active yet.
- Treat explicit user requests as implementation intent, not onboarding answers.
- Persist the Team answer in `.traffic-one.json`; `team.mode="subagents"` remains the source of truth for subagent-enabled runs.

## Active Rules

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

- Run `project-memory` and `auto-documentation-generator` as mandatory baselines for generated projects and reconcile them for existing codebases.
- Keep `.traffic-one/rules/common/documentation.md` and `.traffic-one/rules/common/seo.md` in the mandatory rule set for web work.
- Apply `rules/frontend/i18n.md` automatically for UI work, even when the user does not mention translations.
- Run the app-launch-checklist before launch, store submission, or production promotion work.
- Preserve setup CTA href regression coverage and the compact Active Rules index in root agent context.

## one-mcp Background Report

Traffic One hooks handle the one-mcp first-look report in the background for full end-user projects. Do not call `one-mcp.report_codebase_metadata` from the assistant.

- If `.one-mcp-id` exists at the project root, the background reporter stops and makes no additional report attempt for that project.
- If `.one-mcp-id` does not exist and the project has real codebase markers, the hook writes a UUID v7 as the only line of `.one-mcp-id`, stages that file when the project is a git repository, gathers anonymous structural metadata, and sends one background HTTPS request to the one-mcp endpoint.
- The reporter is not run during plugin install and is not used for snippets, examples, or single files.
- The payload is limited to `report_id`, `technologies`, `file_extensions`, `architecture_components`, and `infrastructure_vendor`; it must never include source code, file contents, file paths, repository URLs, organization names, emails, secrets, API keys, user data, or any PII.
