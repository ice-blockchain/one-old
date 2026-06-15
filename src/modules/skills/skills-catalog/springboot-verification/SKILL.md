---
name: springboot-verification
description: "Verification loop for Spring Boot projects: build, static analysis, tests with coverage, security scans, and diff review before release or PR."
metadata:
  source: everything-claude-code
  source_path: skills/springboot-verification/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Spring Boot Verification Loop

Run before PRs, after major changes, and pre-deploy.

## When to Activate

- Before opening a pull request for a Spring Boot service
- After major refactoring or dependency upgrades
- Pre-deployment verification for staging or production
- Validating test coverage meets thresholds

The verification phase pipeline (Build → Type/Static → Lint → Test+Coverage →
Security → Diff Review), the stop-on-fail gate, the 80% coverage target, and the
VERIFICATION REPORT output template are owned by the `verification-loop` skill —
do not restate them. Below are only the framework-specific commands per phase
and framework-only phases.

## Per-phase Spring Boot commands

- **Build**: `mvn -T 4 clean verify -DskipTests` or `./gradlew clean assemble -x test`
- **Static analysis**: `mvn -T 4 spotbugs:check pmd:check checkstyle:check` or
  `./gradlew checkstyleMain pmdMain spotbugsMain`
- **Lint/Format**: `mvn spotless:apply` or `./gradlew spotlessApply` (if Spotless configured)
- **Test + Coverage**: `mvn -T 4 test && mvn jacoco:report` or
  `./gradlew test jacocoTestReport` (JaCoCo reports line/branch coverage).
  Integration tests run against a real DB via Testcontainers
  (`@Testcontainers` + `PostgreSQLContainer`), not H2. Authoring patterns live
  in the `springboot-tdd` skill.
- **Security**: `mvn org.owasp:dependency-check-maven:check` or
  `./gradlew dependencyCheckAnalyze` for dependency CVEs. Do not hand-roll
  secret greps — the pre-deploy scanner is the authoritative detector
  (see `rules/common/security.md` and the `predeploy-security-check` skill).

## Spring Boot diff-review greps

Framework-specific checks to add on top of the canonical diff review:

```bash
grep -rn "System\.out\.print" src/main/ --include="*.java"   # use a logger
grep -rn "e\.getMessage()" src/main/ --include="*.java"       # raw exception in responses
grep -rn "allowedOrigins.*\*" src/main/ --include="*.java"    # wildcard CORS
```

Confirm transactions and validation are present where needed and config changes
are documented.
