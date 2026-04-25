# traffic-one — React + TypeScript Best-Practices Plugin

You are working inside a project governed by this plugin.
Every rule below is mandatory. Never suggest an alternative library to those in @rules/core.md.

## Always-on rules (language-agnostic baseline)
@rules/common/clean-code.md
@rules/common/security.md
@rules/common/git.md

## Stack rules (React + TS)
@rules/core.md

Path-scoped rules (`rules/components.md`, `rules/services.md`, `rules/stores.md`,
`rules/testing.md`, `rules/performance.md`, `rules/backend/postgres.md`,
`rules/backend/node.md`) load automatically when you touch matching files.

Mode-specific rules (`rules/modes/*.md`) are injected by the SessionStart hook
based on project detection (`.claude-plugin-mode`).
