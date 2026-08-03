---
description: "Apply only when CompiledArchitectureV1 profileId=unsupported-hybrid: block until one runtime/user-owned UI architecture target is selected."
---

# New Project Profile — Unresolved Web + Native Hybrid

Apply only when
`CompiledArchitectureV1.profile.profileId=unsupported-hybrid`. This is a
fail-closed state, not an architecture. It means runtime detected both
`web-ui` and `native-ui` but no single structural target was selected.

Do not produce a tree, merge web and native roots, scaffold both applications,
choose the cheaper target, or let the architect write a profile id. Report the
`CAPABILITY_HYBRID_UI_TARGET_REQUIRED` blocker.

Runtime/user-owned onboarding must set `architectureTarget` to exactly one of:

- `web-ui` — compile the detected web framework profile; or
- `native-ui` — compile the detected native framework profile.

Then mint/recompile the immutable capability and architecture contracts and
read the exact resulting profile rule. The unselected surface may remain
recorded in `profile.uiFrameworks`, but it grants no outputs. No implementer
starts until `blockingIssues` is empty and the new `allowedOutputs` and work
units exist.
