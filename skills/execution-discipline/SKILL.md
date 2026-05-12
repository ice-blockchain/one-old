---
name: execution-discipline
description: >
  Use when the user asks for disciplined coding guidelines, surgical edits,
  simpler implementation, avoiding overengineering, clarifying assumptions,
  defining success criteria, or making an agent behave more carefully on coding
  tasks. Also use for CLAUDE.md-style behavioral rules, agent guardrails,
  checkpoints, fail-loud rules, and model-versus-code decision boundaries.
  Also use for research-before-coding, eval-first implementation, agent-sized
  work units, and cost-aware reasoning/model routing.
  Triggers: "think before coding", "surgical changes", "keep it simple",
  "overcomplicated", "success criteria", "goal-driven", "read before write",
  "fail loud", "checkpoint", "CLAUDE.md rules".
metadata:
  source: everything-claude-code
  source_path: skills/execution-discipline/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Skill: Execution Discipline

Apply the compact behavioral checklist before and during implementation.

1. **Clarify assumptions** - name any ambiguity that could change behavior,
   security, data shape, or user experience. Ask only when guessing would be risky.
2. **Choose the smallest path** - prefer the least code and the existing local
   pattern that solves the request. Do not add future-proofing.
3. **Keep edits surgical** - touch only lines required by the request or by
   verification fallout. Preserve neighboring style and formatting.
4. **Define verification** - turn the task into concrete checks: failing test,
   typecheck, targeted unit test, manual reproduction, or diff review.
5. **Search before building** - find local helpers and approved stack defaults
   before creating new utilities or dependencies. Use current docs for
   version-sensitive APIs.
6. **Loop honestly** - run the checks when feasible. If blocked, report the exact
   blocker and the residual risk.

## Extended behavioral rules

Use this 12-rule layer for non-trivial coding-agent work:

1. Think before coding: state assumptions, ambiguity, and uncertainty.
2. Simplicity first: solve the current problem only.
3. Surgical changes: touch only the requested surface and verification fallout.
4. Goal-driven execution: define success and loop until it is verified.
5. Model for judgment only: code handles deterministic routing, retries,
   status handling, parsing, formatting, and repeatable transforms.
6. Token budgets matter: when context grows stale or large, summarize and reset
   rather than continuing in a degraded session.
7. Surface conflicts: do not average contradictory local patterns.
8. Read before writing: exports, immediate callers, and shared utilities first.
9. Tests verify intent: passing shallow tests is not enough evidence.
10. Checkpoint long tasks: what changed, what is verified, what remains.
11. Convention beats novelty: conformance over taste inside existing code.
12. Fail loudly: surface skipped checks, uncertainty, and partial success.

## Agentic execution layer

- Define the capability check and regression check before AI-generated edits.
- Split work into independently verifiable units with one dominant risk.
- Use deeper reasoning for architecture, security, root-cause debugging, and
  cross-file invariants; keep routine transforms on normal effort.
- Review AI-generated code for hidden coupling, edge cases, data integrity,
  auth assumptions, and rollout risk before style preferences.

Use `rules/common/execution-discipline.md` as the source of truth when updating
the always-on rule text.
