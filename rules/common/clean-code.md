---
# Language-agnostic baseline — always loaded
---

# Clean Code (baseline)

Universal principles that apply regardless of language or framework. For React-specific rules see `rules/react.md`; for backend see `rules/backend/`.

## Core principles
- **KISS** — simplest solution that works; no cleverness for its own sake.
- **DRY** — extract repeated logic only once repetition is real (2–3 occurrences), not speculative.
- **YAGNI** — do not build abstractions, config knobs, or extension points until a real caller exists.
- **Readability first** — code is read far more than written; self-documenting names beat comments.

## Immutability
- Return new objects/arrays — never mutate inputs.
- Prefer `const` by default; `let` only when reassignment is the clearest path.
- Pure functions where possible; isolate side effects.

## Naming
- `camelCase` for variables/functions, `PascalCase` for types/components, `UPPER_SNAKE_CASE` for constants.
- Booleans start with `is`, `has`, `should`, or `can`.
- No abbreviations except universally known ones (`id`, `url`, `db`).
- Names describe intent, not implementation (`fetchUser`, not `getUserFromDb`).

## File size
- Target 200–400 lines per file; 800 is the hard ceiling.
- Many small focused files > few large ones. Split by feature/domain, not by type.

## Functions
- One responsibility per function. If you need "and" to describe it, split it.
- Max ~50 lines per function; extract helpers above that.
- Early returns over nested conditionals.
- No magic numbers — name every meaningful constant.

## Error handling
- Handle errors explicitly at every layer — never silently swallow.
- User-facing errors must be friendly; logs must carry full context.
- Validate all input at system boundaries (HTTP, DB, file, user).
- Fail fast with clear messages.

## Types
- No `any` — use `unknown` and narrow.
- Infer types from schemas (zod, etc.) rather than duplicating them.
- Prefer discriminated unions over boolean flags + optional fields.

## Code smells to avoid
- Deep nesting (>3 levels) — extract or early-return.
- Long parameter lists (>4) — pass an options object.
- Duplicated conditionals — extract a predicate.
- Dead code, commented-out code, unused imports — delete.
