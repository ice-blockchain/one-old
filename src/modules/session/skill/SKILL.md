---
name: traffic-one-session-guard
description: Wording source for the Traffic One plugin-authoring repository guard. Read at runtime through skillBlock(); enforcement lives in TypeScript.
---

# Traffic One Session Guard

This module retains the plugin-authoring repository guard used by the session
runtime. Authentication is handled by the local setup wizard and has no
chat/modal directive blocks here.

It also owns the wording of the WORKSPACE MEMBER fence, which is resolved in
`shared/tool-scope.ts` and returned by every PreToolUse gate: a Traffic One
workspace root is a container of independent member projects, and no gate may
operate on the container itself. The four blocks are four angles on one cause
(`workspace-member-unresolved`) and each has a verbatim TypeScript fallback, so
a missing block never disables the fence.

<!-- T1BLOCK:BEGIN authoring-write-guard -->
traffic-one — blocked: "{{PATH}}" is inside the Traffic One plugin source repository ({{ROOT}}). This repo is the plugin's own codebase, never a Traffic One project: do not create or touch `.traffic-one/**` here (no .one.json, manifest.json, one-mcp-report.json, runs/, rules/skills copies) and do not write generated AGENTS.md/CLAUDE.md project context into it. Shell commands referencing `.traffic-one` under this root are blocked unless clearly read-only — if your command was a read, re-run it in a form the classifier can verify (plain `grep`/`ls`/`cat` on absolute paths, no command substitution). Traffic One conventions inherited from a parent directory's AGENTS.md do not apply inside this repo. Continue the user's task with plain source edits.
<!-- T1BLOCK:END authoring-write-guard -->

<!-- T1BLOCK:BEGIN workspace-member-unresolved-outside -->
traffic-one — blocked: {{PATHS}} is inside the Traffic One workspace {{WORKSPACE}}, and belongs to no member project that workspace has registered. A workspace root is a CONTAINER of independent member projects, never a project itself — it holds no plan, no compiled architecture, no run state and no role claims — so no gate has anything at this level to judge this call against. The members it registered are: {{MEMBERS}}. Re-issue this call against exactly one of them: give it a path under that member, and if it is a shell command run it with that member directory as the working directory.
<!-- T1BLOCK:END workspace-member-unresolved-outside -->

<!-- T1BLOCK:BEGIN workspace-member-unresolved-split -->
traffic-one — blocked: this call spans {{COUNT}} members of the Traffic One workspace {{WORKSPACE}} at once — {{TOUCHED}} — through {{PATHS}}. Each member is an independent project with its own plan, run state and role claims, so a call crossing two of them has no single project to be judged against and no single owner to be attributed to; nothing here refuses the work, only the shape of the call. Split it into one call per member and issue them one at a time, starting with {{FIRST}}.
<!-- T1BLOCK:END workspace-member-unresolved-split -->

<!-- T1BLOCK:BEGIN workspace-member-unresolved-empty -->
traffic-one — blocked: {{WORKSPACE}} is a Traffic One workspace that has registered no member projects at all, so {{PATHS}} sits in a container with no project in it. A workspace root holds no plan, no run state and no role claims — its MEMBERS are the projects — and registering one is a setup step no tool call can perform, so re-issuing this will produce this same refusal. Report it to the user as BLOCKED, naming {{WORKSPACE}} and its empty member registry, so they can run setup for the directory they want worked on.
<!-- T1BLOCK:END workspace-member-unresolved-empty -->

<!-- T1BLOCK:BEGIN workspace-member-unresolved-registry -->
traffic-one — blocked: {{WORKSPACE}} is a Traffic One workspace whose member registry could not be read — {{WHY}} — so {{PATHS}} cannot be attributed to a member and no gate can judge it. Traffic One's `.traffic-one/.one.json` is runtime-owned state: editing it by hand is itself denied, so there is nothing here for you to repair. Report this to the user as BLOCKED, quoting {{WORKSPACE}} and {{WHY}} verbatim so they can restore the registry or re-run setup.
<!-- T1BLOCK:END workspace-member-unresolved-registry -->
