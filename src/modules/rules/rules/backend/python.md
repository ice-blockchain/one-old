---
paths:
  - "**/*.py"
  - "**/*.pyi"
  - "**/pyproject.toml"
  - "**/requirements*.txt"
---

# Python Backend Rules

Backend-focused rules for python projects.

## Style
- Follow PEP 8.
- Use type annotations on all function signatures.
- Use immutable DTOs where possible: frozen dataclasses, NamedTuple, or equivalent.
- Use Black for formatting, isort for import sorting, and Ruff for linting.
- Keep public service/repository contracts explicit and typed.

## Backend patterns
- Use `Protocol` for repository/service boundaries.
- Use dataclasses or Pydantic-style models for request/response DTOs.
- Use context managers for files, DB sessions, transactions, locks, and network clients.
- Use generators for memory-efficient streaming or large-result processing.
- Keep web handlers thin and move business rules into service functions/classes.

## Security
- Security baseline (secrets, parameterized SQL, authn/authz, error sanitization, no secret logging): rules/common/security.md.
- Use Bandit for static security analysis.
- Prefer framework/provider auth integrations over hand-rolled auth; do not default FastAPI apps to hand-rolled JWT auth.

## Testing
- Use pytest.
- Use `pytest.mark.unit` and `pytest.mark.integration` for categorization.
- Track coverage with `pytest --cov=src --cov-report=term-missing`.
- Prefer fixtures and fakes for service/repository tests.
- Integration-test database and API boundaries where validation, auth, or persistence behavior matters.
