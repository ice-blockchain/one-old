---
paths:
  - "package.json"
  - "**/package.json"
  - "pnpm-workspace.yaml"
  - "turbo.json"
  - "tsconfig*.json"
  - "**/tsconfig*.json"
  - ".eslintrc*"
  - "eslint.config.*"
  - "prettier.config.*"
  - ".prettierrc*"
  - ".lintstagedrc*"
  - "lint-staged.config.*"
  - "go.mod"
  - "go.sum"
  - "pyproject.toml"
  - "requirements*.txt"
  - "composer.json"
  - "composer.lock"
  - "Cargo.toml"
  - "Cargo.lock"
  - "Package.swift"
  - "build.gradle*"
  - "**/build.gradle*"
  - "pubspec.yaml"
  - "Makefile"
  - ".github/workflows/**"
---

# Quality Tooling

Code-quality automation must be deterministic, local to the project, and hard
to bypass accidentally.

## The project's quality config is the bar — read it before you write

Where that config comes from depends on the mode:

- **`new-project`** — runtime compiles it for the selected stack as scaffold output
  and seeds canonical content at `PLAN_READY`, before any implementer writes a
  line: `eslint.config.js` + `.prettierrc` for JS/TS, `ruff.toml` for Python,
  `.golangci.yml` for Go, `pint.json` for PHP/Laravel, `rustfmt.toml` for Rust.
  Install the matching tools and expose the `format`/`lint` scripts that run them —
  a config with no installed tool and no script is inert.
- **`existing-codebase`** — the repository already has its own configuration and it
  is authoritative. Runtime scaffolds nothing and overwrites nothing. Read what is
  there and match it; do not migrate the project to a different toolchain, and do
  not add a second linter beside the one it uses.

Either way the config in the repository is the ONLY place the quality bar is
expressed:

- **Do not author a competing config.** If one already exists, extend it; do not
  add a second linter or a parallel ruleset.
- **Do not weaken it to make your own change pass.** Size limits, boundary rules,
  and strictness flags exist because the plan asked for them. Raising a limit or
  disabling a compiler flag to get past your own finding is a config-tamper
  violation, not a fix — split the module or correct the code instead.
- **Run it.** A config nobody runs proves nothing: the format and lint commands
  belong in the scripts you expose and in CI.
- If a rule in it is genuinely wrong for this project, say so in your digest with
  the failing rule and the reason, and leave the config alone.

## Capability-derived checks

Read the immutable capability profile, the baseline, and existing project
configuration before choosing commands. Run only checks that belong to the
active stack and touched surfaces:

- formatter or format-check configured by the repository;
- language linter/static analyzer;
- compiler/type checker where the stack has one;
- focused unit/integration tests, then the stack's broader test suite;
- production build/package step when the project produces a deployable
  artifact.

Do not create `package.json` scripts, pnpm workspaces, ESLint, Prettier,
TypeScript, or Turborepo configuration in Go, Python, PHP/Laravel, Rust,
Swift/Kotlin, Flutter, native, data-only, or other non-JS projects.

Script/config parity: only emit a script whose tool, config, and
dependencies/tool declarations you also scaffold in the same change. A command
that names an absent tool or config makes later verification meaningless.
Never add a no-op test command to manufacture a green pipeline.

## Local tooling only

- Use repository-owned tools and the active ecosystem's lockfile/package
  manager. Examples include project scripts for JS/TS, `go` tooling, a Python
  virtual environment/locked runner, Composer/Artisan, Cargo, Gradle, SwiftPM,
  or Flutter as selected by the project.
- Do not wire hooks or docs to remote one-off package execution such as
  `npx <tool>@latest` unless the user explicitly approves that tool and version.
- If a formatter/linter is missing, add it through the dependency quality gate
  only when the compiled plan calls for that tool; otherwise report the missing
  check instead of inventing a new toolchain.

## JavaScript/TypeScript only

- Expose `format`/`format:check`, `lint`/`lint:fix`, `typecheck`, `test`, and
  `build` scripts when applicable, backed by the matching installed tools and
  configuration.
- When Prettier is selected, its ignore file covers generated output, reports,
  lockfiles, and `.traffic-one/`. When ESLint is selected, keep correctness
  rules separate from formatter-owned style.
- Vite and many bundlers transpile TypeScript without proving correctness; run
  a separate `tsc --noEmit` or framework-equivalent check.
- Use pnpm and Turborepo only when the baseline/compiled profile selects them.
  In such monorepos, root scripts may route through workspace filters or
  Turborepo. Do not introduce that layout into a custom single-app JS project.
- A workspace package that ships runtime source needs a real applicable test
  command; config-only packages may omit it.

## Other stack examples

- Go: repository-selected generation, `gofmt`/format check, `go vet`, focused
  and full `go test`, and `go build` where an executable/service is produced.
- Python: the configured environment plus the project's formatter/linter/type
  checker/test runner (for example Ruff/Black, mypy/pyright, pytest). Do not
  require all examples when the project did not select them.
- PHP/Laravel: Composer scripts and configured Pint/PHPStan/Psalm/Pest/PHPUnit
  or Artisan checks.
- Rust: `cargo fmt --check`, configured Clippy policy, `cargo test`, and build.
- Swift/Kotlin/Flutter/native: the selected package/build system and
  simulator/emulator tests from the capability profile; never substitute
  browser or Node tooling.

## Generated and vendored files

- Ignore generated output, build artifacts, vendored code, and reports. Do not
  ignore application source to make the checker pass.
- Source is WRITTEN formatted, never collapsed: one statement per line and
  readable multi-line markup/DSL structure. Collapsed/minified product source
  is a defect regardless of the formatter.

## Config tamper guard

- Do not weaken lint, type, formatter, test, or build config to hide failures.
- If a config change is required, explain the failing rule, the desired behavior,
  and why source changes would be worse.
- Review config changes separately from feature code in the final summary.

## CI baseline

- CI restores dependencies from the active ecosystem's lock/verification
  mechanism, then runs the repository's available format, lint/static-analysis,
  test, and build/package gates before deploy.
- High-severity dependency audits are handled by the security gate, not ignored
  in package-manager config.
