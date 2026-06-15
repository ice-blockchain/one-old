---
name: java-coding-standards
description: "Java 17+ idioms — records and sealed classes, Optional map/orElseThrow, stream pipelines, bounded generics, domain exceptions, Bean Validation, and JUnit 5/AssertJ/Mockito testing. Language layer over the generic clean-code floor."
metadata:
  source: everything-claude-code
  source_path: skills/java-coding-standards/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Java Coding Standards

Generic naming, immutability, KISS/DRY/YAGNI, file/function size, and code-smell rules live in the always-on `rules/common/clean-code.md` — do not restate them. This skill keeps only the Java-specific idioms below.

Apply when writing, reviewing, or refactoring Java (17+) code, especially around records, sealed classes, Optional, streams, and generics.

## Records and Immutability

```java
// Favor records and final fields for data models
public record Money(BigDecimal amount, Currency currency) {}
public record MarketDto(Long id, String name, MarketStatus status) {}

public class Market {
  private final Long id;
  private final String name;
  // getters only, no setters
}
```

## Optional Usage

```java
// GOOD: Return Optional from find* methods
Optional<Market> market = marketRepository.findBySlug(slug);

// GOOD: Map/flatMap instead of get()
return market
    .map(MarketResponse::from)
    .orElseThrow(() -> new EntityNotFoundException("Market not found"));
```

## Streams Best Practices

```java
// GOOD: Use streams for transformations, keep pipelines short
List<String> names = markets.stream()
    .map(Market::name)
    .filter(Objects::nonNull)
    .toList();

// BAD: Avoid complex nested streams; prefer loops for clarity
```

## Exceptions

- Use unchecked exceptions for domain errors; wrap technical exceptions with context
- Create domain-specific exceptions (e.g., `MarketNotFoundException`)
- Avoid broad `catch (Exception ex)` unless rethrowing/logging centrally

```java
throw new MarketNotFoundException(slug);
```

## Generics and Type Safety

- Avoid raw types; declare generic parameters
- Prefer bounded generics for reusable utilities

```java
public <T extends Identifiable> Map<Long, T> indexById(Collection<T> items) { ... }
```

## Project Structure (Maven/Gradle)

```
src/main/java/com/example/app/
  config/
  controller/
  service/
  repository/
  domain/
  dto/
  util/
src/main/resources/
  application.yml
src/test/java/... (mirrors main)
```

## Formatting and Style

- One public top-level type per file
- Order members: constants, fields, constructors, public methods, protected, private

## Logging

```java
private static final Logger log = LoggerFactory.getLogger(MarketService.class);
log.info("fetch_market slug={}", slug);
log.error("failed_fetch_market slug={}", slug, ex);
```

## Null Handling

- Accept `@Nullable` only when unavoidable; otherwise use `@NonNull`
- Use Bean Validation (`@NotNull`, `@NotBlank`) on inputs

## Testing Expectations

- JUnit 5 + AssertJ for fluent assertions
- Mockito for mocking; avoid partial mocks where possible
- Favor deterministic tests; no hidden sleeps
