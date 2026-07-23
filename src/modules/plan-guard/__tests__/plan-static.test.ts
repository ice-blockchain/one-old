import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planStaticViolations } from '../plan-static';

// Fake block fn: return the block name so assertions check WHICH rules fired,
// independent of prose wording.
const names = (name: string): string => name;
function check(filePath: string, content: string, isNative = false): string[] {
  return planStaticViolations(filePath, content, isNative, names);
}

// Trigger tokens built by concatenation so this test source does not itself
// trip the live plan gate when written into the plugin repo.
const INLINE = 'style={' + '{ color: 1 }}';
const WS = 'new ' + 'WebSocket("/x")';
const ANY = ': ' + 'any';
const DEEP = "from '../" + "../../packages/ui'";
const VE = "from '@vanilla" + "-extract/css'";
const CSSTS = "from './styles" + ".css.ts'";

test('a clean component file has no violations', () => {
  assert.deepEqual(check('apps/web/src/components/Button.tsx', 'export const Button = () => null;'), []);
});

test('service/store files are rejected under src/pages and expo app/', () => {
  assert.deepEqual(check('src/pages/home.service.ts', ''), ['pages-service-files']);
  assert.deepEqual(check('apps/mobile/app/index.store.tsx', ''), ['expo-route-service-files']);
});

test('components directly under src/ are rejected (web vs native target)', () => {
  assert.deepEqual(check('src/Button.tsx', ''), ['component-placement']);
  assert.deepEqual(check('apps/web/src/Card.ts', ''), ['component-placement']);
});

test('the canonical root component src/App.tsx is exempt from component placement', () => {
  // every Vite template ships index.html → src/main.tsx → src/App.tsx
  // (observed 8c-codex: the gate forced a non-standard components/App.tsx move)
  assert.deepEqual(check('apps/web/src/App.tsx', 'export function App() { return null; }'), []);
  assert.deepEqual(check('src/App.tsx', 'export function App() { return null; }'), []);
  assert.deepEqual(check('src/App.ts', ''), []);
  // only the root component — siblings stay gated
  assert.deepEqual(check('apps/web/src/AppShell.tsx', ''), ['component-placement']);
  // deeper App.tsx files never matched this rule and still do not
  assert.deepEqual(check('apps/web/src/components/App.tsx', 'export const App = () => null;'), []);
});

test('cross-feature imports are flagged', () => {
  const content = "import { x } " + "from '@/features/billing/api';";
  assert.deepEqual(check('src/features/auth/widget.ts', content), ['cross-feature-import']);
  // same-feature import is fine
  assert.deepEqual(check('src/features/auth/widget.ts', "import { x } " + "from '@/features/auth/api';"), []);
});

test('deep relative package imports are flagged', () => {
  assert.deepEqual(check('apps/web/src/x.ts', `import { y } ${DEEP};`), ['deep-relative-package']);
});

test('default export in a reusable component is flagged', () => {
  assert.deepEqual(check('packages/ui/src/components/Btn.tsx', 'export default function Btn() {}'), ['default-export']);
  assert.deepEqual(check('apps/web/src/features/x/Card.tsx', 'export default function Card() {}'), ['default-export']);
});

test('default export in web page/route files is the exception (8c: React.lazy contract)', () => {
  assert.deepEqual(check('apps/web/src/pages/HomePage.tsx', 'export default function HomePage() {}'), []);
  assert.deepEqual(check('src/pages/CoursesPage.tsx', 'export default function CoursesPage() {}'), []);
  // named exports in pages remain fine too
  assert.deepEqual(check('apps/web/src/pages/NewsPage.tsx', 'export function NewsPage() {}'), []);
});

test('web inline styles + vanilla-extract + css.ts imports flagged on the web stack', () => {
  assert.deepEqual(check('apps/web/src/features/x/View.tsx', `<div ${INLINE} />`), ['web-inline-style']);
  assert.deepEqual(check('apps/web/src/x.ts', `import 'x' ${VE};`), ['vanilla-extract-import']);
  assert.deepEqual(check('apps/web/src/x.ts', `import { s } ${CSSTS};`), ['css-ts-import']);
});

test('web inline style with dynamic/derived values is the rule\'s own exception (5c-F1)', () => {
  const style = (body: string): string => 'style={' + '{' + body + '}}';
  // template-literal width — the exact 5c/8c progress-bar case
  assert.deepEqual(
    check('packages/ui/src/components/progress.tsx', `<div ${style(' width: `${clamped}%` ')} />`),
    [],
  );
  // identifier value
  assert.deepEqual(check('apps/web/src/features/x/View.tsx', `<div ${style(' width: pct ')} />`), []);
  // mixed static + dynamic → the dynamic member justifies inline
  assert.deepEqual(
    check('apps/web/src/features/x/View.tsx', `<div ${style(" color: 'red', width: pct ")} />`),
    [],
  );
  // spread → dynamic
  assert.deepEqual(check('apps/web/src/features/x/View.tsx', `<div ${style(' ...styleProp ')} />`), []);
  // all-literal objects stay denied (string and numeric literals)
  assert.deepEqual(
    check('apps/web/src/features/x/View.tsx', `<div ${style(" color: 'red', marginTop: 8 ")} />`),
    ['web-inline-style'],
  );
  // a second static occurrence still denies even when the first is dynamic
  assert.deepEqual(
    check('apps/web/src/features/x/View.tsx', `<div ${style(' width: pct ')} /><span ${style(" color: 'red' ")} />`),
    ['web-inline-style'],
  );
});

test('native inline style stays denied even for dynamic values (StyleSheet.create owns those)', () => {
  const dynamic = 'style={' + '{ width: pct }}';
  assert.ok(check('apps/mobile/src/features/x/View.tsx', `<View ${dynamic} />`, true).includes('native-inline-style'));
});

test('native rules: NativeWind className + native primitives', () => {
  assert.ok(check('apps/mobile/src/features/x/View.tsx', `<View ${INLINE} />`, true).includes('native-inline-style'));
  assert.ok(check('apps/mobile/src/features/x/View.tsx', '<div>x</div>', true).includes('native-dom-tags'));
  // web style rules must NOT fire for native
  assert.equal(check('apps/mobile/src/features/x/View.tsx', `<View ${INLINE} />`, true).includes('web-inline-style'), false);
});

test('any-type and WebSocket-location checks fire on .ts/.tsx', () => {
  assert.ok(check('apps/web/src/x.ts', `const v${ANY} = 1;`).includes('no-any'));
  // Test files are exempt from the no-any rule (B12) — mocks/fixtures typing is
  // idiomatic there and the tester role must not stall on it.
  assert.equal(check('apps/web/src/services/courses.test.ts', `const v${ANY} = 1;`).includes('no-any'), false);
  assert.equal(check('tests/i18n-integration.test.ts', `const v${ANY} = 1;`).includes('no-any'), false);
  assert.equal(check('packages/ui/src/__tests__/btn.ts', `const v${ANY} = 1;`).includes('no-any'), false);
  assert.ok(check('apps/web/src/x.ts', `const s = ${WS};`).includes('websocket-location'));
  // allowed WS locations are exempt
  assert.equal(check('packages/ws-client/src/x.ts', `const s = ${WS};`).includes('websocket-location'), false);
  assert.equal(check('apps/web/src/services/ws/x.ts', `const s = ${WS};`).includes('websocket-location'), false);
});
