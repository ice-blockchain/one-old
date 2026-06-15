---
name: django-verification
description: "Verification loop for Django projects: migrations, linting, tests with coverage, security scans, and deployment readiness checks before release or PR."
metadata:
  source: everything-claude-code
  source_path: skills/django-verification/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Django Verification Loop

Run before PRs, after major changes, and pre-deploy to ensure Django application quality and security.

## When to Activate

- Before opening a pull request for a Django project
- After major model changes, migration updates, or dependency upgrades
- Pre-deployment verification for staging or production
- Validating migration safety and test coverage

The verification phase pipeline (Build → Type/Static → Lint → Test+Coverage →
Security → Diff Review), the stop-on-fail gate, the 80% coverage target, and the
VERIFICATION REPORT output template are owned by the `verification-loop` skill —
do not restate them. Below are only the framework-specific commands per phase
and framework-only phases.

## Per-phase Django commands

- **Type/Static**: `mypy . --config-file pyproject.toml`
- **Lint/Format**: `ruff check .`, `black . --check`, `isort . --check-only`
- **Test + Coverage**: `pytest --cov=apps --cov-report=term-missing --reuse-db`
  (markers: `pytest -m "not slow"`, `pytest -m integration`)
- **Security**: `pip-audit`, `safety check --full-report`,
  `bandit -r . -f json -o bandit-report.json`
- **Deploy config check**: `python manage.py check --deploy` (DEBUG off,
  SECRET_KEY, ALLOWED_HOSTS, SSL/HSTS)

## Framework-only phase: Migrations

```bash
python manage.py makemigrations --check   # model changes without migrations
python manage.py migrate --plan           # dry-run application
python manage.py showmigrations           # pending migrations
python manage.py makemigrations --merge   # only if conflicts exist
```

Report pending migrations, conflicts, and any model change lacking a migration.
Review destructive migrations and confirm a reversal path before applying.

## Framework-only phase: Static assets and management commands

```bash
python manage.py collectstatic --noinput --clear
python manage.py findstatic css/style.css
python manage.py check --database default   # DB integrity
```

If a JS toolchain feeds static assets, run `npm audit` and `npm run build`
before `collectstatic`.

## Framework-only phase: API schema (DRF)

```bash
python manage.py generateschema --format openapi-json > schema.json
python -c "import json; json.load(open('schema.json'))"   # validate
```
