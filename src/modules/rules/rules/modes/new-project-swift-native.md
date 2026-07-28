---
description: "Apply only when CompiledArchitectureV1 profileId=swift-native: Swift/SwiftUI roots, package scaffold, services, and simulator QA."
---

# New Project Profile — Native Swift / SwiftUI

Apply only when `CompiledArchitectureV1.profile.profileId=swift-native`.

```
<repo-root>/
├── Package.swift
├── Tests/
│   ├── <Module>Tests.swift                derived module tests
│   └── AppSmokeTests.swift                simulator smoke test
└── <native-root>/
    ├── App.swift                          selected application entrypoint
    ├── Sources/ | App/                    compiled source root
    ├── Features/ | Views/                 screen/page candidates
    ├── Components/
    ├── Core/
    └── Services/
```

Use the roots frozen in the compiled profile exactly. `Features` is both the
first page and feature candidate; `Views` is the alternate page candidate.
`Core` and `Services` are library candidates. Candidate roots are not a
request to create parallel architectures.

The deterministic native scaffold and tester outputs are repository-relative;
`<native-root>` applies only to detected source/entrypoint candidates. Common repository
outputs from `rules/modes/new-project-architecture.md` also apply. Xcode
simulator is the selected QA adapter. A non-secret external API base URL should
be named `API_BASE_URL` and injected by the chosen build configuration, but no
`.xcconfig` or plist is authorized unless compiled.

Use `modules[].output`, the selected entrypoint, scaffold outputs, and the
active work-unit allowlist exactly. Do not invent an Xcode project, target,
entitlements, package, persistence layer, or configuration file.
