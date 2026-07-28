---
description: "Apply only when CompiledArchitectureV1 profileId=flutter-native: Flutter/Dart roots, package scaffold, routing, and driver QA."
---

# New Project Profile — Flutter

Apply only when `CompiledArchitectureV1.profile.profileId=flutter-native`.

```
<repo-root>/
├── pubspec.yaml
├── test/<module>_test.dart                 derived module tests
├── integration_test/app_test.dart          driver smoke test
└── <native-root>/lib/
    ├── main.dart                           selected entrypoint
    ├── screens/ | pages/                   compiled page modules
    ├── widgets/                            compiled components
    ├── features/<name>/index.dart
    └── core/                               service/store modules
```

`screens` then `pages` is a baseline-driven precedence list. The router named
in the immutable profile owns navigation; do not mix router conventions.

The native scaffold and tester outputs are repository-relative;
`<native-root>` applies only to detected source/entrypoint candidates. Common repository outputs from
`rules/modes/new-project-architecture.md` also apply. Flutter driver is the
selected QA adapter. Use a non-secret `API_BASE_URL` through the chosen
`--dart-define`/platform build mechanism, but create no configuration wrapper
unless its exact file is allowlisted.

Use the selected entrypoint, compiled module/test paths, scaffold outputs, and
work-unit contract. Do not generate `android/`, `ios/`, desktop/web targets,
state-management scaffolds, or platform files outside the compiled contract.
