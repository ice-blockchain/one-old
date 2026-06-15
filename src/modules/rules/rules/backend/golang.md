---
paths:
  - "**/*.go"
  - "**/go.mod"
  - "**/go.sum"
---

# Go Backend Rules

Backend-focused rules for golang projects.

## Style
- `gofmt` and `goimports` are mandatory.
- Accept interfaces, return structs.
- Keep interfaces small, usually 1-3 methods.
- Define interfaces where they are consumed, not where they are implemented.
- Wrap errors with context using `%w`.

## Backend patterns
- Use constructor functions for dependency injection.
- Use functional options for backend/server configuration with many optional settings.
- Pass `context.Context` through request-scoped work and external calls.
- Set timeouts on network, DB, and external API operations.
- Keep handlers thin; move business rules into services and persistence into repositories/stores.

## Security
- Security baseline (secrets, parameterized SQL, authn/authz, error sanitization, no secret logging): rules/common/security.md.
- Run `gosec ./...` in CI for backend services.
- Validate dynamic sort/filter fields before query composition.

## Testing
- Use standard `go test` with table-driven tests.
- Run `go test -race ./...` for concurrent/backend code.
- Track coverage with `go test -cover ./...`.
- Prefer fakes around small interfaces for service tests.
