---
name: context-budget
description: PROACTIVELY audit the session's token consumption across rules, skills, hooks, and MCP servers when context feels bloated, responses feel slow, or the user asks about token usage, context window, or what can be trimmed. Identifies redundant components and produces a prioritized token-savings plan.
---

# Context Budget Audit

Estimate how much of the context window is consumed by plugin components and propose cuts.

## When to run
- User mentions tokens, context window, slow responses, bloat, or "what's loaded".
- Recent additions (skills, MCPs, rules) feel heavy.
- Before adding a major new component, to confirm there's headroom.

## Heuristics
- **Prose**: `tokens ≈ words × 1.3`
- **Code / mixed**: `tokens ≈ chars / 4`
- **MCP tool schema**: ~500 tokens per tool

## Audit steps
1. **Inventory** — list every loaded component and estimate tokens:
   - `CLAUDE.md` / `AGENTS.md` chain
   - Active rule files (respect `paths:` frontmatter — files that don't match the current work are free)
   - Skill metadata (the `description:` lines are always loaded; SKILL bodies load only on trigger)
   - Hooks' `additionalContext` output
   - MCP servers × tool count
2. **Classify** each into:
   - **Always needed** — keep
   - **Sometimes needed** — narrow its `paths:` / `description:` so it loads only when relevant
   - **Rarely / never** — delete or move behind an opt-in
3. **Flag bloat**:
   - Any single rule file > 100 lines → split or path-scope
   - Any skill SKILL.md > 400 lines → split
   - Description frontmatter > 30 words → tighten
   - Two files covering overlapping content → merge
4. **Report**: top 3 savings ranked by `tokens_saved × frequency_loaded`.

## Cheap wins (apply first)
- Move always-on rules behind `paths:` globs whenever possible — only `core.md`, `common/clean-code.md`, `common/security.md`, `common/git.md` should be truly always-on.
- UserPromptSubmit hooks: emit a short `systemMessage` (UI only — free) instead of `additionalContext` (costs tokens every prompt). Our hook already does this; keep it that way.
- Remove MCP servers that just wrap a CLI the agent can call via Bash.

## Rule of thumb
If the session feels slow or output quality drops, you are probably past the last 20% of the window. Trim before refactoring.
