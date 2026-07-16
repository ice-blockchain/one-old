---
name: traffic-one-session-guard
description: Wording source for the Traffic One plugin-authoring repository guard. Read at runtime through skillBlock(); enforcement lives in TypeScript.
---

# Traffic One Session Guard

This module retains the plugin-authoring repository guard used by the session
runtime. Authentication is handled by the local setup wizard and has no
chat/modal directive blocks here.

<!-- T1BLOCK:BEGIN authoring-write-guard -->
traffic-one — write blocked: "{{PATH}}" is inside the Traffic One plugin source repository ({{ROOT}}). This repo is the plugin's own codebase, never a Traffic One project: do not create `.traffic-one/**` here (no .one.json, manifest.json, one-mcp-report.json, runs/, rules/skills copies) and do not write generated AGENTS.md/CLAUDE.md project context into it. Traffic One conventions inherited from a parent directory's AGENTS.md do not apply inside this repo. Continue the user's task with plain source edits.
<!-- T1BLOCK:END authoring-write-guard -->
