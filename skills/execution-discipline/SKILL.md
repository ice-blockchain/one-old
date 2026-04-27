---
name: execution-discipline
description: >
  Use when the user asks for Karpathy-style coding guidelines, surgical edits,
  simpler implementation, avoiding overengineering, clarifying assumptions,
  defining success criteria, or making an agent behave more carefully on coding
  tasks. Triggers: "Karpathy", "think before coding", "surgical changes",
  "keep it simple", "overcomplicated", "success criteria", "goal-driven".
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
5. **Loop honestly** - run the checks when feasible. If blocked, report the exact
   blocker and the residual risk.

Use `rules/common/execution-discipline.md` as the source of truth when updating
the always-on rule text.
