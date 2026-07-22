---
name: traffic-one-materialize
description: Wording source for the Traffic One PostToolUse materialize/post-stack-setup messages (digest-size warning). Read at runtime via skillBlock(); the dispatch logic lives in TS.
---

# Traffic One Materialize / Post-Stack-Setup

PostToolUse message wording. Dispatch and materialization are implemented by the
installed Traffic One runtime. `{{PLACEHOLDER}}` tokens are filled by the
handler. Each block has a verbatim fallback in code.

<!-- T1BLOCK:BEGIN digest-size -->
[digest-size] Your `{{ROLE}}.md` digest is {{KB}} KB; the spec target is ≤2 KB (see `rules/common/agent-handoff-digests.md`). Re-write before completing your turn:
  1. Use repo-relative paths, never absolute (drop `/Users/.../` prefixes).
  2. Touched: file paths only, no parenthetical annotations.
  3. Public contracts: delta-only — what changed vs the plan, not the full surface.
  4. Open questions: at most 3 bullets; link to plan §, do not inline rationale.
Reviewer / tester / shipper read this digest INSTEAD of the diff; bloated digests defeat the token-economy layer.
<!-- T1BLOCK:END digest-size -->
