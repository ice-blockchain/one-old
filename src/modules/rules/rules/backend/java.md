---
paths:
  - "**/*.java"
  - "**/pom.xml"
  - "**/build.gradle"
  - "**/build.gradle.kts"
---

# Java Backend Rules

Backend-focused rules for java projects.

## Style & models
- Use google-java-format or Checkstyle; keep one public top-level type per file.
- Prefer records for DTOs/value types and sealed types for closed domain hierarchies.
- Mark fields `final` by default and return defensive copies from public APIs.
- Return `Optional<T>` from finder methods that may not find a value; never use `Optional` as a field or parameter.
- Prefer short stream pipelines; use loops for complex control flow.

## Backend patterns
- Encapsulate persistence behind repository interfaces.
- Keep controllers and repositories thin; put business logic in services.
- Use constructor injection; never field injection.
- Map DTOs at service/controller boundaries and avoid leaking entities.
- Use a consistent API response envelope for success/data/error metadata.
- Use builders for request/search criteria with many optional parameters.

## Security
- Security baseline (secrets, parameterized SQL, authn/authz, error sanitization, no secret logging): rules/common/security.md.
- Use parameterized SQL via `PreparedStatement`, JDBC template, or JPA parameters.
- Validate input at system boundaries with Bean Validation or explicit guards.
- Store passwords with bcrypt or Argon2; never MD5/SHA1.
- Scan dependencies with OWASP Dependency-Check, Snyk, or equivalent.

## Testing
- Use JUnit 5 for unit and integration tests.
- Use AssertJ for fluent assertions and Mockito for mocks.
- Use Testcontainers for database/service integration tests.
- Mirror `src/main/java` under `src/test/java`.
- Use JaCoCo for coverage; focus on service, domain, validation, auth, and failure paths.
