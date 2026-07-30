---
# Language-agnostic baseline — always loaded
---

# Clean Code (baseline)

Universal principles, language-agnostic. Stack rules layer on top in `core.md`
and `frontend/<flavour>/core.md`.

## Core principles
- **KISS** — simplest solution that works.
- **DRY** — extract only after 2–3 real repetitions, never speculative.
- **YAGNI** — no abstractions, config knobs, or extension points before a real caller exists.
- **Readability first** — self-documenting names beat comments.

## Immutability
- Do not mutate caller-owned inputs or shared state unless the active
  language/framework contract explicitly requires it.
- Prefer immutable values and pure transformations where they are idiomatic;
  isolate unavoidable side effects at named boundaries.
- Follow the active language's value/reference and ownership model. For
  example, JS/TS may prefer `const`, Rust uses ownership/borrowing, Swift uses
  `let`, and Go/Python/PHP follow their own established project conventions.
  None of those spellings is a universal rule.

## Naming
- Follow the repository formatter/linter and the active language/framework
  naming convention. Do not impose JS/TS casing on Go, Python, Rust, Swift,
  Kotlin, PHP, SQL, shell, or configuration files.
- Name predicates according to the stack's idiom (`is` / `has` / `should` /
  `can` are examples where that idiom uses them, not cross-language mandates).
- Names describe domain intent (for example, “fetch a user”), not storage
  mechanics (for example, “read a row from the database”).
- Avoid abbreviations except universal ones (`id`, `url`, `db`).

## File & function size
- Keep modules cohesive and functions focused. Split them when they combine
  unrelated routes, screens, commands, jobs, or domain responsibilities.
- **Every numeric size budget lives in the project's own linter config** —
  `max-lines` and `max-lines-per-function` in `eslint.config.js`, `max-statements`
  in `ruff.toml`, `funlen` in `.golangci.yml`. On a new project runtime seeds that
  config at `PLAN_READY`; on an existing codebase the repository's own config is
  authoritative and is never replaced. Either way, read it: it is the answer for
  this project, it is what CI enforces, and it is editable by the project owner.
  Do not weaken it to pass your own change (see `quality-tooling.md`, "Config
  tamper guard").
- Layer and placement rules are likewise expressed in that config as import
  boundaries, not inferred from file or component names.
- Runtime structural findings remain blocking where a linter cannot see them,
  because they compare against the compiled architecture rather than the source
  alone: entrypoints containing inline UI/routes, route/contract mismatches,
  work-unit allowlist gaps, planned-module gaps, orphan modules, and incomplete
  scans. Collapsed source is also still rejected at the write, because the
  formatter is not installed yet when the first files land.
- Prefer the active language's clear control-flow idioms. Avoid unexplained
  literals; use named values or domain types where that improves meaning.

## Formatting
- Preserve the active stack's formatter output and readable line structure.
  Use multi-line JSX, HTML, templates, or DSL forms where their formatter and
  project conventions require it. Never collapse a function, declaration, or
  UI tree onto a single line — collapsed/minified source is a defect even when
  its formatter, linter, compiler, or tests pass. A source line packing
  multiple statements or a whole component (hundreds of characters) is
  collapse; keep hand-written lines near the stack formatter's width. Delivery
  gates deny a completion digest while product source stays collapsed.
- Multi-line edits are safe: anchor patches on the surrounding context lines
  instead of flattening code to make a patch "simpler".

## Code smells to avoid
- Excessive nesting — extract a cohesive helper or use the language's
  guard/early-return/result idiom.
- Long, ambiguous parameter lists — use the stack's idiomatic request,
  options, struct, data class, or typed configuration object.
- Duplicated conditionals — extract a predicate.
- Dead code, commented-out code, unused imports — delete.
