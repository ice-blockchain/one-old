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
- Runtime structural findings see what a linter cannot, because they compare
  against the compiled architecture rather than the source alone: entrypoints
  containing inline UI/routes, route/contract mismatches, work-unit
  allowlist gaps, planned-module gaps, and orphan modules. On a project
  Traffic One scaffolded, every one of them blocks. On an existing codebase
  only the two that are facts rather than conventions do — a write outside your
  work-unit allowlist, and a planned module that does not exist — and the rest
  are recorded as findings against a layout the repository chose before the run.
  An incomplete scan is demoted only where the run's verification contract
  actually compensates for it, and there are three ways to read less than the
  whole tree. A genuine BOUND — more source files than a walk reads, in either
  the structure scan or the collapse scan — is recorded as a warning and it
  pins `uiImpact` to the truncated-scan floor, so that run owes MORE browser
  evidence than a complete one, not less; both scans record it, on every role's
  digest.
  An entry a walk WITHDREW — a file it could not open, a directory it could not
  read, an entry it cannot classify, a symbolic link it declined to follow — is
  skipped, recorded by path, and the rest of the tree is judged normally, and it
  raises the same floor: what a withdrawal costs is not the entry but the whole
  subtree behind it, including error-grade findings in files nobody read, so the
  run owes the same extra evidence a bound owes. Two things excuse not
  following a link into source a walk would otherwise judge, and the two walks
  do not agree on the second. Both are excused when the same walk read the
  target anyway, under the target's own real path, so nothing is missing from
  the report. The structure scan is additionally silent — no skip record and no
  raised floor — about a link whose target resolves under a build output this
  project DECLARED in its compiled architecture; the collapse scan has no such
  case and records that link like any other, floor included. Neither excuse is
  inferred from a name: a link under a source name whose target lands in a build
  or generated directory the contract does not declare is recorded by both,
  because those bytes are real source, and because the real path is one the scan
  excludes, no report judges them under either name.
  A source root that does not resolve stays an error in both modes: there is no
  floor that compensates a report about nothing.
  Collapsed source is still rejected at the write in every mode, because the
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
