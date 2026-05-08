---
# Loaded when mode = existing-codebase (>5 source files, no Supabase)
---

# Mode: Existing Codebase

Preserve all existing structure. New code only.

## Active constraints
- Do NOT rename, move, or restructure existing files
- Max function length: 50 lines on new code
- Max component length: 150 lines on new code
- No `any`, no inline styles, named exports only — on new code
- No backend or infrastructure suggestions
- Before normal feature work, run the `auto-documentation-generator` baseline
  reconciliation from `rules/common/documentation.md`:
  - If a canonical doc does not exist, create it from verified repo facts at the
    repo root.
  - If a canonical doc already exists, update it in place.
  - If legacy canonical docs exist under `docs/`, migrate them to the root path
    when that can be done without overwriting a newer root file.
  - Mark unknown facts as `Unverified` with the exact command/input needed.
  - Never include secret values, production data, fake deploy URLs, or
    boilerplate sections.

<!-- TODO: expand with project-specific incremental rules once structure is validated -->
