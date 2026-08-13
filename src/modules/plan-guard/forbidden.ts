// src/modules/plan-guard/forbidden.ts
// Per-stack forbidden-library tables + allowlist helpers. Ported 1:1 from
// scripts/hook-runtime/handlers/gates.cjs (INSTALL_RE, forbiddenForStack,
// stateFromStackForAllowlist, allowsNextjs, packageJsonHasNext).

import { dependenciesFromPackage, loadPackageJson } from '../../shared/detection';
import { isNativeState, isWebState } from '../../shared/state';
import {
  defaultStateForStack,
  type WebUiSystemV1,
} from '../../shared/capabilities';

export const INSTALL_RE = /(npm (install|i|add)|yarn add|pnpm add|bun add)/;

type Rec = Record<string, unknown>;
type Rule = [string, string];

/**
 * A table row plus the one thing the table never used to say: whether departing
 * from it is a refusal or a remark.
 *
 * Almost every row here is a LIBRARY PREFERENCE — "use Redux Toolkit, not
 * jotai", "the active UI system is not MUI". Those are opinions about the
 * user's code: nothing downstream reads them, no required check resolves
 * differently because of them, and the deny they used to raise offered no exit
 * at all (there is no "I need this one" path), so a project that wanted a
 * second component library simply could not install it. They are advisory now.
 *
 * `blocking` is deliberately an OPT-IN carried by the row rather than a list
 * kept somewhere else: a rule added to any table below is advisory unless its
 * author states otherwise, so the next taste rule cannot quietly become the
 * next deny.
 */
export interface ForbiddenRule {
  pattern: string;
  tip: string;
  blocking: boolean;
}

function advisory(rules: readonly Rule[]): ForbiddenRule[] {
  return rules.map(([pattern, tip]) => ({ pattern, tip, blocking: false }));
}

function packageJsonHasNext(cwd: string): boolean {
  return Boolean(dependenciesFromPackage(loadPackageJson(cwd)).next);
}

export function allowsNextjs(state: Rec, cwd: string): boolean {
  return state.frontend === 'nextjs' || packageJsonHasNext(cwd);
}

/**
 * The dependencies whose PRESENCE decides which frontend
 * `capabilityProfileForProject` reports, in the order the detector consults
 * them (`frameworkFromDependencies` in shared/capabilities/detect-frontend.ts).
 * The order is load-bearing twice over: detection returns the FIRST match, so
 * it is what makes a row's claim measurable, and it is why installing `svelte`
 * into a Vue project changes nothing while installing `vue` into a React one
 * changes everything.
 *
 * `next` used to be the only row here, on the argument that adding it changes
 * what the profile detects while the run's architecture and verification
 * contracts stay frozen against the old answer. Measured against
 * `capabilityProfileForProject` on a react-vite fixture, ALL NINE do exactly
 * that — `npm i vue` moved profileId, framework and entrypoints in the same
 * breath, and `vue` is checked BEFORE `react` — while the advisory rows this
 * table is otherwise made of moved none of those three.
 *
 * "None of those three" is the whole of what was measured, and the earlier
 * wording ("moved nothing") claimed more. `@mui/material` DOES move
 * `uiSystem`: `resolveWebUiSystem` reads it from disk whenever state declares
 * no `uiLibrary`, so installing it makes `mui` the detected system. The tier is
 * still right — `uiSystem` is not part of the frozen profile identity the
 * architecture and verification contracts are compiled against, so the run's
 * contracts stay coherent and the correct answer is advice — but the reason is
 * "it moves a field the contracts do not freeze", not "it moves nothing".
 */
const FRAMEWORK_MARKERS: ReadonlyArray<{
  frontend: string;
  deps: readonly string[];
  pattern: string;
  tip: string;
}> = [
  {
    frontend: 'nextjs',
    deps: ['next'],
    pattern: '(^|\\s)(next|next-auth)(@[\\w.-]+)?(\\s|$)',
    tip: 'Use the React/Vite stack unless the user explicitly chose Next.js; Next.js auth uses NextAuth/Auth.js only in a Next.js project.',
  },
  {
    frontend: 'nuxt',
    deps: ['nuxt'],
    pattern: '(^|\\s)nuxt(@[\\w.-]+)?(\\s|$)',
    tip: 'Installing Nuxt makes the runtime detect a Nuxt project, with different source roots, entrypoints and build commands than this run compiled. Choose Nuxt at onboarding instead.',
  },
  {
    frontend: 'sveltekit',
    deps: ['@sveltejs/kit'],
    pattern: '(^|\\s)@sveltejs/kit(@[\\w.-]+)?(\\s|$)',
    tip: 'Installing SvelteKit makes the runtime detect a SvelteKit project, with different source roots, entrypoints and build commands than this run compiled. Choose SvelteKit at onboarding instead.',
  },
  {
    frontend: 'astro',
    deps: ['astro'],
    pattern: '(^|\\s)astro(@[\\w.-]+)?(\\s|$)',
    tip: 'Installing Astro makes the runtime detect an Astro project, with different entrypoints and build commands than this run compiled. Choose Astro at onboarding instead.',
  },
  {
    frontend: 'angular',
    deps: ['@angular/core', '@angular/cli'],
    pattern: '(^|\\s)@angular/(core|cli)(@[\\w.-]+)?(\\s|$)',
    tip: 'Installing Angular makes the runtime detect an Angular project, with different source roots, entrypoints and build commands than this run compiled. Choose Angular at onboarding instead.',
  },
  {
    frontend: 'vue',
    deps: ['vue', '@vitejs/plugin-vue'],
    pattern: '(^|\\s)(vue|@vitejs/plugin-vue)(@[\\w.-]+)?(\\s|$)',
    tip: 'Vue is checked before React in framework detection, so installing it makes the runtime report a Vue project — different entrypoints and QA adapter than this run compiled. Choose Vue at onboarding instead.',
  },
  {
    frontend: 'svelte',
    deps: ['svelte'],
    pattern: '(^|\\s)svelte(@[\\w.-]+)?(\\s|$)',
    tip: 'Svelte is checked before React in framework detection, so installing it makes the runtime report a Svelte project — different entrypoints and QA adapter than this run compiled. Choose Svelte at onboarding instead.',
  },
  {
    frontend: 'remix',
    deps: ['@remix-run/react'],
    pattern: '(^|\\s)@remix-run/react(@[\\w.-]+)?(\\s|$)',
    tip: 'Installing Remix makes the runtime detect a Remix project, with different source roots and entrypoints than this run compiled. Choose Remix at onboarding instead.',
  },
  {
    frontend: 'solid',
    deps: ['solid-js', '@solidjs/start'],
    pattern: '(^|\\s)(solid-js|@solidjs/start)(@[\\w.-]+)?(\\s|$)',
    tip: 'Installing Solid makes the runtime detect a Solid project, with different source roots and entrypoints than this run compiled. Choose Solid at onboarding instead.',
  },
];

/**
 * Which of the markers above this project already carries, so a row is never
 * emitted against a dependency the project depends on. The mirror of
 * `allowsNextjs`'s disk half, generalized.
 */
export function installedFrameworkDeps(cwd: string): Set<string> {
  const deps = dependenciesFromPackage(loadPackageJson(cwd));
  return new Set(FRAMEWORK_MARKERS.flatMap((marker) => marker.deps.filter((dep) => deps[dep])));
}

/**
 * The rows that are not preferences. Adding one of these to a project the
 * runtime compiled as something else does not merely diverge from a chosen
 * stack — it changes what `capabilityProfileForProject` DETECTS, and the
 * profile is where source roots, entrypoints, the build/dev commands and the
 * QA adapter come from.
 *
 * The reason that matters is the FROZEN run snapshot, not the live detector:
 * the architecture and verification contracts for an in-flight run were
 * compiled against the old answer and every consumer that decides anything —
 * the write allowlist, the QA adapter, `changedRoutes` — reads those, not a
 * fresh detection. So the checks gathered after the install measure a
 * different project than the contract names, while the contract hash still
 * validates. That is an evidence boundary, not taste.
 *
 * Each row keeps a named exit either way: choose the framework at onboarding,
 * or already depend on it, and the row is not emitted at all. And a marker that
 * ranks LATER than the project's own framework is never emitted, because
 * detection returns the first match and the answer would not move.
 *
 * That last clause is measured rather than reasoned, against
 * `capabilityProfileForProject` on four project shapes: on react-vite, on an
 * undeclared state with react-vite on disk, on Expo and on a Go backend, every
 * marker moves profileId/framework/entrypoints (Expo and the backend gain a
 * whole `web-ui` surface); on a Vue project only the five markers ranked above
 * `vue` move it, and `svelte`, `@remix-run/react` and `solid-js` leave it
 * untouched. `mobx` is the control and never moves it on any shape.
 */
function frameworkBoundaryRules(
  state: Rec,
  allowNextjs: boolean,
  allowedFrameworkDeps: ReadonlySet<string>,
  detectedFrontend: string,
): ForbiddenRule[] {
  // The DETECTED framework, not the declared one, because the flip these rows
  // exist to refuse is a detector outcome — and an undeclared `.one.json`
  // still sits on a real project the detector can read.
  const declared = detectedFrontend
    || (typeof state.frontend === 'string' ? state.frontend : '');
  const declaredRank = FRAMEWORK_MARKERS.findIndex((marker) => marker.frontend === declared);
  return FRAMEWORK_MARKERS
    .filter((marker, rank) => {
      if (marker.frontend === declared) return false;
      if (marker.frontend === 'nextjs' && allowNextjs) return false;
      if (marker.deps.some((dep) => allowedFrameworkDeps.has(dep))) return false;
      return declaredRank < 0 || rank < declaredRank;
    })
    .map((marker) => ({ pattern: marker.pattern, tip: marker.tip, blocking: true }));
}

function stateFromStackForAllowlist(stackOrState: unknown): Rec {
  if (stackOrState && typeof stackOrState === 'object') return stackOrState as Rec;
  const stack = typeof stackOrState === 'string' ? stackOrState : null;
  if (stack === 'react-native-expo-monorepo' || stack === 'react-native-expo-app') {
    return { stack, frontend: 'none', backend: 'supabase', mobile: { enabled: true, framework: 'react-native-expo' } };
  }
  if (stack === 'react-realtime-monorepo' || stack === 'react-frontend-only') {
    return { stack, frontend: 'react-vite', backend: stack === 'react-frontend-only' ? 'none' : 'supabase', mobile: { enabled: false, framework: 'none' } };
  }
  return defaultStateForStack(stack || 'minimal');
}

export function forbiddenForStack(
  stackOrState: unknown,
  allowNextjs: boolean,
  uiSystem?: WebUiSystemV1,
  allowedFrameworkDeps: ReadonlySet<string> = new Set<string>(),
  detectedFrontend = '',
): ForbiddenRule[] {
  const state = stateFromStackForAllowlist(stackOrState);
  const common: Rule[] = [
    ['mobx', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['recoil', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['jotai', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['swr', 'Use RTK Query for cached server state.'],
    ['(?<!tanstack/)(?<!\\w)react-query(?!-)', 'Use RTK Query for cached server state.'],
  ];
  const shadcnStyling: Rule[] = [
    ['styled-components', 'Use Tailwind utility classes with shadcn primitives in packages/ui.'],
    ['@emotion', 'Use Tailwind utility classes with shadcn primitives in packages/ui.'],
    ['@vanilla-extract/', 'vanilla-extract is no longer in the active stack. Use Tailwind + shadcn (run `npx shadcn@latest add <name>`).'],
    ['nativewind', 'NativeWind is the React Native styling layer; the web stack uses plain Tailwind.'],
  ];
  const componentLibraries: Array<[string, string, string]> = [
    ['shadcn', '(^|\\s)shadcn(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not shadcn. Reuse the selected component system instead of adding a second one.'],
    ['shadcn-vue', '(^|\\s)shadcn-vue(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not shadcn-vue. Reuse the selected component system instead of adding a second one.'],
    ['shadcn-svelte', '(^|\\s)shadcn-svelte(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not shadcn-svelte. Reuse the selected component system instead of adding a second one.'],
    ['mui', '@mui/|material-ui', 'The active UI system is not MUI. Reuse the selected component system instead of adding a second one.'],
    ['ant-design', '(^|\\s)antd(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not Ant Design. Reuse the selected component system instead of adding a second one.'],
    ['chakra-ui', '@chakra-ui/', 'The active UI system is not Chakra UI. Reuse the selected component system instead of adding a second one.'],
    ['mantine', '@mantine/', 'The active UI system is not Mantine. Reuse the selected component system instead of adding a second one.'],
    ['bootstrap', '(^|\\s)(?:bootstrap|react-bootstrap)(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not Bootstrap. Reuse the selected component system instead of adding a second one.'],
    ['vuetify', '(^|\\s)vuetify(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not Vuetify. Reuse the selected component system instead of adding a second one.'],
    ['primevue', '(^|\\s)primevue(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not PrimeVue. Reuse the selected component system instead of adding a second one.'],
    ['quasar', '(^|\\s)quasar(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not Quasar. Reuse the selected component system instead of adding a second one.'],
    ['element-plus', '(^|\\s)element-plus(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not Element Plus. Reuse the selected component system instead of adding a second one.'],
    ['naive-ui', '(^|\\s)naive-ui(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not Naive UI. Reuse the selected component system instead of adding a second one.'],
    ['nuxt-ui', '@nuxt/ui', 'The active UI system is not Nuxt UI. Reuse the selected component system instead of adding a second one.'],
    ['skeleton', '@skeletonlabs/skeleton', 'The active UI system is not Skeleton. Reuse the selected component system instead of adding a second one.'],
    ['flowbite', 'flowbite(?:-react|-svelte)?', 'The active UI system is not Flowbite. Reuse the selected component system instead of adding a second one.'],
    ['angular-material', '@angular/material', 'The active UI system is not Angular Material. Reuse the selected component system instead of adding a second one.'],
    ['primeng', '(^|\\s)primeng(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not PrimeNG. Reuse the selected component system instead of adding a second one.'],
    ['ng-zorro', 'ng-zorro-antd', 'The active UI system is not NG-ZORRO. Reuse the selected component system instead of adding a second one.'],
    ['daisyui', '(^|\\s)daisyui(?:@[\\w.-]+)?(\\s|$)', 'The active UI system is not daisyUI. Reuse the selected component system instead of adding a second one.'],
  ];
  const activeLibrary = uiSystem?.family === 'external'
    ? uiSystem.library
    : uiSystem?.family === 'shadcn'
      ? uiSystem.adapter
      : null;
  const componentConflicts: Rule[] = componentLibraries
    .filter(([id]) => id !== activeLibrary)
    .map(([, pattern, tip]) => [pattern, tip]);
  const web: Rule[] = [
    ...(uiSystem?.family === 'shadcn' ? shadcnStyling : []),
    ...componentConflicts,
  ];
  const stackBoundary = frameworkBoundaryRules(
    state,
    allowNextjs,
    allowedFrameworkDeps,
    detectedFrontend,
  );
  const native: Rule[] = [
    ['vitest', 'This stack uses Jest for unit/integration tests.'],
    ['@vitest/', 'This stack uses Jest for unit/integration tests.'],
    ['styled-components', 'Use NativeWind `className` with React Native Reusables primitives in packages/ui-native.'],
    ['@emotion', 'Use NativeWind `className` with React Native Reusables primitives in packages/ui-native.'],
    ['@vanilla-extract/', 'vanilla-extract is web-only and no longer used. The Expo stack uses NativeWind + React Native Reusables.'],
    ['react-router-dom', 'Use Expo Router for React Native navigation.'],
    ['framer-motion', 'Use react-native-reanimated for React Native animations.'],
    ['@mui/', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['antd', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['material-ui', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['chakra-ui', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
    ['bootstrap', 'Build shared native primitives in packages/ui-native via `npx @react-native-reusables/cli@latest add <name>`.'],
  ];

  // The boundary rows ride along on every shape, because the flip they refuse
  // is not a property of the chosen stack: measured on Expo and on a Go
  // backend, installing any marker adds a `web-ui` surface and rewrites the
  // entrypoints and QA adapter the frozen contract was compiled from — the
  // Expo case lands on `unsupported-hybrid`, which is worse than the web case,
  // not better. The advisory rows keep their stack-shaped split.
  if (isNativeState(state)) return [...advisory([...common, ...native]), ...stackBoundary];
  if (isWebState(state) || state.stack === null) {
    return [...advisory([...common, ...web]), ...stackBoundary];
  }
  return [...advisory(common), ...stackBoundary];
}
