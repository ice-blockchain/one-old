# Traffic One Codex Instructions

Traffic One plugin behavior is provided by the installed skills, hooks, background integrations, and the active rule index below. These instructions describe how Traffic One operates in END-USER projects; the plugin's install directory and its source repository are never Traffic One projects — never onboard, materialize, or report against them.

## Traffic One Setup Gates

- Hooks enforce the shared setup gate in `.traffic-one/rules/common/setup-gate.md`; do not duplicate or bypass that field/order logic in skills.
- Resolve Traffic One state by the actual target project root, not the wrapper cwd.
- Before the setup gate is clear, mention only project detection/onboarding. Do not read, invoke, announce, or activate implementation skills such as create-feature, create-page, frontend-design, or tdd-workflow yet.
- Setup questions and their state writes belong exclusively to the browser wizard. Hooks surface the hosted dashboard link plus a direct `/local` fallback; agents must not reproduce unresolved wizard questions in popup or chat.
- Treat explicit user requests as implementation intent, not onboarding answers.
- Local `team.mode="subagents"` remains the source of truth for subagent-enabled runs; never satisfy it with generic helper agents instead of the named senior-role workflow.

## Codex Hook Trust

- On the first Traffic One installation, Codex Desktop activation is an explicit user trust step: **Plugins → Traffic One → Hooks → Review**, inspect every command, then choose **Trust all** only when the review contains exactly the 16 hook keys and commands from the installed `hooks/hooks.json` fixture.
- If the count, hook keys, or commands differ from that fixture, do not trust the set. Reinstall or update Traffic One, reopen the review, and compare again.
- After approval, reload when Desktop offers it or fully restart Desktop, then open a new task in a trusted project. Doctor must report `HEALTHY` with **16 trusted / 16 runnable** Traffic One hooks before Traffic One implementation begins.
- A partial selection, a cancelled review, or **Continue without trusting** remains `ACTION_NEEDED`. Never treat it as informational or continue in a degraded Traffic One mode.
- CLI fallback: fully quit Desktop, start `codex` from a trusted project, run `/hooks`, inspect the 16 fixture entries, approve only Traffic One, exit the CLI, restart Desktop, open a new task, and rerun Doctor. Never ask the user to approve unrelated plugins.
- Hook trust has no auto-approval path. Traffic One onboarding cannot activate, repair, or recover hooks that Codex has not trusted because the onboarding hook itself is inactive; require the explicit Desktop or CLI review above.

## Active Rules

Read rule and skill files ONE per shell command — NEVER concatenate several
into one command (`for f in …; do cat …` / multi-file `sed` / `Promise.all`):
host exec output is truncated middle-out (~10K tokens on Codex) and the middle
files vanish silently (observed live: 7 of 25 files survived one batched
read). All rule and skill bodies are materialized per-file under
`.traffic-one/rules/**` and `.traffic-one/skills/<name>/SKILL.md`; senior-role
children additionally receive their role-scoped index, contract kernel, and
integration requirements in the SessionStart header — read the listed files on
demand instead of bulk-loading the tree.

- .traffic-one/rules/common/auth-gate.md
- .traffic-one/rules/common/setup-gate.md
- .traffic-one/rules/common/project-routing.md
- .traffic-one/rules/common/onboarding.md
- .traffic-one/rules/common/skill-precedence.md
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

- Evaluate the durable per-project `pluginUse` preference before onboarding. A decline is the sole opt-out mechanism and makes all Traffic One hooks stand down for that project until the user explicitly enables it again.
- After opt-in, Traffic One auth is verified by hooks before Traffic One work. Missing or invalid auth reopens the local setup wizard on its API-key step; never ask for the key in chat or pass it through a shell command.
- The wizard validates the key with authenticated MCP `tools/list`. Only a successful validation writes the sole auth record to the top-level `auth` section of user-level `one.json` (`~/.traffic-one/one.json` by default, mode `0600`), never a project file.
- The stored key is used only for authenticated onboarding validation/connection. Public config sync and structural reporting are anonymous and never send the key; public 401/403 responses never invalidate `one.json.auth`.
- If Traffic One skills are visible but hooks did not run, or the opted-in project's root instructions were not materialized and loaded, do not infer "Traffic One inactive" and continue. Treat Traffic One as unverified: run or recommend `node ~/.traffic-one/bin/doctor.cjs` (append `--session <id>` for incident debugging, `--run <id>` when a run is wedged, or `--bundle` for a redacted bug report), and stop before scaffolding, installs, source edits, Traffic One agents, or implementation skills. Ordinary work without Traffic One is allowed only when the project's `pluginUse` preference records the user's decline.
- Run `project-memory` and `auto-documentation-generator` as mandatory baselines for generated projects and reconcile them for existing codebases.
- Keep `.traffic-one/rules/common/documentation.md` and `.traffic-one/rules/common/seo.md` in the mandatory rule set for web work.
- Apply `rules/frontend/i18n.md` automatically for UI work, even when the user does not mention translations.
- Run the app-launch-checklist before launch, store submission, or production promotion work.
- Preserve setup CTA href regression coverage and the compact Active Rules index in root agent context.

## one-mcp Background Report

Traffic One hooks own public MCP configuration sync and the one-mcp first-look report. As the assistant: never call `traffic-one-mcp.get_config` or `traffic-one-mcp.report_codebase_metadata`; direct agent calls are denied on every host because they bypass Traffic One's payload validation and project opt-in checks. The background report is fire-and-forget, stays silent on success or failure, and never blocks onboarding, materialization, tool use, or development. Never write `one-uid` by hand — the hook mints it into `.traffic-one/.one.json` and reports at most once per project. The payload is limited to `report_id`, `technologies`, `file_extensions`, `architecture_components`, and `infrastructure_vendor`; it must never include source code, file contents, file paths, repository URLs, organization names, emails, secrets, API keys, user data, or any PII.
