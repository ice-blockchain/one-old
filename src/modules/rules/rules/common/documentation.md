---
description: "Apply when creating or updating project documentation or READMEs, or after adding features/services that change public behavior."
# Human and agent documentation defaults
---

# Auto-Documentation Defaults

When the user asks to generate, refresh, or audit project documentation, invoke
`auto-documentation-generator`. The goal is useful docs that humans and agents
actually read, not a wall of generated boilerplate.

For `mode: new-project`, this is mandatory across every stack, even when the
user does not ask for docs explicitly. Every generated site/app/service must
finish with the canonical docs that apply to the scaffold, or an
`Unverified`/`Skipped` entry explaining the exact missing fact. Do not call a
new project complete with only a lightweight README.

For `mode: existing-codebase` and `mode: existing-with-supabase`, reconcile the
documentation baseline before normal feature work across every detected or
fallback stack when docs are missing or stale. If a canonical doc does not
exist, create it from verified repo facts at its canonical path. Human entry
docs stay at the repo root; detailed operational docs live under `.traffic-one/`.
If legacy canonical docs exist at the repo root or under `docs/`, migrate them
to the canonical path when that can be done without dropping newer content.

## Canonical docs

The canonical documentation set — which files exist (`README.md`, `AGENTS.md`,
`CLAUDE.md`, `.traffic-one/plan.md`, ADRs, api/database/
deployment/security/environment-setup docs, `CHANGELOG.md`, `CONTRIBUTING.md`,
`llms.txt`), what each is for, and its required content — is defined in the
`auto-documentation-generator` skill's Documentation Set table. That table is
the source of truth; consult it instead of a forked list here.

## Guardrails

- Update existing docs before creating new files.
- Prefer links and file references over duplicated prose.
- Mark unknown facts `Unverified` with the exact command or user input needed.
- No placeholder sections, fake URLs, secret values, or production data dumps.
