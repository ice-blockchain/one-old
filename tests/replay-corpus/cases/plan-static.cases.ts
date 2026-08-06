// tests/replay-corpus/cases/plan-static.cases.ts
// The static half of the plan-write gate (src/modules/plan-guard/plan-static.ts):
// deterministic layout/style checks on one write's target path + content, with no
// state or convergence dependencies. 14 declared deny ids live here and they are
// the densest, cheapest region of the whole refusal surface — one payload each.
//
// Every case shares three deliberate fixture choices, each of which was a
// prerequisite for the check under test to be the one that fires:
//
//   1. scaffoldedMainAgent — plan.md already exists, so plan-readiness's
//      missing-plan gate stands aside, and team.mode is main-agent, so a
//      feature-source write is not first routed through run-team ownership
//      enforcement (see the fixture's own comment).
//   2. Paths under apps/web/ — stack 'default' in new-project mode is the
//      Turborepo layout, where plan-readiness denies ANY root-level src/** Vite
//      file unconditionally (monorepo-root-vite, characterized once on purpose
//      in plan-guard.cases.ts).
//   3. `Write` (file-write), not `Edit` — plan-write reconstructs the post-edit
//      file for an Edit and denies plan-write-struct-scan-incomplete without an
//      exact old_string/new_string pair, which would mask every check here.
//
// plan-write reports the FIRST registered violation that fired during the call
// (makeViolationBlock), so each payload below is written to trip exactly one.

import type { CaseSpec } from '../run-case';
import { existingCodebase, nativeGreenfield, scaffoldedMainAgent } from '../fixtures';

export const PLAN_STATIC_CASES: CaseSpec[] = [
  {
    id: 'plan-static.component-placement',
    notes: 'A capitalized .tsx directly in src/ is a component in the wrong home -> component-placement. src/App.tsx is the ONE exempt name (the canonical Vite root component), so this uses a different one',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: { class: 'file-write', rawName: 'Write', filePath: 'apps/web/src/Widget.tsx', content: 'export const Widget = () => null;\n' },
  },
  {
    id: 'plan-static.pages-service-files',
    notes: 'A service module under src/pages/ -> pages-service-files (pages stay thin; services live in src/services or src/features/<name>)',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: { class: 'file-write', rawName: 'Write', filePath: 'apps/web/src/pages/home.service.ts', content: 'export const loadHome = () => null;\n' },
  },
  {
    id: 'plan-static.expo-route-service-files',
    notes: 'The Expo Router equivalent: a service module under app/ -> expo-route-service-files. Reached on a web fixture too, because the rule keys on the app/ ROUTE path shape, not on the project being native',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: { class: 'file-write', rawName: 'Write', filePath: 'apps/web/app/home.service.ts', content: 'export const loadHome = () => null;\n' },
  },
  {
    id: 'plan-static.cross-feature-import',
    notes: 'A feature importing another feature -> cross-feature-import (shared code goes to src/components, packages/ui, or the api-client package)',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/web/src/features/cart/total.ts',
      content: "import { rate } from '@/features/checkout/api';\n\nexport const total = () => rate;\n",
    },
  },
  {
    id: 'plan-static.deep-relative-package',
    notes: 'A deep relative path across workspace packages -> deep-relative-package (import the package by name instead)',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/web/src/features/cart/button.ts',
      content: "import { Button } from '../../../packages/ui/src/Button';\n\nexport const use = () => Button;\n",
    },
  },
  {
    id: 'plan-static.default-export',
    notes: 'A default export from a reusable component -> default-export. Route files (Expo app/, web src/pages/) are the stated exception; src/components/ is not',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/web/src/components/Badge.tsx',
      content: 'export default function Badge() { return null; }\n',
    },
  },
  {
    id: 'plan-static.web-inline-style',
    notes: 'A STATIC inline style object on the web stack -> web-inline-style. Only static values are denied: the rule reserves inline style for dynamic/derived values, which is why the next case (a computed value) is allowed',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/web/src/components/Box.tsx',
      content: 'export const Box = () => <div style={{ width: 10 }} />;\n',
    },
  },
  {
    id: 'plan-static.dynamic-inline-style-allowed',
    notes: 'Control case for the same check: a DERIVED inline value (the rule\'s own stated exception) is not denied — this pair is what keeps a future tightening of styleObjectIsStatic visible',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: null,
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/web/src/components/Bar.tsx',
      content: 'export const Bar = ({ pct }: { pct: number }) => <div style={{ width: `${pct}%` }} />;\n',
    },
  },
  {
    id: 'plan-static.vanilla-extract-import',
    notes: 'vanilla-extract is off the active stack -> vanilla-extract-import',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/web/src/components/theme.ts',
      content: "import { style } from '@vanilla-extract/css';\n\nexport const box = style({});\n",
    },
  },
  {
    id: 'plan-static.css-ts-import',
    notes: 'The other half of the same stack change: importing a .css.ts module -> css-ts-import. Two ids because the remedies differ (drop the dependency vs. drop the generated stylesheet import)',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/web/src/components/panel.ts',
      content: "import { box } from './panel.css.ts';\n\nexport const use = () => box;\n",
    },
  },
  {
    id: 'plan-static.no-any',
    notes: 'An `any` annotation outside test scope -> no-any',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/web/src/components/util.ts',
      content: 'export const widen = (value: any) => value;\n',
    },
  },
  {
    id: 'plan-static.no-any-test-scope-allowed',
    notes: 'Control case: test files are exempt from no-any (coarse mock/fixture typing is idiomatic there and blocking it stalls the tester role over style, not correctness)',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: null,
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/web/src/components/__tests__/util.test.ts',
      content: 'export const widen = (value: any) => value;\n',
    },
  },
  {
    id: 'plan-static.websocket-location',
    notes: 'A WebSocket constructor outside packages/ws-client or src/services/ws -> websocket-location',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/web/src/components/live.ts',
      content: 'export const open = () => new WebSocket("wss://example.com");\n',
    },
  },
  {
    id: 'plan-static.asset-extension-mismatch',
    notes: 'SVG/XML text written into a bitmap path -> asset-extension-mismatch. This is a file-INTEGRITY check, not a stack opinion, which is exactly why the next case proves it survives the existing-codebase stand-down',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/web/public/logo.png',
      content: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>\n',
    },
  },
  {
    id: 'plan-static.asset-extension-mismatch-existing-codebase',
    notes: 'The SAME broken asset in existing-codebase mode is still denied: assetExtensionMismatchViolations is the one static check the existing-project stand-down keeps (a repo Traffic One did not create keeps its own conventions, but SVG bytes in a .png are broken everywhere)',
    host: 'claude',
    event: 'PreToolUse',
    project: existingCodebase,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'public/logo.png',
      content: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>\n',
    },
  },
  {
    id: 'plan-static.existing-codebase-standdown-allowed',
    notes: 'The other half of that stand-down: a payload that trips no-any (and would be denied on a Traffic One-created project) is allowed in existing-codebase mode. Pairs with plan-static.no-any — together they characterize the mode split, which a retiering must not collapse',
    host: 'claude',
    event: 'PreToolUse',
    project: existingCodebase,
    expectGate: null,
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'src/util.ts',
      content: 'export const widen = (value: any) => value;\n',
    },
  },
  {
    id: 'plan-static.native-inline-style',
    notes: 'React Native project: any inline object style -> native-inline-style (NativeWind className for static styles; StyleSheet.create only for animated/dynamic values). Needs the native fixture — the web branch of the same check allows dynamic values, so the two rules are not interchangeable',
    host: 'claude',
    event: 'PreToolUse',
    project: nativeGreenfield,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/mobile/src/components/Card.tsx',
      content: 'export const Card = () => <View style={{ padding: 4 }} />;\n',
    },
  },
  {
    id: 'plan-static.native-dom-tags',
    notes: 'React Native project: DOM tags instead of native primitives -> native-dom-tags',
    host: 'claude',
    event: 'PreToolUse',
    project: nativeGreenfield,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'apps/mobile/src/components/Row.tsx',
      content: 'export const Row = () => <div>hello</div>;\n',
    },
  },
  // The two remaining root-layout checks of the monorepo family whose third
  // member (monorepo-root-vite) is characterized in plan-guard.cases.ts. All
  // three fire only while stateRequiresNewProjectMonorepo holds, which is what
  // makes them a family worth pinning together: a stack/mode change that
  // silently drops the Turborepo requirement would take all three with it.
  {
    id: 'plan-static.monorepo-package-json',
    notes: 'A flat root package.json (no private/packageManager/workspaces) on a monorepo stack -> monorepo-package-json. The fixture\'s own root package.json is exactly this shape, so the deny is about the WRITE, not about repairing what is already there',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'package.json',
      content: '{\n  "name": "app",\n  "version": "0.0.0",\n  "dependencies": {}\n}\n',
    },
  },
  {
    id: 'plan-static.monorepo-root-flat-scaffold',
    notes: 'A root-level tsconfig.app.json — the tell-tale of a flat `create-vite` layout — on the same monorepo stack -> monorepo-root-flat-scaffold',
    host: 'claude',
    event: 'PreToolUse',
    project: scaffoldedMainAgent,
    expectGate: 'plan-guard.write',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'tsconfig.app.json',
      content: '{\n  "compilerOptions": { "strict": true }\n}\n',
    },
  },
];
