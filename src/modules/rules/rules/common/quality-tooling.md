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
  - ".github/workflows/**"
---

# Quality Tooling

Code-quality automation must be deterministic, local to the project, and hard
to bypass accidentally.

## Required scripts

Every JavaScript/TypeScript project exposes these root scripts when applicable:

- `format` and `format:check` for Prettier or the repo-selected formatter.
- `lint` and `lint:fix` for ESLint or the repo-selected linter.
- `typecheck` for `tsc --noEmit` or the framework-equivalent type check.
- `test` for unit/integration tests.
- `build` for the production build.

Monorepos route the root scripts through Turborepo or workspace filters instead
of requiring agents to remember per-package commands.

Script/config parity: only emit a script whose tool, config, and
devDependencies you also scaffold in the same change. A `lint` script without an
ESLint config (or a `test` script without a runner config) fails the whole
pipeline for every later agent — either scaffold the config + deps alongside the
script or omit the script until an implementer adds them.

Every workspace package that ships source exposes its own `test` script (vitest
on web stacks) so `turbo run test` covers it; a package with intentionally no
tests declares `"test": "echo \"no tests\" && exit 0"` explicitly rather than
omitting the script.

## Local tooling only

- Use repo-owned dependencies and scripts: `pnpm lint`, `pnpm typecheck`,
  `pnpm format:check`, `pnpm test`, `pnpm build`.
- Do not wire hooks or docs to remote one-off package execution such as
  `npx <tool>@latest` unless the user explicitly approves that tool and version.
- If a formatter/linter is missing, add it through the dependency quality gate
  before relying on it.

## ESLint and Prettier

- ESLint config lives at the root or in `packages/eslint-config`; package-level
  overrides are allowed only for real environment differences.
- Prettier owns formatting; ESLint owns correctness and maintainability. Avoid
  duplicate style rules that fight Prettier.
- Ignore generated output, build artifacts, vendored code, and reports. Do not
  ignore application source to make the checker pass.
- `_` prefixes are the standard way to mark intentionally unused variables or
  parameters.

## Type checks

- Vite and most bundlers transpile TypeScript but do not prove type correctness.
  CI and pre-PR verification must run a separate `typecheck` script.
- Long-running local type checks may use incremental build info under
  `node_modules/.cache/`; do not commit `.tsbuildinfo` files.

## Config tamper guard

- Do not weaken lint, type, formatter, test, or build config to hide failures.
- If a config change is required, explain the failing rule, the desired behavior,
  and why source changes would be worse.
- Review config changes separately from feature code in the final summary.

## CI baseline

- CI runs frozen install, `format:check` when available, `lint`, `typecheck`,
  `test`, and `build` before preview or production deploy steps.
- High-severity dependency audits are handled by the security gate, not ignored
  in package-manager config.
