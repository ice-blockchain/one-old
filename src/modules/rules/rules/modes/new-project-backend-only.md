---
description: "Apply only when CompiledArchitectureV1 profileId=backend-only: API/CLI/worker/data architecture without a frontend surface."
---

# New Project Profile — Backend Only

Apply only when `CompiledArchitectureV1.profile.profileId=backend-only`. This
profile has no `web-ui` or `native-ui`: do not create pages, components,
browser assets, a frontend package, or a UI QA harness.

## Runtime-selected source topology

The frozen profile candidates are `src`, `app`, `cmd`, and `internal`.
Service/store module outputs are further refined by the backend:

- Go prefers `internal`, then `cmd`, `pkg`, and detected roots.
- Python/Django/FastAPI prefers `src`, then `app`.
- Laravel/PHP prefers `app`.
- Other service/store outputs use the first immutable baseline-backed
  source/library root.

Plan backend `feature`, `service`, `store`, and `test` modules only. Go modules
use snake_case `.go`; Python uses snake_case `.py`; Laravel/PHP services use
`app/Services/<PascalName>.php`; Rust, Java, Kotlin, and .NET use their
stack-native extensions at the exact compiled roots. Do not guess a path from
this summary—feature modules continue to use the frozen
`profile.layerRoots.features` precedence, and `modules[].output` owns the
concrete result for every kind.

The deterministic backend manifests follow the matrix in
`rules/modes/new-project-architecture.md`: Go modules, Python `pyproject.toml`,
Composer/Artisan, Cargo, Maven, Gradle, .NET build props, or the complete
Supabase/our-fork baseline. Common repository outputs and backend-owned
`.env.example` apply when an implementation role is selected.

Use only the tester-owned module test paths present in `scaffoldOutputs`;
do not derive or invent another test location from a framework convention.
Python-family projects also compile `tests/conftest.py`; PHP-family projects
compile `phpunit.xml`. Other backend verification comes from the immutable
verification contract; no Playwright/browser smoke test is added.

`external-api` describes a dependency, not an API server. With no UI and no
owned backend it grants no backend role or scaffold. If the product must
implement an API, onboarding must select its actual backend framework and
recompile rather than using `external-api`.

No semantic UI routes or app-shell modules belong in this plan. Create only
the selected entrypoint (if any), compiled module/scaffold outputs, and active
work-unit paths.
