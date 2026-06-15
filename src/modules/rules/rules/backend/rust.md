---
paths:
  - "**/*.rs"
  - "**/Cargo.toml"
  - "**/Cargo.lock"
---

# Rust Backend Rules

Backend-focused rules for rust projects.

## Style & ownership
- Run `cargo fmt` and `cargo clippy -- -D warnings`.
- Use immutable `let` by default; use `let mut` only when mutation is required.
- Borrow by default; accept `&str` over `String` and `&[T]` over `Vec<T>` in parameters.
- Do not clone to satisfy the borrow checker without understanding the ownership issue.
- Use `Result<T, E>` and `?`; never `unwrap()` in production code.
- Use `thiserror` for library/domain errors and `anyhow` with context for application-level errors.
- Organize modules by domain and keep public APIs intentionally small.

## Backend patterns
- Encapsulate data access behind `Send + Sync` repository traits.
- Keep business logic in service structs and inject dependencies through constructors.
- Use newtype wrappers for IDs and domain-specific primitive values.
- Model business states with enums and exhaustive matches; avoid wildcard matches for critical states.
- Use typed API response envelopes for success/error serialization.

## Security
- Security baseline (secrets, parameterized SQL, authn/authz, error sanitization, no secret logging): rules/common/security.md.
- Document every `unsafe` block with a `SAFETY:` comment and keep unsafe code isolated.
- Run `cargo audit`, `cargo deny check`, and inspect `cargo tree` for dependency risk.
- Log details server-side with `tracing` or `log`; return generic client errors.
- Use parameterized queries through SQLx, Diesel, tokio-postgres, or the active DB layer.

## Testing
- Use `#[test]` and `#[cfg(test)]` modules for unit tests.
- Use integration tests under `tests/` for API and DB boundaries.
- Use `rstest` for parameterized cases, `proptest` for properties, and `mockall` for trait mocks where useful.
- Use `#[tokio::test]` for async backend tests.
- Track coverage with `cargo llvm-cov` and focus on service/domain logic.
