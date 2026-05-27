import { test } from 'node:test';
import assert from 'node:assert/strict';

import { architectureStaticViolations } from '../architecture-static';

// Fake block fn: return the block name so assertions check WHICH rules fired,
// independent of prose wording.
const names = (name: string): string => name;
function check(filePath: string, content: string, isNative = false): string[] {
  return architectureStaticViolations(filePath, content, isNative, names);
}

// Trigger tokens built by concatenation so this test source does not itself
// trip the live architecture gate when written into the plugin repo.
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
});

test('web inline styles + vanilla-extract + css.ts imports flagged on the web stack', () => {
  assert.deepEqual(check('apps/web/src/features/x/View.tsx', `<div ${INLINE} />`), ['web-inline-style']);
  assert.deepEqual(check('apps/web/src/x.ts', `import 'x' ${VE};`), ['vanilla-extract-import']);
  assert.deepEqual(check('apps/web/src/x.ts', `import { s } ${CSSTS};`), ['css-ts-import']);
});

test('native rules: NativeWind className + native primitives', () => {
  assert.ok(check('apps/mobile/src/features/x/View.tsx', `<View ${INLINE} />`, true).includes('native-inline-style'));
  assert.ok(check('apps/mobile/src/features/x/View.tsx', '<div>x</div>', true).includes('native-dom-tags'));
  // web style rules must NOT fire for native
  assert.equal(check('apps/mobile/src/features/x/View.tsx', `<View ${INLINE} />`, true).includes('web-inline-style'), false);
});

test('any-type and WebSocket-location checks fire on .ts/.tsx', () => {
  assert.ok(check('apps/web/src/x.ts', `const v${ANY} = 1;`).includes('no-any'));
  assert.ok(check('apps/web/src/x.ts', `const s = ${WS};`).includes('websocket-location'));
  // allowed WS locations are exempt
  assert.equal(check('packages/ws-client/src/x.ts', `const s = ${WS};`).includes('websocket-location'), false);
  assert.equal(check('apps/web/src/services/ws/x.ts', `const s = ${WS};`).includes('websocket-location'), false);
});
