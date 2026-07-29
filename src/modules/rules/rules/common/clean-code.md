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
- During the current one-version rollout, per-component LOC, function-size,
  top-level-function-count, and component-per-file thresholds are advisory
  `WARN` signals only. They are not standalone blockers until fixture
  validation demonstrates a false-positive rate below 1%.
- One numeric threshold DOES block: a single module over ~400 logical lines
  (`STRUCT_MODULE_LOC`). A module that large is packing a whole feature into one
  file regardless of how its components are counted. Split it along its own
  seams. Generated declaration/type modules (`*.d.ts`, `*.types.ts`,
  `*.generated.ts`) are exempt, and the architect may declare a narrow
  `STRUCT_MODULE_LOC` exception with a glob and a reason.
- Runtime structural findings remain blocking independently of LOC:
  entrypoints containing inline UI/routes, multiple pages in one module,
  route/contract mismatches, allowlist gaps, and incomplete scans.
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
