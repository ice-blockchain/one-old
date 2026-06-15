---
paths:
  - "**/*.cs"
  - "**/*.csx"
  - "**/*.csproj"
  - "**/appsettings*.json"
---

# C#/.NET Backend Rules

Backend-focused rules for csharp projects.

## Style & models
- Follow current .NET conventions and enable nullable reference types.
- Prefer explicit access modifiers on public and internal APIs.
- Prefer `record` / `record struct` for immutable DTOs and value-like models.
- Use `class` for entities with identity/lifecycle and `interface` for service boundaries.
- Avoid `dynamic` in application code; use generics or explicit models.
- Use `dotnet format`; keep `using` directives organized.

## Backend patterns
- API responses use a typed envelope with `Success`, `Data`, `Error`, and optional `Meta`.
- Repositories are async contracts and pass `CancellationToken` through public async APIs.
- Use strongly typed options instead of reading raw config strings throughout the codebase.
- Use constructor injection; depend on interfaces at service boundaries.
- Register DI lifetimes intentionally: singleton for stateless shared services, scoped for request data, transient for lightweight workers.

## Security
- Security baseline (secrets, parameterized SQL, authn/authz, error sanitization, no secret logging): rules/common/security.md.
- Keep `appsettings.*.json` free of real credentials; use local user secrets in development.
- Use parameterized queries with ADO.NET, Dapper, or EF Core.
- Validate DTOs at application boundaries with data annotations, FluentValidation, or explicit guards.
- Prefer framework auth handlers and authorization policies over custom token parsing.

## Testing
- Prefer xUnit for unit and integration tests.
- Use FluentAssertions for readable assertions.
- Use Moq or NSubstitute for test doubles.
- Use Testcontainers for integration tests that need real infrastructure.
- Use `WebApplicationFactory<TEntryPoint>` for ASP.NET Core API integration tests.
- Run `dotnet test` in CI with coverage collection for domain, validation, auth, and failure paths.
