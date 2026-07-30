---
description: "Read on demand for every new-project CompiledArchitectureV1 profile: select the exact architecture catalog entry and apply common backend, QA, environment, and Ionic overlays."
---

# New Project Architecture Catalog

This is the stack-neutral architecture control plane for new projects. It is
not a fallback architecture and it does not grant outputs. Select exactly one
profile rule from `CompiledArchitectureV1.profile.profileId`; never infer a
profile from a framework name, an empty repository, or this catalog.

The architect supplies only semantic `ArchitectureInputV1` routes, modules,
i18n locale/brand intent, and narrow exception requests. Eligible implementers, not the architect,
create the exact files assigned by their `WorkUnitContractV1`. If this catalog
describes a convention but the compiled `allowedOutputs` omit its file, replan
and recompile instead of writing it.

Every selected `web-ui` or `native-ui` profile compiles a profile-native i18n
runtime/resource baseline. React catalogs always end in
`i18n/locales/<lang>/<namespace>.json`; non-React profiles keep their native
resource format. UI-free profiles compile no i18n outputs.

## Profile index

| `profileId` | Read-on-demand architecture |
| --- | --- |
| `vite-react` | `rules/modes/new-project-vite-react.md` |
| `next-app` | `rules/modes/new-project-next-app.md` |
| `next-pages` | `rules/modes/new-project-next-pages.md` |
| `nuxt` | `rules/modes/new-project-nuxt.md` |
| `vue` | `rules/modes/new-project-vue.md` |
| `sveltekit` | `rules/modes/new-project-sveltekit.md` |
| `svelte` | `rules/modes/new-project-svelte.md` |
| `astro` | `rules/modes/new-project-astro.md` |
| `angular` | `rules/modes/new-project-angular.md` |
| `server-rendered` | `rules/modes/new-project-server-rendered.md` |
| `generic-web` | `rules/modes/new-project-generic-web.md` |
| `unsupported-hybrid` | `rules/modes/new-project-unsupported-hybrid.md` — blocking, no scaffold |
| `react-native` | `rules/modes/new-project-react-native.md` |
| `swift-native` | `rules/modes/new-project-swift-native.md` |
| `kotlin-native` | `rules/modes/new-project-kotlin-native.md` |
| `flutter-native` | `rules/modes/new-project-flutter-native.md` |
| `backend-only` | `rules/modes/new-project-backend-only.md` |

## Universal repository control plane

The repository shell and Traffic One control plane are distinct ownership
domains:

```text
<repo-root>/
├── README.md                         compiled scaffold
├── .gitignore                       compiled scaffold
├── .editorconfig                    compiled scaffold
├── .github/workflows/ci.yml         compiled scaffold
├── .prettierrc                      conditional Node tooling
├── .prettierignore                  conditional Node tooling
├── .nvmrc                           conditional Node tooling
├── .env.example                     conditional environment contract
├── AGENTS.md                        Traffic One materializer
├── CLAUDE.md -> AGENTS.md           materializer, only when absent
├── .traffic-one/                    control plane, never scaffold output
│   ├── .one.json
│   ├── .agentignore
│   ├── product.md
│   ├── plan.md
│   ├── stack.md
│   ├── coding.md
│   ├── security.md
│   ├── api.md
│   ├── database.md
│   ├── deployment.md
│   ├── environment-setup.md
│   ├── known-issues.md
│   ├── schema.sql
│   ├── deployments.jsonl           shipper-only, first deploy — never pre-created
│   ├── agent-log.md
│   ├── decisions/
│   ├── rules/
│   ├── skills/
│   ├── manifest.json
│   ├── runs/
│   ├── digests/
│   └── reports/
└── <selected profile structure>
```

`README.md`, `.gitignore`, `.editorconfig`, and `ci.yml` each compile exactly
once. The owner is `senior-frontend` for a selected UI target and otherwise
`senior-backend`. `AGENTS.md`, `CLAUDE.md`, and every `.traffic-one/**` path
are explicitly absent from implementer `scaffoldOutputs`, `allowedOutputs`,
and work-unit allowlists.

## How to read a compiled topology

The immutable contract, not an illustrative tree, resolves every variable:

1. `profile.sourceRoots`, `profile.entrypoints`, and `profile.layerRoots` freeze the
   detected or planned roots. Runtime selects an existing entrypoint, then a
   parent-backed candidate, otherwise the first profile candidate.
2. `modules[].output` and `routes[].moduleOutput` are the concrete results of
   the semantic plan. Route-aware frameworks own their file-router locations.
3. `scaffoldOutputs[]` adds deterministic repository, framework, backend, test,
   and tooling files with one owner each.
4. `allowedOutputs` is the closed union. A path shown in a profile document is
   still unwritable unless it appears here and in the active work unit.

Candidate roots in the profile are precedence lists, not instructions to
create every candidate directory. Existing immutable baseline evidence wins.

## Common new-project overlays

Every selected implementation surface can compile repository scaffolding:
`.gitignore`, `README.md`, `.editorconfig`, and `.github/workflows/ci.yml`.
The selected Node package can additionally compile `.prettierrc`,
`.prettierignore`, and `.nvmrc` beside its `package.json`. A web package rooted
under `apps/*` or `packages/*` also compiles root `package.json`,
`pnpm-workspace.yaml`, `turbo.json`, and `tsconfig.base.json`. Any compiled
output under `packages/<name>/` causes that package's `package.json` to be
owned by the same implementation role unless already present.

At that one tooling root, the manifest declares `prettier` plus real `format`
and `format:check` scripts. Both check the WHOLE project — `prettier --write .`
and `prettier --check .` — with exclusions expressed only in `.prettierignore`,
never as narrowed path arguments. A script that lists a few globs passes while
every source outside them is unformatted: observed 6co, a root `lint` covering
`apps/web/src` and three `packages/*` reported success while a plain
`prettier --check .` failed on 25 files, including all of `packages/api-client`,
every test, and `vitest.config.ts`. When the tooling root is the repository
root, `.prettierignore` excludes `.traffic-one/`, dependencies, generated/build
artifacts, lockfiles, coverage, and runtime reports. Non-Node targets use their
native formatter and do not receive a synthetic Node manifest.

When a React Native target and an owned Node backend share root `package.json`,
the selected UI implementation owner is the single manifest integration owner.
That manifest must include both surfaces' declared dependencies and scripts;
the backend reports its requirements through the contract/digest and does not
claim a second writable copy.

These are conditional compiler results, not universal files. Always read the
actual `scaffoldOutputs`.

### Backend scaffold matrix

The backend overlay applies only when `senior-backend` is an eligible role:

| `backendFramework` | Deterministic scaffold outputs |
| --- | --- |
| `go` | `go.mod`, `go.sum` |
| `python`, `django`, `fastapi` | `pyproject.toml` |
| `laravel`, `php` | `composer.json`, `artisan` |
| `rust` | `Cargo.toml` |
| `java` | `pom.xml` |
| `kotlin` | `build.gradle.kts` |
| `dotnet` | `Directory.Build.props` |
| `supabase`, `our-fork` | `supabase/config.toml`, `supabase/migrations/0001_init.sql`, `supabase/seed.sql`, `packages/api-client/src/database.types.ts` |
| another owned backend with no web UI | root `package.json` |

UI-profile `service` and `store` modules move to the owned backend when one is
selected: Supabase/our-fork uses `packages/api-client/src/`, Go uses
`internal/`, Python-family backends use `services/api/`, PHP-family backends
use `app/Services/`, and other owned backends use `services/api/src/`. Use the
compiled module path; do not duplicate a browser-side service.

### Test and QA overlay

Module-derived tester outputs are authoritative only when they appear in
`scaffoldOutputs`; do not infer an extra test path from this catalog. The
compiler also adds these deterministic QA infrastructure outputs:

| Surface/profile | Deterministic QA outputs and adapter |
| --- | --- |
| any `web-ui` | root `vitest.config.ts`, `playwright.config.ts`, `tests/e2e/smoke.spec.ts`; Playwright |
| `react-native` | `.maestro/flows/smoke.yaml`; Maestro |
| `swift-native` | `Tests/AppSmokeTests.swift`; Xcode simulator |
| `kotlin-native` | `app/src/androidTest/AppSmokeTest.kt`; Android emulator |
| `flutter-native` | `integration_test/app_test.dart`; Flutter driver |
| Python-family backend-only | `tests/conftest.py` |
| PHP-family backend-only | `phpunit.xml` |

Run only adapters in the immutable capability/verification contracts. A
missing binary or platform is `blocked-environment`, not a reason to substitute
an unselected harness.

### External API environment names

`external-api` is an integration, not an owned backend, and does not by itself
grant `senior-backend`. For a web external-API profile the compiler assigns
`.env.example` to the frontend; an owned backend assigns it to the backend.
Document names only—never values or secrets:

- React/Vite, Vue, and plain Vite Svelte: `VITE_API_URL`.
- Next.js: `NEXT_PUBLIC_API_URL` for browser-visible configuration and
  `API_URL` for server-only use.
- Nuxt: `NUXT_PUBLIC_API_BASE` in public runtime config and
  `NUXT_API_BASE` server-side.
- SvelteKit and Astro: `PUBLIC_API_URL` client-side and `API_URL` server-side.
- Angular: a non-secret `API_URL` supplied through the app's selected runtime
  configuration mechanism.
- Laravel/server-rendered: `API_URL` server-side; `VITE_API_URL` only when the
  browser must receive it.
All public-prefixed values are readable by end users. Credentials remain
server-side or in platform secret storage. Do not invent an environment
adapter or config source outside `allowedOutputs`. Native external-API profiles
do not receive `.env.example` from this baseline; use a platform build
configuration only when its exact path is compiled.

## Ionic/Capacitor overlay

Apply this overlay when `CapabilityProfileV1.skillBuckets` includes
`ionic-capacitor`. Ionic/Capacitor has no separate `StructuralProfileId`.
Runtime keeps whichever web profile was selected—such as `vite-react`, `vue`,
`angular`, or a compatible `generic-web` profile—and adds the
`ionic-capacitor` skill/rule bucket. The base profile remains authoritative:

- preserve its framework, router, source roots, components, and formatter;
- default to a Capacitor wrapper around that one web application;
- use `@ionic/react`, `@ionic/vue`, or `@ionic/angular` only when a full Ionic
  UI rewrite is explicitly selected for the matching base framework;
- never translate a Vue or Angular project into React as an Ionic default;
- use React Native only when React Native/Expo is explicitly selected.

The current architecture contract does not automatically grant
`capacitor.config.*`, `ionic.config.json`, `ios/`, or `android/`. Create such
outputs only when they appear in the compiled work unit. The QA adapter remains
the selected web adapter (normally Playwright) unless runtime compiles a
different verification contract.
