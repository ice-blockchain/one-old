---
description: "Apply to every brand-new Traffic One project: compile the runtime-owned capability and architecture contracts before scaffolding, then follow only the selected profile."
# Loaded when mode = new-project (≤5 source files detected)
---

# Mode: New Project — Capability Contract First

A new project does not imply a particular language, framework, directory tree,
role lineup, or test tool. Treat `.traffic-one/.one.json` as onboarding input,
not as permission to invent a default surface.

## Runtime authority

Before scaffolding, require the current run's immutable capability snapshot and
runtime-compiled architecture contract. They own:

- project surfaces and framework;
- router, source roots, entrypoints, and layer roots;
- eligible roles and skills;
- allowed outputs and assignment allowlists;
- verification adapters and required QA.

The architect supplies semantic routes, modules, and narrow exception requests.
It must not write profile ids, roots, output paths, ownership, scanner limits,
baseline data, or verification requirements into its input. If a needed output
is absent, replan and recompile before implementation; never widen the contract
during a child run.

## Scaffold protocol

1. Complete onboarding and establish the run id.
2. The architect writes only the semantic plan/project memory,
   `ArchitectureInputV1`, and its digest. It never creates packages, workspace
   files, configs, Tailwind assets, barrels, tests, source, or assignments.
3. Let the runtime compile and hash `CompiledArchitectureV1`,
   `VerificationContractV2`, runtime-owned assignments, and every eligible
   `WorkUnitContractV1`/bootstrap before any implementer spawn.
4. Each eligible implementer scaffolds only the framework, roots, entrypoints,
   modules, tests, and configuration in its compiled outputs/allowlist. Use the
   active profile's package/build conventions.
5. Keep each child inside its compiled output allowlist. A missing planned
   source, test, config, or generated artifact is a replan, not an ad-hoc write.
6. Run the selected verification adapters and stack-native build, lint, and test
   commands. Missing required tooling is `blocked-environment`, never verified.

The runtime materializes a profile-specific new-project rule only when the
selected profile has one. Read that rule before scaffolding. If no
profile-specific rule is present in the active rule index, follow this spine
plus the compiled contracts and the stack rules already selected by runtime.

## Universal completion baseline

- Create and maintain the canonical `.traffic-one/` project memory and
  architecture artifacts.
- Keep runtime-owned contracts, assignments, hashes, baselines, model policies,
  and bootstraps read-only; replan semantic input instead of editing them.
- Keep configuration deterministic, secrets out of source, and dependency
  choices stack-native.
- Produce real verification evidence for the selected surfaces; never claim
  checks that the active adapter did not run.
- Do not add an unselected application surface, framework, workspace topology,
  data provider, role, skill, or QA adapter as a convenience default.
