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
- Return new objects/arrays; never mutate inputs.
- `const` by default. Pure functions where possible; isolate side effects.

## Naming
- `camelCase` vars/functions, `PascalCase` types/components, `UPPER_SNAKE_CASE` constants.
- Booleans start with `is` / `has` / `should` / `can`.
- Names describe intent (`fetchUser`), not implementation (`getUserFromDb`).
- Avoid abbreviations except universal ones (`id`, `url`, `db`).

## File & function size
- Files 200–400 lines (800 hard cap). Many small files > few large.
- Functions one responsibility, ~50 lines max. Extract helpers above that.
- Early returns over nested conditionals. No magic numbers.

## Formatting
- Write formatted source: ONE statement per line, multi-line JSX/markup, and
  the project formatter's line width. Never collapse a function body or a JSX
  tree onto a single line — collapsed/minified source is a defect even when
  lint and typecheck pass, and it survives review because nobody can read it.
- Multi-line edits are safe: anchor patches on the surrounding context lines
  instead of flattening code to make a patch "simpler".

## Code smells to avoid
- Deep nesting (>3 levels) — extract or early-return.
- Long parameter lists (>4) — pass an options object.
- Duplicated conditionals — extract a predicate.
- Dead code, commented-out code, unused imports — delete.
