// src/modules/plan-guard/forbidden.ts
// Per-stack forbidden-library tables + allowlist helpers. Ported 1:1 from
// scripts/hook-runtime/handlers/gates.cjs (INSTALL_RE, forbiddenForStack,
// stateFromStackForAllowlist, allowsNextjs, packageJsonHasNext).

import { dependenciesFromPackage, loadPackageJson } from '../../shared/detection';
import { isNativeState, isWebState } from '../../shared/state';

export const INSTALL_RE = /(npm (install|i|add)|yarn add|pnpm add|bun add)/;

type Rec = Record<string, unknown>;
type Rule = [string, string];

export function packageJsonHasNext(cwd: string): boolean {
  return Boolean(dependenciesFromPackage(loadPackageJson(cwd)).next);
}

export function allowsNextjs(state: Rec, cwd: string): boolean {
  return state.frontend === 'nextjs' || packageJsonHasNext(cwd);
}

export function stateFromStackForAllowlist(stackOrState: unknown): Rec {
  if (stackOrState && typeof stackOrState === 'object') return stackOrState as Rec;
  const stack = typeof stackOrState === 'string' ? stackOrState : null;
  if (stack === 'react-native-expo-monorepo' || stack === 'react-native-expo-app') {
    return { stack, frontend: 'none', backend: 'supabase', mobile: { enabled: true, framework: 'react-native-expo' } };
  }
  if (stack === 'react-realtime-monorepo' || stack === 'react-frontend-only' || stack === 'default' || stack === 'custom-backend') {
    return { stack, frontend: 'react-vite', backend: stack === 'react-frontend-only' ? 'none' : 'supabase', mobile: { enabled: false, framework: 'none' } };
  }
  return { stack, frontend: 'none', backend: 'none', mobile: { enabled: false, framework: 'none' } };
}

export function forbiddenForStack(stackOrState: unknown, allowNextjs: boolean): Rule[] {
  const state = stateFromStackForAllowlist(stackOrState);
  const common: Rule[] = [
    ['mobx', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['recoil', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['jotai', 'Use Redux Toolkit for global business state and zustand for ephemeral UI state.'],
    ['swr', 'Use RTK Query for cached server state.'],
    ['(?<!tanstack/)(?<!\\w)react-query(?!-)', 'Use RTK Query for cached server state.'],
  ];
  const web: Rule[] = [
    ['styled-components', 'Use Tailwind utility classes with shadcn primitives in packages/ui.'],
    ['@emotion', 'Use Tailwind utility classes with shadcn primitives in packages/ui.'],
    ['@vanilla-extract/', 'vanilla-extract is no longer in the active stack. Use Tailwind + shadcn (run `npx shadcn@latest add <name>`).'],
    ['nativewind', 'NativeWind is the React Native styling layer; the web stack uses plain Tailwind.'],
    ['@mui/', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['antd', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['material-ui', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['chakra-ui', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
    ['bootstrap', 'Build shared primitives in packages/ui by running `npx shadcn@latest add <name>` and composing them.'],
  ];
  if (!allowNextjs) {
    web.push([
      '(^|\\s)(next|next-auth)(@[\\w.-]+)?(\\s|$)',
      'Use the React/Vite stack unless the user explicitly chose Next.js; Next.js auth uses NextAuth/Auth.js only in a Next.js project.',
    ]);
  }
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

  if (isNativeState(state)) return [...common, ...native];
  if (isWebState(state) || state.stack === null) return [...common, ...web];
  return common;
}
