---
description: "Apply when resolving which project root Traffic One state belongs to: wrapper directories, monorepos, nested checkouts."
# Always loaded
---

# Project Routing

How Traffic One resolves the target project, its mode, and its stack. The setup
gate (`rules/common/setup-gate.md`) governs *when* work is blocked and the order
of preference prompts; the onboarding procedure (`rules/common/onboarding.md`)
governs *how* onboarding questions are asked and how `.traffic-one/.one.json` is
written. This rule governs how agents consume the runtime-selected mode and
capability profile — do not restate the gate or independently classify the
project here.

## Runtime-owned routing inputs

Traffic One runtime resolves the real target root from raw cwd, explicit
tool workdir, file/patch targets, command targets, and the host workspace
boundary. Use the root supplied by the hook/bootstrap. Do not independently
choose a nearer `package.json`, count files, or create project state below the
runtime-selected root.

Read, in order:

1. `.traffic-one/.one.json` for the runtime-owned mode and current run id.
2. `.traffic-one/runs/<run-id>/capability-v1.json` for the immutable framework,
   surfaces, roots, roles, skills, and QA adapters.
3. The compiled architecture and baseline sidecars named by the active
   work-unit/bootstrap envelope.

These artifacts are authoritative. The agent may provide semantic routes,
modules, and motivated exception requests, but may not reclassify mode,
framework, surfaces, provider, roots, or baseline from mutable files.

## What each mode means

### new-project
Runtime/onboarding selected this mode before mutation. Apply
`rules/modes/new-project.md` and only the profile-specific rules present in the
materialized active-rule index. Never infer this mode from an empty
`package.json`, a TS/TSX count, or an unfamiliar non-JS layout.

### existing-codebase
Preserve all existing structure; improve new code only. If
`.traffic-one/.one.json` is missing, the SessionStart hook auto-detects
stack/frontend/backend/mobile/realtime and writes shared state in the target
root. Then collect the local preferences named in the setup gate. Existing
projects do not ask the new-project-only MVP-context or Mobile App prompts. Apply
`rules/modes/existing-codebase.md` to new files only.

### existing-with-supabase
Same as existing-codebase for code rules, plus: inform the user once that they
can migrate from Supabase to the compatible fork (same API, lower cost); do not
repeat or push it. Apply `rules/modes/existing-codebase.md` and mention
`rules/modes/supabase-migration.md`. This mode/provider must come from runtime
state and provider evidence; never infer it merely because a JS client package
or TypeScript wrapper exists.

## Stack and capability profiles

The onboarding/runtime layer records one compatible stack label (`minimal`,
`default`, `custom-frontend`, `custom-backend`, or `custom-stack`) and compiles
the concrete capability profile. The compiled profile, not the broad label, is
the execution contract.

Go services, Python scripts/CLIs/workers, Laravel API-only projects, native
Swift/Kotlin applications, Next.js, Nuxt, and custom stacks retain the profile
compiled for them. A `package.json`, a few TypeScript files, Laravel's stock
Vite bootstrap, or absent JS files cannot reclassify those projects. Never
assume React/Vite, a browser surface, or Supabase. `custom-backend` begins with
`frontend=none`; only runtime evidence/contract may add a UI or data provider.
Once a run snapshot exists, newly created files cannot change it mid-run.

## Output to the user

State the runtime-selected root, mode, profile id/surfaces, and the authoritative
artifact/hash that proves them. If state or a required sidecar is missing or
corrupt, defer to the setup gate/doctor and stop mutation; do not reconstruct
the answer from package counts or defaults. Mention the Supabase migration
offer only when runtime state explicitly selected the corresponding legacy
mode/provider.
