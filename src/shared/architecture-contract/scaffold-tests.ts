// src/shared/architecture-contract/scaffold-tests.ts
// Workspace manifests, route registration, and tester-owned outputs.

import * as path from 'path';
import {
  type CapabilityProfileV1,
} from '../capabilities';

import {
  type ArchitectureRouteInputV1,
  type CompiledArchitectureModuleV1,
  type CompiledArchitectureOutputV1,
} from './types';
import {
  kebab,
  pascal,
  snake,
} from './naming';
import {
  selectedTargetHasWebUi,
  workspaceScaffoldOutputs,
} from './scaffold';

export function workspaceManifestOutputs(
  scaffoldOutputs: readonly CompiledArchitectureOutputV1[],
  modules: readonly CompiledArchitectureModuleV1[],
): CompiledArchitectureOutputV1[] {
  const owners = new Map<string, string>();
  const claim = (outputPath: string, ownerRole: string): void => {
    const pkg = /^(packages\/[^/]+)\//.exec(outputPath)?.[1];
    if (!pkg || !ownerRole) return;
    if (!owners.has(pkg)) owners.set(pkg, ownerRole);
  };
  // Scaffold outputs first: a profile that already names the manifest keeps its
  // declared owner, and the entry below is then deduped away.
  for (const output of scaffoldOutputs) claim(output.path, output.ownerRole);
  for (const module of modules) claim(module.output, module.ownerRole);
  const existing = new Set(scaffoldOutputs.map((output) => output.path));
  const outputs = [...owners.entries()]
    .map(([pkg, ownerRole]) => ({ path: `${pkg}/package.json`, ownerRole, kind: 'scaffold' as const }))
    .filter((output) => !existing.has(output.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  // A workspace member without the workspace declaration is equally
  // unresolvable: profiles whose web root is `.` (next-app, next-pages, …)
  // never pass through workspaceScaffoldOutputs, yet a backend overlay still
  // compiles `packages/api-client/**` — the run then ships a `packages/`
  // member no install can link (observed 5cl-claude: `packages/api-client`
  // existed with NO `pnpm-workspace.yaml` in any role's scope). Emit the
  // declaration exactly once, owned by the repo-shell owner.
  if (owners.size > 0 && !existing.has('pnpm-workspace.yaml')) {
    // Same owner as the root manifest when one is compiled (the repo shell),
    // else the sole package's owner.
    const shellOwner = scaffoldOutputs.find((output) => output.path === 'package.json')?.ownerRole
      || [...owners.values()][0]!;
    outputs.push({ path: 'pnpm-workspace.yaml', ownerRole: shellOwner, kind: 'scaffold' as const });
  }
  return outputs;
}

export function routeRegistrationOutputs(
  profile: CapabilityProfileV1,
  routes: readonly ArchitectureRouteInputV1[],
): CompiledArchitectureOutputV1[] {
  if (
    routes.length === 0
    || profile.profileId !== 'server-rendered'
    || profile.framework !== 'laravel'
  ) return [];
  return [{
    path: 'routes/web.php',
    // This registration is the integration edge for frontend-owned page
    // modules. Keep one owner so parallel frontend/backend units never share a
    // writable route file.
    ownerRole: 'senior-frontend',
    kind: 'scaffold',
  }];
}

function testOutputForModule(
  profile: CapabilityProfileV1,
  module: CompiledArchitectureModuleV1,
): string {
  if (module.kind === 'test') return module.output;
  const basename = path.posix.basename(module.output).replace(/\.[^.]+$/, '');
  if (profile.backendFramework === 'go' && module.output.endsWith('.go')) {
    return module.output.replace(/\.go$/, '_test.go');
  }
  if (['python', 'django', 'fastapi'].includes(profile.backendFramework) && module.output.endsWith('.py')) {
    return `tests/test_${snake(basename)}.py`;
  }
  if (['laravel', 'php'].includes(profile.backendFramework) && module.output.endsWith('.php')) {
    return `tests/Feature/${pascal(basename)}Test.php`;
  }
  if (profile.profileId === 'swift-native') return `Tests/${pascal(basename)}Tests.swift`;
  if (profile.profileId === 'kotlin-native') return `app/src/test/${pascal(basename)}Test.kt`;
  if (profile.profileId === 'flutter-native') return `test/${snake(basename)}_test.dart`;
  return `tests/${kebab(basename)}.test.ts`;
}

export function testerOutputs(
  profile: CapabilityProfileV1,
  modules: CompiledArchitectureModuleV1[],
): CompiledArchitectureOutputV1[] {
  const outputs: CompiledArchitectureOutputV1[] = modules
    .filter((module) => module.kind !== 'app-shell')
    .map((module) => ({
      path: testOutputForModule(profile, module),
      ownerRole: 'senior-tester',
      kind: 'test',
    }));
  if (selectedTargetHasWebUi(profile)) {
    outputs.push(
      // A unit-test runner config the tester OWNS. Without one it has no legal
      // place to configure a runner and improvises: observed 2cu, the tester
      // built a parallel harness (its own package.json + lockfile) under
      // `.traffic-one/reports/qa/<runId>/test-harness/` and installed 241 MB of
      // node_modules into the plugin's state directory, running the suite
      // against a config disconnected from the real workspace.
      { path: 'vitest.config.ts', ownerRole: 'senior-tester', kind: 'test-infra' },
      { path: 'playwright.config.ts', ownerRole: 'senior-tester', kind: 'test-infra' },
      { path: 'tests/e2e/smoke.spec.ts', ownerRole: 'senior-tester', kind: 'test' },
    );
  }
  if (profile.profileId === 'react-native') {
    outputs.push({ path: '.maestro/flows/smoke.yaml', ownerRole: 'senior-tester', kind: 'test-infra' });
  } else if (profile.profileId === 'swift-native') {
    outputs.push({ path: 'Tests/AppSmokeTests.swift', ownerRole: 'senior-tester', kind: 'test-infra' });
  } else if (profile.profileId === 'kotlin-native') {
    outputs.push({ path: 'app/src/androidTest/AppSmokeTest.kt', ownerRole: 'senior-tester', kind: 'test-infra' });
  } else if (profile.profileId === 'flutter-native') {
    outputs.push({ path: 'integration_test/app_test.dart', ownerRole: 'senior-tester', kind: 'test-infra' });
  } else if (['python', 'django', 'fastapi'].includes(profile.backendFramework)) {
    outputs.push({ path: 'tests/conftest.py', ownerRole: 'senior-tester', kind: 'test-infra' });
  } else if (['laravel', 'php'].includes(profile.backendFramework)) {
    outputs.push({ path: 'phpunit.xml', ownerRole: 'senior-tester', kind: 'test-infra' });
  }
  return outputs;
}
