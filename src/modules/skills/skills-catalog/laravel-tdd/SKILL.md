---
name: laravel-tdd
description: Test-driven development for Laravel with PHPUnit and Pest, factories, database testing, fakes, and coverage targets.
metadata:
  source: everything-claude-code
  source_path: skills/laravel-tdd/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Laravel TDD Workflow

Test-driven development for Laravel applications using PHPUnit and Pest (unit + feature).

## When to Activate

- New features or endpoints in Laravel
- Bug fixes or refactors
- Testing Eloquent models, policies, jobs, and notifications
- Prefer Pest for new tests unless the project already standardizes on PHPUnit

The RED-GREEN-REFACTOR cycle, coverage tiers (Critical 100% / Public API 90% / Overall 80%), AAA structure, and the generic test maxims (test behavior not implementation, descriptive names, independent tests, no sleep(), don't over-mock) are owned by the `tdd-workflow` skill — do not restate them. Below are only the language-specific runner commands, frameworks, and idioms.

## How It Works

### Test Layers

- **Unit**: pure PHP classes, value objects, services
- **Feature**: HTTP endpoints, auth, validation, policies
- **Integration**: database + queue + external boundaries

### Database Strategy

- `RefreshDatabase` for most feature/integration tests (runs migrations once per test run, then wraps each test in a transaction when supported; in-memory databases may re-migrate per test)
- `DatabaseTransactions` when the schema is already migrated and you only need per-test rollback
- `DatabaseMigrations` when you need a full migrate/fresh for every test and can afford the cost

Use `RefreshDatabase` as the default for tests that touch the database: for databases with transaction support, it runs migrations once per test run (via a static flag) and wraps each test in a transaction; for `:memory:` SQLite or connections without transactions, it migrates before each test. Use `DatabaseTransactions` when the schema is already migrated and you only need per-test rollbacks.

### Testing Framework Choice

- Default to **Pest** for new tests when available.
- Use **PHPUnit** only if the project already standardizes on it or requires PHPUnit-specific tooling.

## Examples

### PHPUnit Example

```php
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class ProjectControllerTest extends TestCase
{
    use RefreshDatabase;

    public function test_owner_can_create_project(): void
    {
        $user = User::factory()->create();

        $response = $this->actingAs($user)->postJson('/api/projects', [
            'name' => 'New Project',
        ]);

        $response->assertCreated();
        $this->assertDatabaseHas('projects', ['name' => 'New Project']);
    }
}
```

### Feature Test Example (HTTP Layer)

```php
use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class ProjectIndexTest extends TestCase
{
    use RefreshDatabase;

    public function test_projects_index_returns_paginated_results(): void
    {
        $user = User::factory()->create();
        Project::factory()->count(3)->for($user)->create();

        $response = $this->actingAs($user)->getJson('/api/projects');

        $response->assertOk();
        $response->assertJsonStructure(['success', 'data', 'error', 'meta']);
    }
}
```

### Pest Example

```php
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;

use function Pest\Laravel\actingAs;
use function Pest\Laravel\assertDatabaseHas;

uses(RefreshDatabase::class);

test('owner can create project', function () {
    $user = User::factory()->create();

    $response = actingAs($user)->postJson('/api/projects', [
        'name' => 'New Project',
    ]);

    $response->assertCreated();
    assertDatabaseHas('projects', ['name' => 'New Project']);
});
```

### Feature Test Pest Example (HTTP Layer)

```php
use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;

use function Pest\Laravel\actingAs;

uses(RefreshDatabase::class);

test('projects index returns paginated results', function () {
    $user = User::factory()->create();
    Project::factory()->count(3)->for($user)->create();

    $response = actingAs($user)->getJson('/api/projects');

    $response->assertOk();
    $response->assertJsonStructure(['success', 'data', 'error', 'meta']);
});
```

### Factories and States

- Use factories for test data
- Define states for edge cases (archived, admin, trial)

```php
$user = User::factory()->state(['role' => 'admin'])->create();
```

### Database Testing

- Use `RefreshDatabase` for clean state
- Keep tests isolated and deterministic
- Prefer `assertDatabaseHas` over manual queries

### Persistence Test Example

```php
use App\Models\Project;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class ProjectRepositoryTest extends TestCase
{
    use RefreshDatabase;

    public function test_project_can_be_retrieved_by_slug(): void
    {
        $project = Project::factory()->create(['slug' => 'alpha']);

        $found = Project::query()->where('slug', 'alpha')->firstOrFail();

        $this->assertSame($project->id, $found->id);
    }
}
```

### Fakes for Side Effects

- `Bus::fake()` for jobs
- `Queue::fake()` for queued work
- `Mail::fake()` and `Notification::fake()` for notifications
- `Event::fake()` for domain events

```php
use Illuminate\Support\Facades\Queue;

Queue::fake();

dispatch(new SendOrderConfirmation($order->id));

Queue::assertPushed(SendOrderConfirmation::class);
```

```php
use Illuminate\Support\Facades\Notification;

Notification::fake();

$user->notify(new InvoiceReady($invoice));

Notification::assertSentTo($user, InvoiceReady::class);
```

### Auth Testing (Sanctum)

```php
use Laravel\Sanctum\Sanctum;

Sanctum::actingAs($user);

$response = $this->getJson('/api/projects');
$response->assertOk();
```

### HTTP and External Services

- Use `Http::fake()` to isolate external APIs
- Assert outbound payloads with `Http::assertSent()`

### Coverage Tooling

- Use `pcov` or `XDEBUG_MODE=coverage` in CI to collect coverage (Laravel/PHP-specific drivers)

### Test Commands

- `php artisan test`
- `vendor/bin/phpunit`
- `vendor/bin/pest`

### Test Configuration

- Use `phpunit.xml` to set `DB_CONNECTION=sqlite` and `DB_DATABASE=:memory:` for fast tests
- Keep separate env for tests to avoid touching dev/prod data

### Authorization Tests

```php
use Illuminate\Support\Facades\Gate;

$this->assertTrue(Gate::forUser($user)->allows('update', $project));
$this->assertFalse(Gate::forUser($otherUser)->allows('update', $project));
```

### Inertia Feature Tests

When using Inertia.js, assert on the component name and props with the Inertia testing helpers.

```php
use App\Models\User;
use Inertia\Testing\AssertableInertia;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class DashboardInertiaTest extends TestCase
{
    use RefreshDatabase;

    public function test_dashboard_inertia_props(): void
    {
        $user = User::factory()->create();

        $response = $this->actingAs($user)->get('/dashboard');

        $response->assertOk();
        $response->assertInertia(fn (AssertableInertia $page) => $page
            ->component('Dashboard')
            ->where('user.id', $user->id)
            ->has('projects')
        );
    }
}
```

Prefer `assertInertia` over raw JSON assertions to keep tests aligned with Inertia responses.
