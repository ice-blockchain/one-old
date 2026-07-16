# Traffic One Plugin Reference

Generated on 2026-05-12 from the checked-in plugin source.

This file maps the Traffic One plugin surface to the rules, skills, agents,
hooks, generated artifacts, and external inspiration/source links used to build
it. It intentionally lists source files, not generated file bodies. Generated
Cursor mirrors, Windsurf Cascade mirrors, OpenCode project-local assets, and
Kilo user-level wrappers are listed separately because their source of truth is
`rules/`, `agents/`, and `skills-catalog/`.

## External References

- Everything Claude Code repository: https://github.com/affaan-m/everything-claude-code
- Everything Claude Code rules tree: https://github.com/affaan-m/everything-claude-code/tree/main/rules
- Everything Claude Code skills tree: https://github.com/affaan-m/everything-claude-code/tree/main/skills
- Karpathy-style Claude guidance: https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md
- X inspiration post from `anatolikopadze`: https://x.com/anatolikopadze/status/2050225292585607440?s=46&t=jHyjiUvxKWyCPPhGMqepEw
- X inspiration post from `mnilax`: https://x.com/mnilax/status/2053116311132155938?s=46&t=jHyjiUvxKWyCPPhGMqepEw
- Mindrally JWT skill: https://github.com/Mindrally/skills/blob/main/jwt-security/SKILL.md
- Mindrally PostgreSQL best practices skill: https://github.com/Mindrally/skills/blob/main/postgresql-best-practices/SKILL.md
- AgentShield referenced by `security-scan`: https://github.com/affaan-m/agentshield
- C++ Core Guidelines referenced by `cpp-coding-standards`: https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines
- Repo Scan upstream referenced by `repo-scan`: https://github.com/haibindev/repo-scan

Note: the X links above are retained exactly as supplied. X may require login or
block full post retrieval, so they are treated as inspiration links rather than
line-verifiable source files.

## Inventory Summary

- Source rules: 79 files under `rules/`.
- Skills: 103 `skills/*/SKILL.md` files.
- Skill support files: `skills/security-review/cloud-infrastructure-security.md` and `skills/senior-eng-orchestrator/resources/prompt-templates.md`.
- Senior-agent role files: 6 files under `agents/`.
- Generated Cursor rule mirrors: 76 files under `.cursor/rules/` after `npm run gen`.
- Generated Windsurf / Devin Desktop Cascade rule mirrors: split-aware Markdown
  files under `.devin/rules/` after `npm run gen`.
- External model-status API: maintained independently from plugin generation;
  responses match the local `{ plan, updatedAt, tiers }` host snapshot exactly.
- Generated OpenCode user-local agents: `~/.config/opencode/agents/traffic-one-<projectHash12>-<role>.md`; legacy generated project profiles are cleaned while user-authored files are preserved.
- Generated Kilo wrapper support: `scripts/kilo-host.cjs` installs `~/.config/kilo/plugin/traffic-one.js`, and `.kilo/traffic-one.json` records explicit per-project enable/disable overrides.
- Windsurf project assets: `.devin/rules/*.md` plus generated Devin Local profiles are materialized per onboarded project when Windsurf is the host; skills remain under the canonical `.traffic-one/skills/<skill>/SKILL.md` tree.
- Hook/runtime script entrypoints plus compiled modules under `scripts/` after `npm run build`.
- Harness manifests: `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`.
- Hook configs: `settings.json`, `hooks/hooks.json`, `hooks/hooks-windsurf.json`, `.githooks/pre-commit`, `.githooks/prepare-commit-msg`.
- CI workflows: `.github/workflows/cursor-sync.yml`, `.github/workflows/traffic-one-security-check.yml`.

## Source Conventions

- ECC skill source pattern: `https://github.com/affaan-m/everything-claude-code/blob/main/skills/<skill-name>/SKILL.md`.
- ECC language rule source pattern: `https://github.com/affaan-m/everything-claude-code/blob/main/rules/<language>/<rule-file>.md`.
- Traffic One local source means the rule or skill was authored for this plugin and may be inspired by the external references above, but no one-to-one upstream file is declared in frontmatter.
- Runtime skills may carry structured provenance metadata (`source`,
  `source_path`, `source_commit`) for future upstream sync. Human-readable
  source mapping and multi-source notes are tracked here.

## Content Architecture — Canonical Owners

Generic guidance is single-sourced: one canonical file owns each cross-cutting
concern, and per-stack rules/skills carry a one-line pointer instead of restating
it. A 2026-06 de-duplication audit removed ~5k lines of repeated prose this way.
**When editing, change the owner — never re-inline shared content into a
consumer.**

| Concern | Canonical owner | Consumers that defer to it |
| --- | --- | --- |
| Naming, immutability, KISS/DRY/YAGNI, code smells | `rules/common/clean-code.md` (always-on) | `coding-standards` + every `*-patterns` / `*-coding-standards` skill |
| Security checklist + Traffic One pre-deploy gate | `rules/common/security.md` (always-on) | `*-security` skills, `security-review`, `predeploy-security-check`, `verification-loop`, `backend/*` rules |
| Provider-first defaults (payments, observability, email, proxies, per-language libs) | `rules/common/library-catalog.md` (always-on) | `rules/common/stack-recommendations.md` |
| Public-route SEO baseline | `rules/common/seo.md` | `stack-recommendations.md`, `create-*`, mode rules |
| External/destructive-action confirmation boundary | `rules/common/security.md` | `execution-discipline.md`, `senior-engineer-team.md` |
| Setup-gate / onboarding preconditions | `rules/common/setup-gate.md` | `auth-gate.md`, `onboarding.md`, `skill-precedence.md`, `senior-engineer-team.md` |
| Codebase-graph artefact paths + read protocol | `rules/common/codebase-graph.md` | `agent-handoff-digests.md`, `project-memory.md` |
| RED-GREEN-REFACTOR cycle, coverage tiers, AAA, test maxims | `tdd-workflow` skill | every `*-testing` / `*-tdd` skill |
| Verification phase pipeline + VERIFICATION REPORT template | `verification-loop` skill | `*-verification` skills |
| i18n detection, `<Trans>` vs `t()`, hardcoded-string exception | `i18n-text` skill | `create-*` skills, `rules/frontend/i18n.md` |
| Design brief, anti-AI-slop, token mandate, `https://traffic.io/` setup-link contract, UI states | `rules/frontend/ui-quality.md` | `create-*`, `frontend-design`, `design-audit`, `design-system` |
| Token-storage policy (no localStorage; httpOnly cookies) | `jwt-security` skill | `security-review`, `springboot-security` |
| Post-deploy observability / replay-privacy / SLO / AI-fix policy | `observability` skill | `security.md`, `deployment-patterns`, frontend security rules |
| `.traffic-one` file inventory, secret-redaction, schema snapshot | `project-memory` skill | `auto-documentation-generator` |

The frontend rule families (`rules/frontend/{react,react-native,ionic}/**`) are
mutually exclusive per project: each per-framework file keeps only its platform
delta and defers shared content to the base `rules/frontend/<x>.md`
(realtime, services, testing, performance, accessibility, i18n). Within the react
family, `core.md` owns the styling stack, `services.md` owns RTK Query discipline,
`realtime.md` owns the WS→Redux bridge, and `performance.md` owns the realtime
render budget; siblings point at them.

Catalog conventions normalized by the audit: the activation heading is
`## When to Activate` (not "When to Use"), and good/bad code examples use the
`// GOOD` / `// BAD` comment markers.

## Source Rules

| Local file | Source or inspiration |
| --- | --- |
| `rules/core.md` | Traffic One local core, inspired by ECC common/typescript layering: https://github.com/affaan-m/everything-claude-code/tree/main/rules |
| `rules/common/agent-handoff-digests.md` | Traffic One local token-economy rule, inspired by ECC subagent/memory patterns: https://github.com/affaan-m/everything-claude-code |
| `rules/common/auth-gate.md` | Traffic One local auth-gate rule (wizard-validated API key in user-level `one.json.auth`; per-project opt-out is owned by `pluginUse`). |
| `rules/common/clean-code.md` | Traffic One local baseline, inspired by ECC common rules and Karpathy simplicity guidance: https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md — **canonical owner** of the language-agnostic floor; `*-patterns`/`coding-standards` skills defer here. |
| `rules/common/codebase-graph.md` | Traffic One local graphify cache rule, inspired by ECC memory/token optimization: https://github.com/affaan-m/everything-claude-code — **canonical owner** of graph artefact paths + read protocol; `agent-handoff-digests`/`project-memory` defer here. |
| `rules/common/dependencies.md` | Traffic One local dependency gate, now topped up from ECC search-first behavior: https://github.com/affaan-m/everything-claude-code/blob/main/skills/search-first/SKILL.md |
| `rules/common/documentation.md` | Traffic One local docs standard, inspired by ECC docs/agent surfaces: https://github.com/affaan-m/everything-claude-code |
| `rules/common/execution-discipline.md` | Behavior rule merging the Karpathy/Forrest Chang baseline, supplied Mnilax/Anatoli workflow links, and ECC search/eval/agentic guidance: https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md |
| `rules/common/git.md` | Traffic One local Gitflow rule, inspired by ECC common git workflow: https://github.com/affaan-m/everything-claude-code/blob/main/rules/common/git-workflow.md |
| `rules/common/library-catalog.md` | Traffic One local curated catalog, inspired by ECC dependency/library guidance: https://github.com/affaan-m/everything-claude-code/tree/main/rules/common — **canonical owner** of provider-first defaults (payments/observability/email/proxies/per-language libs); `stack-recommendations` defers here. |
| `rules/common/onboarding.md` | Traffic One local onboarding-gate rule; defers the gate-clear conditions to `setup-gate`. |
| `rules/common/project-memory.md` | Traffic One local persistent memory rule, topped up from ECC codebase onboarding/reconnaissance guidance: https://github.com/affaan-m/everything-claude-code/blob/main/skills/codebase-onboarding/SKILL.md |
| `rules/common/project-routing.md` | Traffic One local project/mode routing rule. |
| `rules/common/quality-tooling.md` | Traffic One local quality tooling rule, inspired by ECC ESLint/config/tooling guidance: https://github.com/affaan-m/everything-claude-code/blob/main/eslint.config.js |
| `rules/common/security.md` | Traffic One local security baseline, inspired by ECC security guide and AgentShield: https://github.com/affaan-m/everything-claude-code/blob/main/rules/common/security.md — **canonical owner** of the security checklist, the pre-deploy gate, and the external/destructive confirmation boundary; `*-security`/`security-review`/`predeploy-security-check`/`verification-loop`/`backend/*`/`execution-discipline` defer here. |
| `rules/common/senior-engineer-team.md` | Traffic One local senior-agent orchestration, inspired by ECC subagent orchestration: https://github.com/affaan-m/everything-claude-code |
| `rules/common/seo.md` | Traffic One local SEO web baseline — **canonical owner**; `stack-recommendations`/`create-*`/mode rules defer here. |
| `rules/common/setup-gate.md` | Traffic One local setup gate — **canonical owner** of gate-clear conditions + the read-only-orientation clause; `auth-gate`/`onboarding`/`skill-precedence`/`senior-engineer-team` defer here. |
| `rules/common/skill-precedence.md` | Traffic One local skill-precedence rule; defers to `setup-gate`. |
| `rules/common/stack-recommendations.md` | Traffic One local stack defaults, inspired by ECC provider-first patterns: https://github.com/affaan-m/everything-claude-code |
| `rules/backend/cpp.md` | Merged from ECC `rules/cpp/*`: https://github.com/affaan-m/everything-claude-code/tree/main/rules/cpp |
| `rules/backend/csharp.md` | Merged from ECC `rules/csharp/*`: https://github.com/affaan-m/everything-claude-code/tree/main/rules/csharp |
| `rules/backend/golang.md` | Merged from ECC `rules/golang/*`: https://github.com/affaan-m/everything-claude-code/tree/main/rules/golang |
| `rules/backend/java.md` | Merged from ECC `rules/java/*`, including coding style: https://github.com/affaan-m/everything-claude-code/blob/main/rules/java/coding-style.md |
| `rules/backend/kotlin.md` | Merged from ECC `rules/kotlin/*`: https://github.com/affaan-m/everything-claude-code/tree/main/rules/kotlin |
| `rules/backend/node.md` | Traffic One Node/TypeScript backend rule, inspired by ECC TypeScript/backend skills: https://github.com/affaan-m/everything-claude-code/tree/main/rules/typescript |
| `rules/backend/perl.md` | Merged from ECC `rules/perl/*`: https://github.com/affaan-m/everything-claude-code/tree/main/rules/perl |
| `rules/backend/php.md` | Merged from ECC `rules/php/*`: https://github.com/affaan-m/everything-claude-code/tree/main/rules/php |
| `rules/backend/postgres.md` | Traffic One Postgres/Supabase rule, paired with ECC/Postgres skills and Mindrally PostgreSQL: https://github.com/Mindrally/skills/blob/main/postgresql-best-practices/SKILL.md |
| `rules/backend/python.md` | Merged from ECC `rules/python/*`: https://github.com/affaan-m/everything-claude-code/tree/main/rules/python |
| `rules/backend/rust.md` | Merged from ECC `rules/rust/*`: https://github.com/affaan-m/everything-claude-code/tree/main/rules/rust |
| `rules/frontend/accessibility.md` | Traffic One local frontend a11y rule, paired with ECC accessibility skill and web semantic guidance: https://github.com/affaan-m/everything-claude-code/blob/main/skills/accessibility/SKILL.md — shared base; per-framework a11y rules keep platform deltas and defer here. |
| `rules/frontend/i18n.md` | Traffic One local frontend i18n rule, paired with the `i18n-text` skill (canonical i18n owner). |
| `rules/frontend/performance.md` | Traffic One local frontend performance rule, topped up from ECC web/Vite bundle guidance: https://github.com/affaan-m/everything-claude-code/tree/main/rules/web |
| `rules/frontend/realtime.md` | Traffic One local realtime rule, inspired by ECC backend/frontend service patterns: https://github.com/affaan-m/everything-claude-code |
| `rules/frontend/services.md` | Traffic One local service-layer rule, inspired by ECC TypeScript/service patterns: https://github.com/affaan-m/everything-claude-code/tree/main/rules/typescript |
| `rules/frontend/testing.md` | Traffic One local frontend testing rule, paired with ECC testing skills: https://github.com/affaan-m/everything-claude-code/tree/main/skills |
| `rules/frontend/typography.md` | Traffic One local typography rule, inspired by bencium design guidance and UI quality rule. |
| `rules/frontend/ui-quality.md` | Distilled from bencium-marketplace `impact-designer` and `controlled-ux-designer`; also inspired by the supplied X posts. — **canonical owner** of the design brief, anti-AI-slop list, token mandate, `https://traffic.io/` setup-link contract, and UI states; `create-*`/`frontend-design`/`design-audit`/`design-system` defer here. |
| `rules/frontend/ui-quality-reference.md` | Traffic One local UI-quality reference checklists; companion to `ui-quality.md`. |
| `rules/frontend/react/components.md` | Traffic One React component rule, inspired by ECC web/typescript rules: https://github.com/affaan-m/everything-claude-code/tree/main/rules/web |
| `rules/frontend/react/core.md` | Traffic One forced React stack rule, inspired by ECC TypeScript/Web layering: https://github.com/affaan-m/everything-claude-code/tree/main/rules/typescript — **canonical owner** of the React styling stack (shadcn/cn/cva/tokens); `components` cites it. |
| `rules/frontend/react/design-quality.md` | Traffic One React design gate, paired with `frontend-design`/`design-audit` and topped up with ECC anti-template web guidance. |
| `rules/frontend/react/performance.md` | Traffic One React performance rule, inspired by ECC web performance guidance: https://github.com/affaan-m/everything-claude-code/tree/main/rules/web — **canonical owner** of the realtime render budget (30fps / rAF batching). |
| `rules/frontend/react/realtime.md` | Traffic One React realtime rule, inspired by service/realtime architecture patterns. — **canonical owner** of the WS→Redux bridge pattern; `stores` cites it. |
| `rules/frontend/react/security.md` | Traffic One React security rule, inspired by ECC security rules: https://github.com/affaan-m/everything-claude-code/blob/main/rules/common/security.md |
| `rules/frontend/react/services.md` | Traffic One React services rule, inspired by ECC TypeScript/service patterns. — **canonical owner** of RTK Query discipline; `stores` cites it. |
| `rules/frontend/react/stores.md` | Traffic One Redux/RTK Query/zustand rule, local forced-stack rule. |
| `rules/frontend/react/supabase-client.md` | Traffic One Supabase client rule, local forced-stack rule. |
| `rules/frontend/react/testing.md` | Traffic One React test rule, paired with ECC `e2e-testing` and `tdd-workflow` skills. |
| `rules/frontend/react/vite.md` | Traffic One Vite rule adapted from ECC Vite patterns: https://github.com/affaan-m/everything-claude-code/blob/main/skills/vite-patterns/SKILL.md |
| `rules/frontend/ionic/accessibility.md` | Traffic One Ionic accessibility rule, paired with `ionic-mobile` and `accessibility`. |
| `rules/frontend/ionic/capacitor.md` | Traffic One Capacitor rule, informed by Mindrally Ionic concepts and local forced stack. |
| `rules/frontend/ionic/components.md` | Traffic One Ionic component rule, informed by Mindrally Ionic concepts and React stack rules. |
| `rules/frontend/ionic/core.md` | Traffic One Ionic/Capacitor core, informed by Mindrally Ionic concepts and React stack rules. |
| `rules/frontend/ionic/navigation.md` | Traffic One Ionic navigation rule, informed by Mindrally Ionic concepts and React Router. |
| `rules/frontend/ionic/performance.md` | Traffic One Ionic performance rule, local mobile delivery standard. |
| `rules/frontend/ionic/realtime.md` | Traffic One Ionic realtime rule, local mobile delivery standard. |
| `rules/frontend/ionic/security.md` | Traffic One Ionic security rule, local mobile security standard. |
| `rules/frontend/ionic/services.md` | Traffic One Ionic services rule, local mobile service boundary standard. |
| `rules/frontend/ionic/stores.md` | Traffic One Ionic store rule, local RTK Query/zustand boundary standard. |
| `rules/frontend/ionic/styles.md` | Traffic One Ionic/shadcn theme bridge; notes stale upstream `@aparajita/tailwind-ionic`. |
| `rules/frontend/ionic/testing.md` | Traffic One Ionic testing rule, paired with Playwright/Maestro guidance. |
| `rules/frontend/react-native/accessibility.md` | Traffic One RN accessibility rule, paired with ECC accessibility skill. |
| `rules/frontend/react-native/components.md` | Traffic One RN component rule, local Expo/RNR/NativeWind standard. |
| `rules/frontend/react-native/core.md` | Traffic One explicit React Native/Expo core, inspired by ECC mobile/frontend patterns. |
| `rules/frontend/react-native/navigation.md` | Traffic One Expo Router navigation rule, local forced-stack rule. |
| `rules/frontend/react-native/performance.md` | Traffic One RN performance rule, local mobile performance standard. |
| `rules/frontend/react-native/realtime.md` | Traffic One RN realtime rule, local service singleton standard. |
| `rules/frontend/react-native/security.md` | Traffic One RN security rule, inspired by ECC security rules. |
| `rules/frontend/react-native/services.md` | Traffic One RN services rule, local service boundary standard. |
| `rules/frontend/react-native/stores.md` | Traffic One RN store rule, local RTK Query/zustand boundary standard. |
| `rules/frontend/react-native/styles.md` | Traffic One NativeWind/RNR style rule, local forced-stack rule. |
| `rules/frontend/react-native/testing.md` | Traffic One RN testing rule, paired with Jest/RNTL/Maestro guidance. |
| `rules/modes/existing-codebase.md` | Traffic One local mode rule, inspired by ECC repo-safety guidance. |
| `rules/modes/new-project.md` | Traffic One local new-project rule (read-order spine), inspired by ECC setup/orchestration patterns. |
| `rules/modes/new-project-architecture.md` | Traffic One local new-project target-architecture mode rule. |
| `rules/modes/new-project-setup.md` | Traffic One local new-project setup checklist (full detail; `new-project.md` is the spine). |
| `rules/modes/supabase-migration.md` | Traffic One local Supabase migration rule. |

## Skills

| Skill | Local file | Source |
| --- | --- | --- |
| `accessibility` | `skills/accessibility/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/accessibility/SKILL.md |
| `ai-regression-testing` | `skills/ai-regression-testing/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/ai-regression-testing/SKILL.md |
| `android-clean-architecture` | `skills/android-clean-architecture/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/android-clean-architecture/SKILL.md |
| `api-connector-builder` | `skills/api-connector-builder/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/api-connector-builder/SKILL.md |
| `api-design` | `skills/api-design/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/api-design/SKILL.md |
| `app-launch-checklist` | `skills/app-launch-checklist/SKILL.md` | Traffic One local web/mobile launch readiness and compliance checklist workflow |
| `architecture-decision-records` | `skills/architecture-decision-records/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/architecture-decision-records/SKILL.md |
| `auto-documentation-generator` | `skills/auto-documentation-generator/SKILL.md` | Traffic One local docs skill, topped up from ECC codebase onboarding: https://github.com/affaan-m/everything-claude-code/blob/main/skills/codebase-onboarding/SKILL.md |
| `backend-patterns` | `skills/backend-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/backend-patterns/SKILL.md |
| `browser-qa` | `skills/browser-qa/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/browser-qa/SKILL.md |
| `bun-runtime` | `skills/bun-runtime/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/bun-runtime/SKILL.md |
| `click-path-audit` | `skills/click-path-audit/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/click-path-audit/SKILL.md |
| `coding-standards` | `skills/coding-standards/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/coding-standards/SKILL.md |
| `compose-multiplatform-patterns` | `skills/compose-multiplatform-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/compose-multiplatform-patterns/SKILL.md |
| `context-budget` | `skills/context-budget/SKILL.md` | Traffic One local token-budget skill, topped up with agent fan-out/model-effort budgeting |
| `cpp-coding-standards` | `skills/cpp-coding-standards/SKILL.md` | ECC plus C++ Core Guidelines: https://github.com/affaan-m/everything-claude-code/blob/main/skills/cpp-coding-standards/SKILL.md |
| `cpp-testing` | `skills/cpp-testing/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/cpp-testing/SKILL.md |
| `create-component` | `skills/create-component/SKILL.md` | Traffic One local React component workflow |
| `create-feature` | `skills/create-feature/SKILL.md` | Traffic One local feature workflow |
| `create-native-component` | `skills/create-native-component/SKILL.md` | Traffic One local RN component workflow |
| `create-native-feature` | `skills/create-native-feature/SKILL.md` | Traffic One local RN feature workflow |
| `create-native-screen` | `skills/create-native-screen/SKILL.md` | Traffic One local RN screen workflow |
| `create-native-service` | `skills/create-native-service/SKILL.md` | Traffic One local RN service workflow |
| `create-page` | `skills/create-page/SKILL.md` | Traffic One local page workflow |
| `create-service` | `skills/create-service/SKILL.md` | Traffic One local service workflow |
| `csharp-testing` | `skills/csharp-testing/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/csharp-testing/SKILL.md |
| `dart-flutter-patterns` | `skills/dart-flutter-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/dart-flutter-patterns/SKILL.md |
| `dashboard-builder` | `skills/dashboard-builder/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/dashboard-builder/SKILL.md |
| `database-migrations` | `skills/database-migrations/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/database-migrations/SKILL.md |
| `deployment-patterns` | `skills/deployment-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/deployment-patterns/SKILL.md |
| `design-audit` | `skills/design-audit/SKILL.md` | bencium-marketplace `design-audit`, distilled |
| `design-system` | `skills/design-system/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/design-system/SKILL.md |
| `documentation-lookup` | `skills/documentation-lookup/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/documentation-lookup/SKILL.md |
| `django-patterns` | `skills/django-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/django-patterns/SKILL.md |
| `django-security` | `skills/django-security/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/django-security/SKILL.md |
| `django-tdd` | `skills/django-tdd/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/django-tdd/SKILL.md |
| `django-verification` | `skills/django-verification/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/django-verification/SKILL.md |
| `docker-patterns` | `skills/docker-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/docker-patterns/SKILL.md |
| `dotnet-patterns` | `skills/dotnet-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/dotnet-patterns/SKILL.md |
| `e2e-testing` | `skills/e2e-testing/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/e2e-testing/SKILL.md |
| `execution-discipline` | `skills/execution-discipline/SKILL.md` | Merges Karpathy/Forrest Chang baseline, supplied Mnilax/Anatoli workflow links, and ECC AI-assisted engineering guidance: https://github.com/forrestchang/andrej-karpathy-skills/blob/main/CLAUDE.md |
| `flutter-dart-code-review` | `skills/flutter-dart-code-review/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/flutter-dart-code-review/SKILL.md |
| `frontend-design` | `skills/frontend-design/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/frontend-design/SKILL.md |
| `frontend-patterns` | `skills/frontend-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/frontend-patterns/SKILL.md |
| `git-commit` | `skills/git-commit/SKILL.md` | Traffic One local Gitflow/conventional commit skill |
| `golang-patterns` | `skills/golang-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/golang-patterns/SKILL.md |
| `golang-testing` | `skills/golang-testing/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/golang-testing/SKILL.md |
| `hexagonal-architecture` | `skills/hexagonal-architecture/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/hexagonal-architecture/SKILL.md |
| `i18n-text` | `skills/i18n-text/SKILL.md` | Traffic One local i18n workflow — **canonical owner** of i18n detection, `<Trans>`/`t()`, hardcoded-string exception; `create-*` skills defer here. |
| `ionic-mobile` | `skills/ionic-mobile/SKILL.md` | Traffic One local skill merging Mindrally Ionic concepts into React/Capacitor stack |
| `java-coding-standards` | `skills/java-coding-standards/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/java-coding-standards/SKILL.md |
| `jpa-patterns` | `skills/jpa-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/jpa-patterns/SKILL.md |
| `jwt-security` | `skills/jwt-security/SKILL.md` | Mindrally: https://github.com/Mindrally/skills/blob/main/jwt-security/SKILL.md — **canonical owner** of token-storage policy; `security-review`/`springboot-security` defer here. |
| `kotlin-coroutines-flows` | `skills/kotlin-coroutines-flows/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/kotlin-coroutines-flows/SKILL.md |
| `kotlin-exposed-patterns` | `skills/kotlin-exposed-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/kotlin-exposed-patterns/SKILL.md |
| `kotlin-ktor-patterns` | `skills/kotlin-ktor-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/kotlin-ktor-patterns/SKILL.md |
| `kotlin-patterns` | `skills/kotlin-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/kotlin-patterns/SKILL.md |
| `kotlin-testing` | `skills/kotlin-testing/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/kotlin-testing/SKILL.md |
| `laravel-patterns` | `skills/laravel-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/laravel-patterns/SKILL.md |
| `laravel-security` | `skills/laravel-security/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/laravel-security/SKILL.md |
| `laravel-tdd` | `skills/laravel-tdd/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/laravel-tdd/SKILL.md |
| `laravel-verification` | `skills/laravel-verification/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/laravel-verification/SKILL.md |
| `library-pick` | `skills/library-pick/SKILL.md` | Traffic One local dependency quality gate skill, topped up from ECC search-first: https://github.com/affaan-m/everything-claude-code/blob/main/skills/search-first/SKILL.md |
| `mcp-server-patterns` | `skills/mcp-server-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/mcp-server-patterns/SKILL.md |
| `model-tier-sync` | `skills/model-tier-sync/SKILL.md` | Traffic One local plugin-maintenance skill (model-tier table sync) |
| `monorepo-architecture` | `skills/monorepo-architecture/SKILL.md` | Traffic One local Turborepo + pnpm monorepo skill |
| `nestjs-patterns` | `skills/nestjs-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/nestjs-patterns/SKILL.md |
| `nextjs-turbopack` | `skills/nextjs-turbopack/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/nextjs-turbopack/SKILL.md |
| `nuxt4-patterns` | `skills/nuxt4-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/nuxt4-patterns/SKILL.md |
| `observability` | `skills/observability/SKILL.md` | Traffic One local post-deploy observability and AI fix suggestion workflow — **canonical owner** of replay-privacy/SLO/AI-fix policy; `security.md`/`deployment-patterns`/frontend security rules defer here. |
| `perl-patterns` | `skills/perl-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/perl-patterns/SKILL.md |
| `perl-security` | `skills/perl-security/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/perl-security/SKILL.md |
| `perl-testing` | `skills/perl-testing/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/perl-testing/SKILL.md |
| `postgres-patterns` | `skills/postgres-patterns/SKILL.md` | ECC plus Mindrally: https://github.com/Mindrally/skills/blob/main/postgresql-best-practices/SKILL.md |
| `postgres-review` | `skills/postgres-review/SKILL.md` | Traffic One local PostgreSQL/Supabase review skill |
| `predeploy-security-check` | `skills/predeploy-security-check/SKILL.md` | Traffic One local security gate skill |
| `project-memory` | `skills/project-memory/SKILL.md` | Traffic One local persistent memory skill, topped up from ECC codebase onboarding: https://github.com/affaan-m/everything-claude-code/blob/main/skills/codebase-onboarding/SKILL.md — **canonical owner** of the `.traffic-one` file inventory, secret-redaction, and schema snapshot; `auto-documentation-generator` defers here. |
| `python-patterns` | `skills/python-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/python-patterns/SKILL.md |
| `python-testing` | `skills/python-testing/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/python-testing/SKILL.md |
| `refactor` | `skills/refactor/SKILL.md` | Traffic One local refactor workflow |
| `repo-scan` | `skills/repo-scan/SKILL.md` | ECC plus Repo Scan upstream: https://github.com/haibindev/repo-scan |
| `rust-patterns` | `skills/rust-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/rust-patterns/SKILL.md |
| `rust-testing` | `skills/rust-testing/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/rust-testing/SKILL.md |
| `security-review` | `skills/security-review/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/security-review/SKILL.md |
| `security-scan` | `skills/security-scan/SKILL.md` | ECC plus AgentShield: https://github.com/affaan-m/agentshield |
| `senior-eng-orchestrator` | `skills/senior-eng-orchestrator/SKILL.md` | Traffic One local role-orchestration skill, topped up with ECC agentic/AI-first work-unit guidance |
| `seo` | `skills/seo/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/seo/SKILL.md |
| `springboot-patterns` | `skills/springboot-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/springboot-patterns/SKILL.md |
| `springboot-security` | `skills/springboot-security/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/springboot-security/SKILL.md |
| `springboot-tdd` | `skills/springboot-tdd/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/springboot-tdd/SKILL.md |
| `springboot-verification` | `skills/springboot-verification/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/springboot-verification/SKILL.md |
| `supabase-setup` | `skills/supabase-setup/SKILL.md` | Traffic One local Supabase setup skill |
| `swift-actor-persistence` | `skills/swift-actor-persistence/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/swift-actor-persistence/SKILL.md |
| `swift-concurrency-6-2` | `skills/swift-concurrency-6-2/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/swift-concurrency-6-2/SKILL.md |
| `swift-protocol-di-testing` | `skills/swift-protocol-di-testing/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/swift-protocol-di-testing/SKILL.md |
| `swiftui-patterns` | `skills/swiftui-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/swiftui-patterns/SKILL.md |
| `task-triage` | `skills/task-triage/SKILL.md` | Traffic One local maintenance-triage skill (complexity/scale routing) |
| `tdd-workflow` | `skills/tdd-workflow/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/tdd-workflow/SKILL.md — **canonical owner** of the RED-GREEN-REFACTOR cycle, coverage tiers, AAA, and test maxims; `*-testing`/`*-tdd` skills defer here. |
| `token-usage-report` | `skills/token-usage-report/SKILL.md` | Traffic One local token-usage reporting skill |
| `traffic-one-doctor` | `skills/traffic-one-doctor/SKILL.md` | Traffic One local setup-diagnostic skill (finding codes + fix commands) |
| `ui-demo` | `skills/ui-demo/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/ui-demo/SKILL.md |
| `verification-loop` | `skills/verification-loop/SKILL.md` | ECC verification loop plus production audit merge: https://github.com/affaan-m/everything-claude-code/blob/main/skills/production-audit/SKILL.md — **canonical owner** of the verification phase pipeline + VERIFICATION REPORT template; `*-verification` skills defer here. |
| `vite-patterns` | `skills/vite-patterns/SKILL.md` | ECC: https://github.com/affaan-m/everything-claude-code/blob/main/skills/vite-patterns/SKILL.md |

## Skill Support Files

- `skills/security-review/cloud-infrastructure-security.md` - supplemental cloud/IaC checklist used by `security-review`.
- `skills/senior-eng-orchestrator/resources/prompt-templates.md` - phase prompts for architect, frontend, backend, reviewer, tester, and shipper handoffs.

## Senior-Agent Roles

| Agent | Local file | Purpose |
| --- | --- | --- |
| `senior-architect` | `agents/senior-architect.md` | Plans stack, module map, public contracts, risks, cut-list; emits `PLAN_READY`. |
| `senior-frontend` | `agents/senior-frontend.md` | Owns UI, i18n, accessibility, design system, frontend implementation. |
| `senior-backend` | `agents/senior-backend.md` | Owns API, auth, persistence, migrations, backend implementation. |
| `senior-reviewer` | `agents/senior-reviewer.md` | Read-only security/code review; emits `APPROVED` or `CHANGES_REQUESTED`. |
| `senior-tester` | `agents/senior-tester.md` | Owns tests/test infra only; emits `TESTS_GREEN` or `TESTS_FAILING`. |
| `senior-shipper` | `agents/senior-shipper.md` | Deploy/release role gated by reviewer, tester, security scan, and user confirmation. |

## Harness Manifests And Entrypoints

- `AGENTS.md` - Codex CLI and OpenCode rule entrypoint and full rule mirror.
- `CLAUDE.md` - Claude Code entrypoint.
- `README.md` - human overview and plugin map.
- `.codex-plugin/plugin.json` - Codex plugin manifest.
- `.claude-plugin/plugin.json` - Claude plugin manifest.
- `.cursor-plugin/plugin.json` - Cursor plugin manifest.
- `.claude-plugin/marketplace.json` - Claude marketplace registration.
- `.agents/plugins/marketplace.json` - local plugin marketplace registration.
- `.config/opencode/plugins/traffic-one.js` - consented user-level OpenCode wrapper installed by `scripts/opencode-host.cjs`.
- `.opencode/traffic-one.json` - optional project-level OpenCode marker for explicit enable/disable overrides; no marker is required for normal auto-run behavior.
- `~/.config/kilo/plugin/traffic-one.js` - consented user-level Kilo server-plugin wrapper installed by `scripts/kilo-host.cjs`.
- `.kilo/traffic-one.json` - optional project-level Kilo marker for explicit enable/disable overrides; no marker is required for normal auto-run behavior.
- `~/.codeium/windsurf/hooks.json`, `~/.codeium/windsurf/mcp_config.json`, `~/.codeium/windsurf/memories/global_rules.md` - consented user-level Windsurf / Devin Desktop Cascade integration managed by `scripts/windsurf-host.cjs`.

## Hooks, Scripts, And CI

| File | Role |
| --- | --- |
| `settings.json` | Claude hook config for session start, prompt submit, write/edit checks, bash library allowlist, and post-write stack loading. |
| `hooks/hooks.json` | Codex hook config for session start, prompt submit, write/edit checks, bash library allowlist, graphify hints, page-speed gate, and stack loading. |
| `hooks/hooks-windsurf.json` | Windsurf / Devin Desktop Cascade hook template for user-prompt, read, write, command, and MCP pre/post events. |
| `~/.config/opencode/plugins/traffic-one.js` | OpenCode in-process JS plugin wrapper for session start and tool execute hooks; it invokes the shared Traffic One runtime for the OpenCode workspace root, stays silent for exact home sessions and explicit opt-outs, and does not expose OpenCode delegation tools. |
| `~/.config/kilo/plugin/traffic-one.js` | Kilo server-plugin wrapper for chat, system-transform, shell-env, and tool execute hooks; it invokes the shared Traffic One runtime with `--host=kilo`, stays silent for exact home sessions and explicit opt-outs, and does not expose OpenCode delegation tools. |
| `scripts/windsurf-hook-runtime.cjs` | Windsurf Cascade hook runtime shim; installer invocations stamp `--host=windsurf`. |
| `scripts/windsurf-host.cjs` | Windsurf user-level hook, MCP, global-rule installer, uninstaller, and doctor. |
| `.githooks/pre-commit` | Regenerates and stages generated plugin files. |
| `.githooks/prepare-commit-msg` | Adds `Integrated-With: Traffic One plugin <noreply@traffic.io>` commit trailer. |
| `.github/workflows/cursor-sync.yml` | CI check for generated Cursor artifacts, stack recommendation fixtures, and security runner fixtures. |
| `.github/workflows/traffic-one-security-check.yml` | CI pre-deployment security scanner with pinned `gitleaks` and `trufflehog`. |
| `scripts/hook-runtime.cjs` | Dependency-free hook runtime entrypoint. |
| `scripts/opencode-hook-runtime.cjs` | OpenCode host runtime shim; wrapper invocations stamp `--host=opencode`. |
| `scripts/opencode-host.cjs` | OpenCode wrapper installer, project enable/disable marker manager, uninstaller, and doctor. |
| `scripts/kilo-hook-runtime.cjs` | Kilo host runtime shim; wrapper invocations stamp `--host=kilo`. |
| `scripts/kilo-host.cjs` | Kilo wrapper installer, project enable/disable marker manager, uninstaller, and doctor. |
| `scripts/hook-runtime/config.cjs` | Hook runtime config constants. |
| `scripts/hook-runtime/detection/detection.cjs` | Project mode/stack detection helpers (one-file-per-function folder). |
| `scripts/hook-runtime/directives/directives.cjs` | Hook-time instruction/directive rendering (one-file-per-function folder). |
| `scripts/hook-runtime/handlers/handlers.cjs` | Main hook handlers, including plan gate, deploy gate, and package checks (one-file-per-function folder). |
| `scripts/hook-runtime/packing.cjs` | Rule/skill packing helpers. |
| `scripts/hook-runtime/skill-filters/skill-filters.cjs` | Skill filtering and cache mutation helpers (one-file-per-function folder). |
| `scripts/hook-runtime/stacks/stacks.cjs` | Stack-specific rule mapping (one-file-per-function folder). |
| `scripts/hook-runtime/state/state.cjs` | `.traffic-one/.one.json` state helpers (one-file-per-function folder). |
| `scripts/graphify-runner.cjs` | Codebase graph cache runner. |
| `scripts/lighthouse-runner.mjs` | Mobile Lighthouse production-preview runner. |
| `scripts/security-check-runner.cjs` | Traffic One pre-deployment security scanner. |
| `src/gen/index.ts` | Generates manifests, hook configs, agents, rules, skills, `.cursor/rules/*.mdc`, and `.devin/rules/*.md`; it also prunes retired generated artifacts. |

## Generated Cursor Mirrors

Generated from `src/modules/**` content by `npm run gen`.
Do not edit these directly; update the source rule or agent file first.

- `.cursor/rules/00-agent-senior-architect.mdc`
- `.cursor/rules/00-agent-senior-backend.mdc`
- `.cursor/rules/00-agent-senior-frontend.mdc`
- `.cursor/rules/00-agent-senior-reviewer.mdc`
- `.cursor/rules/00-agent-senior-shipper.mdc`
- `.cursor/rules/00-agent-senior-tester.mdc`
- `.cursor/rules/backend-cpp.mdc`
- `.cursor/rules/backend-csharp.mdc`
- `.cursor/rules/backend-golang.mdc`
- `.cursor/rules/backend-java.mdc`
- `.cursor/rules/backend-kotlin.mdc`
- `.cursor/rules/backend-node.mdc`
- `.cursor/rules/backend-perl.mdc`
- `.cursor/rules/backend-php.mdc`
- `.cursor/rules/backend-postgres.mdc`
- `.cursor/rules/backend-python.mdc`
- `.cursor/rules/backend-rust.mdc`
- `.cursor/rules/common-agent-handoff-digests.mdc`
- `.cursor/rules/common-clean-code.mdc`
- `.cursor/rules/common-codebase-graph.mdc`
- `.cursor/rules/common-dependencies.mdc`
- `.cursor/rules/common-documentation.mdc`
- `.cursor/rules/common-execution-discipline.mdc`
- `.cursor/rules/common-git.mdc`
- `.cursor/rules/common-library-catalog.mdc`
- `.cursor/rules/common-package-architecture.mdc`
- `.cursor/rules/common-project-memory.mdc`
- `.cursor/rules/common-quality-tooling.mdc`
- `.cursor/rules/common-security.mdc`
- `.cursor/rules/common-senior-engineer-team.mdc`
- `.cursor/rules/common-stack-recommendations.mdc`
- `.cursor/rules/core.mdc`
- `.cursor/rules/frontend-accessibility.mdc`
- `.cursor/rules/frontend-performance.mdc`
- `.cursor/rules/frontend-realtime.mdc`
- `.cursor/rules/frontend-services.mdc`
- `.cursor/rules/frontend-testing.mdc`
- `.cursor/rules/frontend-typography.mdc`
- `.cursor/rules/frontend-ui-quality.mdc`
- `.cursor/rules/ionic-accessibility.mdc`
- `.cursor/rules/ionic-capacitor.mdc`
- `.cursor/rules/ionic-components.mdc`
- `.cursor/rules/ionic-core.mdc`
- `.cursor/rules/ionic-navigation.mdc`
- `.cursor/rules/ionic-performance.mdc`
- `.cursor/rules/ionic-realtime.mdc`
- `.cursor/rules/ionic-security.mdc`
- `.cursor/rules/ionic-services.mdc`
- `.cursor/rules/ionic-stores.mdc`
- `.cursor/rules/ionic-styles.mdc`
- `.cursor/rules/ionic-testing.mdc`
- `.cursor/rules/mode-existing-codebase.mdc`
- `.cursor/rules/mode-new-project.mdc`
- `.cursor/rules/mode-supabase-migration.mdc`
- `.cursor/rules/react-components.mdc`
- `.cursor/rules/react-core.mdc`
- `.cursor/rules/react-design-quality.mdc`
- `.cursor/rules/react-native-accessibility.mdc`
- `.cursor/rules/react-native-components.mdc`
- `.cursor/rules/react-native-core.mdc`
- `.cursor/rules/react-native-navigation.mdc`
- `.cursor/rules/react-native-performance.mdc`
- `.cursor/rules/react-native-realtime.mdc`
- `.cursor/rules/react-native-security.mdc`
- `.cursor/rules/react-native-services.mdc`
- `.cursor/rules/react-native-stores.mdc`
- `.cursor/rules/react-native-styles.mdc`
- `.cursor/rules/react-native-testing.mdc`
- `.cursor/rules/react-performance.mdc`
- `.cursor/rules/react-realtime.mdc`
- `.cursor/rules/react-security.mdc`
- `.cursor/rules/react-services.mdc`
- `.cursor/rules/react-stores.mdc`
- `.cursor/rules/react-supabase-client.mdc`
- `.cursor/rules/react-testing.mdc`
- `.cursor/rules/react-vite.mdc`

## Exclusions

- `.DS_Store`, `.idea/*`, and `scripts/__pycache__/*` are not plugin reference sources.
- `.cursor/rules/*.mdc` files are generated mirrors and are listed, but their source
  content is the corresponding `rules/*.md` or `agents/*.md` file.
