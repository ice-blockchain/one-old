---
name: flutter-dart-code-review
description: Library-agnostic Flutter/Dart code review checklist covering widget best practices, state management patterns (BLoC, Riverpod, Provider, GetX, MobX, Signals), Dart idioms, performance, accessibility, security, and clean architecture.
metadata:
  source: everything-claude-code
  source_path: skills/flutter-dart-code-review/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Flutter/Dart Code Review Best Practices

Comprehensive, library-agnostic checklist for reviewing Flutter/Dart applications. These principles apply regardless of which state management solution, routing library, or DI framework is used.

---

## 1. General Project Health

- [ ] Consistent folder structure (feature-first or layer-first) with clean
      separation of UI, business logic, and data layers — no business logic in widgets
- [ ] `pubspec.yaml` clean (no unused deps, versions pinned appropriately);
      generated files (`.g.dart`, `.freezed.dart`, `.gr.dart`) current or gitignored
- [ ] `analysis_options.yaml` includes a strict lint set with strict analyzer settings
- [ ] Platform-specific code isolated behind abstractions

---

## 2. Dart Language Pitfalls

- [ ] **Implicit dynamic**: missing annotations leaking `dynamic` — enable `strict-casts`/`strict-inference`/`strict-raw-types`
- [ ] **Null safety misuse**: excessive `!` instead of null checks or Dart 3 patterns (`if (value case var v?)`); `late` used where nullable/constructor init is safer
- [ ] **Exception handling**: no bare `catch (e)` without an `on` clause; never catch `Error` subtypes (they indicate bugs)
- [ ] **Fire-and-forget `Future`**: `await` or `unawaited()` to signal intent; drop `async` on functions that never `await`
- [ ] **Immutability**: prefer `final`/`const` over `var`; expose unmodifiable views, not raw `List`/`Map`; `StringBuffer` for iterative building
- [ ] **Dart 3 idioms**: switch expressions / `if-case` over verbose `is`+cast; records `(String, int)` over single-use DTOs
- [ ] **Imports**: `package:` imports for consistency, not relative

---

## 3. Widget Best Practices

### Widget decomposition:
- [ ] No `build()` over ~80-100 lines; private `_build*()` helpers extracted to real widget classes (enables element reuse + const propagation), reusable ones in their own files
- [ ] Stateless preferred over Stateful where no mutable local state is needed; split by rebuild boundary

### Const usage:
- [ ] `const` constructors + literals (`const []`, `const {}`) wherever possible; constructor declared `const` when all fields are final

### Key usage:
- [ ] `ValueKey`/`ObjectKey` to preserve state across list reorders; `GlobalKey` only when cross-tree state access is truly needed; never `UniqueKey` in `build()` (rebuilds every frame)

### Theming & design system:
- [ ] Colors from `Theme.of(context).colorScheme`, text from `textTheme` — no hardcoded `Colors.red`/hex/inline `TextStyle`; dark mode verified; spacing via tokens, not magic numbers

### Build method complexity:
- [ ] No network/file I/O, heavy computation, `async`/`Future.then()`, or `.listen()` subscriptions in `build()`
- [ ] `setState()` localized to smallest possible subtree

---

## 4. State Management (Library-Agnostic)

These principles apply to all Flutter state management solutions (BLoC, Riverpod, Provider, GetX, MobX, Signals, ValueNotifier, etc.).

### Architecture:
- [ ] Business logic lives in a state component (BLoC/Notifier/Controller/Store/ViewModel), not widgets; deps injected, not constructed internally
- [ ] A service/repository layer abstracts data sources — widgets and state managers never call APIs/DBs directly; no "god" managers
- [ ] Cross-component deps follow the solution's conventions: Riverpod `ref.watch` chains are fine (flag only circular/tangled); BLoC-to-BLoC is not — use shared repositories

### Immutability & value equality (for immutable-state solutions: BLoC, Riverpod, Redux):
- [ ] State objects immutable — new instances via `copyWith()`/constructors, never mutated in-place; collections not exposed as raw mutable `List`/`Map`
- [ ] `==`/`hashCode` cover all fields, via a mechanism consistent across the project (`Equatable`, `freezed`, records, or manual)

### Reactivity discipline (for reactive-mutation solutions: MobX, GetX, Signals):
- [ ] State mutated only through the reactive API (`@action`, `.value`, `.obs`) — direct field mutation bypasses tracking; derived values use the computed mechanism
- [ ] Reactions/disposers cleaned up (`ReactionDisposer` in MobX, effect cleanup in Signals)

### State shape design:
- [ ] Mutually exclusive states use sealed types / union variants / `AsyncValue` — not boolean flags (`isLoading`/`isError`/`hasData`) or nullable-as-loading
- [ ] Every async op models loading/success/error as distinct states, all handled exhaustively in UI; error states carry error info, loading states carry no stale data

```dart
// BAD — boolean flag soup allows impossible states
class UserState {
  bool isLoading = false;
  bool hasError = false; // isLoading && hasError is representable!
  User? user;
}

// GOOD (immutable approach) — sealed types make impossible states unrepresentable
sealed class UserState {}
class UserInitial extends UserState {}
class UserLoading extends UserState {}
class UserLoaded extends UserState {
  final User user;
  const UserLoaded(this.user);
}
class UserError extends UserState {
  final String message;
  const UserError(this.message);
}

// GOOD (reactive approach) — observable enum + data, mutations via reactivity API
// enum UserStatus { initial, loading, loaded, error }
// Use your solution's observable/signal to wrap status and data separately
```

### Rebuild optimization:
- [ ] Consumer widgets (Builder/Consumer/Observer/Obx/Watch) scoped as narrow as possible; selectors rebuild only on the fields that changed; `const` widgets stop propagation

### Subscriptions & disposal:
- [ ] Manual subscriptions (`.listen()`), stream controllers, and timers cancelled/closed in `dispose()`/`close()`; prefer declarative builders over manual `.listen()`
- [ ] `context.mounted` checked after every `await` before `setState`, navigation, dialogs, or scaffold messages (Flutter 3.7+) — stale context crashes
- [ ] `BuildContext` never stored in singletons, state managers, or static fields

### Local vs global state:
- [ ] Ephemeral UI state (checkbox/slider/animation) stays local (`setState`/`ValueNotifier`); shared state lifted only as high as needed and disposed when its feature is inactive

---

## 5. Performance

### Unnecessary rebuilds:
- [ ] No root-level `setState()`; `const` widgets stop propagation; `RepaintBoundary` around independently-repainting subtrees; `AnimatedBuilder` `child` for animation-independent subtrees

### Expensive operations in build():
- [ ] No sorting/filtering/mapping of large collections or regex compilation in `build()` — compute in the state layer; use scoped `MediaQuery.sizeOf(context)` not `MediaQuery.of`

### Image optimization:
- [ ] Network images cached, sized to device (no 4K thumbnails), `Image.asset` with `cacheWidth`/`cacheHeight`, and placeholder/error widgets provided

### Lazy loading:
- [ ] `ListView.builder`/`GridView.builder` for large/dynamic lists (concrete constructors fine for small static lists); pagination for large sets; `deferred as` for heavy web libraries

### Other:
- [ ] `AnimatedOpacity`/`FadeTransition` over `Opacity` in animations; pre-clip rather than clip in animations; `const` constructors over widget `operator ==`; `IntrinsicHeight`/`IntrinsicWidth` sparingly (extra layout pass)

---

## 6. Testing

### Test types and expectations:
- [ ] **Unit** for business logic (state managers/repositories/utils), **Widget** for widget behavior, **Integration** for critical flows end-to-end, **Golden** for design-critical UI

### Coverage targets:
- [ ] 80%+ line coverage on business logic; every state transition tested (loading→success, loading→error, retry); edge cases covered (empty/error/loading/boundary)

### Test isolation:
- [ ] External deps (API clients/DBs/services) mocked or faked, with minimal stubbing; one class/unit per file; behavior tested not implementation; no shared mutable state between cases

### Widget test quality:
- [ ] `pumpWidget`/`pump` used correctly for async; `find.byType`/`text`/`byKey` appropriate; no timing-flaky tests (use `pumpAndSettle` or explicit `pump(Duration)`); tests run in CI and block merges

---

## 7. Accessibility

### Semantic widgets:
- [ ] `Semantics` labels where automatic ones fall short, `ExcludeSemantics` for decoration, `MergeSemantics` to combine related widgets; images have `semanticLabel`

### Screen reader support:
- [ ] Interactive elements focusable with meaningful descriptions; focus order follows visual reading order

### Visual accessibility:
- [ ] Contrast >= 4.5:1, tap targets >= 48x48, color never the sole state indicator (pair with icon/text), text scales with system font size

### Interaction accessibility:
- [ ] No no-op `onPressed` (button acts or is disabled); error fields suggest corrections; context doesn't shift while the user is inputting

---

## 8. Platform-Specific Concerns

### iOS/Android differences:
- [ ] Platform-adaptive widgets where appropriate; back navigation correct per platform (Android button, iOS swipe); `SafeArea` for status bar/notch; permissions declared in `AndroidManifest.xml` + `Info.plist`

### Responsive design:
- [ ] `LayoutBuilder`/`MediaQuery` with consistent breakpoints (phone/tablet/desktop); no overflow on small screens (`Flexible`/`Expanded`/`FittedBox`); landscape tested or locked; web mouse/keyboard/hover supported

---

## 9. Security

### Secure storage:
- [ ] Tokens/credentials in platform-secure storage (Keychain / EncryptedSharedPreferences), never plaintext; biometric gating considered for sensitive ops

### API key handling:
- [ ] No hardcoded keys in Dart — use `--dart-define`/VCS-excluded `.env`/compile-time config (check `.gitignore`); truly-secret keys live behind a backend proxy, never on the client

### Input validation:
- [ ] User input validated before hitting the API; no raw SQL or string-interpolated input; deep-link URLs validated and sanitized before navigation

### Network security:
- [ ] HTTPS enforced; cert pinning considered for high-security apps; auth tokens refreshed/expired properly; no sensitive data logged or printed

---

## 10. Package/Dependency Review

### Evaluating pub.dev packages:
- [ ] Pub points (aim 130+/160), likes/popularity, verified publisher, last-publish recency (>1yr = risk), maintainer responsiveness, license compatibility, and platform support for your targets

### Version constraints:
- [ ] Caret syntax (`^1.2.3`) for compatible updates (exact pins only when necessary); `flutter pub outdated` tracked; no production `dependency_overrides` (temporary only, with an issue link); transitive count minimized

### Monorepo-specific (melos/workspace):
- [ ] Internal packages import public API only (no `package:other/src/...`); deps via workspace resolution not `path: ../../`; sub-packages inherit root `analysis_options.yaml`

---

## 11. Navigation and Routing

### General principles (apply to any routing solution):
- [ ] One approach used consistently — no mixing imperative `Navigator.push` with a declarative router; route args typed (no `Map<String, dynamic>`); paths as constants/enums/generated, not magic strings
- [ ] Auth guards/redirects centralized, not per-screen; deep links configured for both platforms (and validated before navigation); navigation state testable; back behavior correct everywhere

---

## 12. Error Handling

### Framework error handling:
- [ ] `FlutterError.onError` + `PlatformDispatcher.instance.onError` capture framework and async errors; `ErrorWidget.builder` customized for release; `runApp` wrapped (`runZonedGuarded` / crash reporter)

### Error reporting:
- [ ] Reporting service integrated (Crashlytics/Sentry) with stack traces on non-fatals; state error observer (BlocObserver/ProviderObserver) wired to it; user id attached for debugging

### Graceful degradation:
- [ ] API errors yield friendly error UI not crashes; transient failures retried; offline handled; raw network/parsing exceptions mapped to localized user messages before the UI — never shown raw

---

## 13. Internationalization (l10n)

### Setup:
- [ ] Localization solution configured (built-in ARB/l10n, easy_localization, or equivalent) with supported locales declared in app config

### Content:
- [ ] All user-visible strings localized (none hardcoded in widgets); ICU syntax for plurals/genders/selects; typed placeholders; template carries translator context; no missing keys across locales

### Code review:
- [ ] Localization accessor used consistently; date/time/number/currency formatting locale-aware; RTL supported when targeting Arabic/Hebrew; parameterized messages, never concatenation

---

## 14. Dependency Injection

### Principles (apply to any DI approach):
- [ ] Classes depend on abstractions at layer boundaries, with deps provided externally (constructor/framework/provider graph) not constructed internally
- [ ] Registration distinguishes lifetime (singleton/factory/lazy); env bindings via config not runtime `if`; no circular deps; service-locator calls not scattered through business logic

---

## 15. Static Analysis

### Configuration:
- [ ] `analysis_options.yaml` present with `strict-casts`/`strict-inference`/`strict-raw-types: true` and a comprehensive lint set (very_good_analysis, flutter_lints, or custom); monorepo sub-packages inherit it

### Enforcement:
- [ ] No unresolved analyzer warnings committed; every `// ignore:` justified with a comment; `flutter analyze` runs in CI and blocks merges

### Key rules to verify regardless of lint package:
- [ ] `prefer_const_constructors`, `avoid_print`, `unawaited_futures`, `prefer_final_locals`, `always_declare_return_types`, `avoid_catches_without_on_clauses`, `always_use_package_imports`

---

## State Management Quick Reference

The table below maps universal principles to their implementation in popular solutions. Use this to adapt review rules to whichever solution the project uses.

| Principle | BLoC/Cubit | Riverpod | Provider | GetX | MobX | Signals | Built-in |
|-----------|-----------|----------|----------|------|------|---------|----------|
| State container | `Bloc`/`Cubit` | `Notifier`/`AsyncNotifier` | `ChangeNotifier` | `GetxController` | `Store` | `signal()` | `StatefulWidget` |
| UI consumer | `BlocBuilder` | `ConsumerWidget` | `Consumer` | `Obx`/`GetBuilder` | `Observer` | `Watch` | `setState` |
| Selector | `BlocSelector`/`buildWhen` | `ref.watch(p.select(...))` | `Selector` | N/A | computed | `computed()` | N/A |
| Side effects | `BlocListener` | `ref.listen` | `Consumer` callback | `ever()`/`once()` | `reaction` | `effect()` | callbacks |
| Disposal | auto via `BlocProvider` | `.autoDispose` | auto via `Provider` | `onClose()` | `ReactionDisposer` | manual | `dispose()` |
| Testing | `blocTest()` | `ProviderContainer` | `ChangeNotifier` directly | `Get.put` in test | store directly | signal directly | widget test |

---

## Sources

- [Effective Dart: Style](https://dart.dev/effective-dart/style)
- [Effective Dart: Usage](https://dart.dev/effective-dart/usage)
- [Effective Dart: Design](https://dart.dev/effective-dart/design)
- [Flutter Performance Best Practices](https://docs.flutter.dev/perf/best-practices)
- [Flutter Testing Overview](https://docs.flutter.dev/testing/overview)
- [Flutter Accessibility](https://docs.flutter.dev/ui/accessibility-and-internationalization/accessibility)
- [Flutter Internationalization](https://docs.flutter.dev/ui/accessibility-and-internationalization/internationalization)
- [Flutter Navigation and Routing](https://docs.flutter.dev/ui/navigation)
- [Flutter Error Handling](https://docs.flutter.dev/testing/errors)
- [Flutter State Management Options](https://docs.flutter.dev/data-and-backend/state-mgmt/options)
