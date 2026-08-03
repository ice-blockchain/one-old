---
description: "Apply only when CompiledArchitectureV1 profileId=kotlin-native: Android/Kotlin roots, Gradle scaffold, navigation, and emulator QA."
---

# New Project Profile — Native Android / Kotlin

Apply only when `CompiledArchitectureV1.profile.profileId=kotlin-native`.

```
<repo-root>/
├── settings.gradle.kts
├── app/
│   ├── build.gradle.kts
│   └── src/
│       ├── test/<Module>Test.kt           derived module tests
│       └── androidTest/AppSmokeTest.kt    emulator smoke test
└── <native-root>/
    ├── app/src/main/
    │   ├── AndroidManifest.xml            selected entrypoint
    │   ├── java/ | kotlin/                page/component candidates
    │   └── ...
    ├── features/                          feature candidate
    └── core/                              library candidate
```

`java` then `kotlin` is a baseline-driven precedence choice; do not create both
source organizations by default. The selected Android navigation integration
owns route registration.

The deterministic scaffold and tester outputs are repository-relative;
`<native-root>` applies only to detected source/entrypoint candidates. Common repository outputs from
`rules/modes/new-project-architecture.md` also apply. Android emulator is the
selected QA adapter. Use a non-secret `API_BASE_URL` through the selected
BuildConfig/build mechanism, and do not create `local.properties`, product
flavors, or resource files unless allowlisted.

The compiled manifest entrypoint, module outputs, scaffold outputs, and work
unit are the closed contract. Do not add modules, convention plugins,
dependency catalogs, activities, or platform configuration ad hoc.
