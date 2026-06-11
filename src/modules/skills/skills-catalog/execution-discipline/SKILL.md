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

## Full behavioral baseline

The complete discipline (think-before-coding, simplicity-first, surgical
changes, goal-driven execution, agent run control, external-action boundaries)
lives in `rules/common/execution-discipline.md` — the always-on source of
truth. Read it for non-trivial work instead of restating it here.

Review-only addition not in the rule: review AI-generated code for hidden
coupling, edge cases, data integrity, auth assumptions, and rollout risk
before style preferences.
