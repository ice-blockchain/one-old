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
   - Conversation length and stale tool output from earlier exploration
   - Extended-thinking / high-reasoning mode on tasks that do not need it
   - Subagent fan-out, duplicate role prompts, repeated waits, and missing
     handoff digests that force later agents to re-read full diffs
   - Model/reasoning tier choices and retry loops that exceed the task's risk
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

## Nine overhead patterns to check

Apply these overhead checks to Traffic One and all supported host agents
harnesses:

1. **Instruction bloat** — keep always-on `AGENTS.md` / `CLAUDE.md` concise;
   move stack-specific and rare guidance behind path-scoped rules or skills.
2. **Conversation re-read tax** — after roughly 15-20 turns, create a compact
   handoff summary or plan and continue from that instead of stacking follow-ups.
3. **Hook injection tax** — hooks should prefer UI/status messages or hard
   gates. Any hook that injects prompt context every turn needs a specific
   recurring reason.
4. **Cache-miss resume tax** — after long pauses, expect stable context to be
   reprocessed. Keep stable context small enough that a cache miss is tolerable.
5. **Irrelevant skill loading** — tighten `description:` trigger phrases and
   split large skills into references so only the needed body loads.
6. **Always-on tool schema tax** — keep MCP servers/connectors opt-in unless
   they are used in most sessions.
7. **Unneeded deep reasoning** — default to normal reasoning for simple edits;
   increase effort only for architecture, security, debugging, ambiguity, and
   cross-file invariants.
8. **Wrong-direction generation** — stop early when a response or edit direction
   is clearly wrong; redirect before producing hundreds of wasted lines.
9. **Plugin startup noise** — avoid "loaded successfully" context and redundant
   SessionStart messages. Session-start hooks should either gate, configure, or
   stay silent.

## Cheap wins (apply first)
- Move always-on rules behind `paths:` globs whenever possible — only `core.md`, `common/clean-code.md`, `common/security.md`, `common/git.md` should be truly always-on.
- UserPromptSubmit hooks: emit a short `systemMessage` (UI only — free) instead of `additionalContext` (costs tokens every prompt). Our hook already does this; keep it that way.
- Remove MCP servers that just wrap a CLI the agent can call via Bash.
- Keep 3-5 frequently used skills active in a given harness; archive or disable
  rarely used skills until needed.
- Keep subagent fan-out for work that can run in parallel with disjoint context;
  avoid spawning multiple agents that will all read the same broad diff.
- Reserve high reasoning/model effort for high-risk judgment work. Use local
  tools, deterministic scripts, and normal effort for mechanical edits.
- Target always-on instruction files below roughly 1,200 words combined where
  the host runtime allows it. Use progressive disclosure for everything else.

## Rule of thumb
If the session feels slow or output quality drops, you are probably past the last 20% of the window. Trim before refactoring.
