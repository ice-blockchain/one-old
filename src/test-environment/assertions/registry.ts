// src/test-environment/assertions/registry.ts
// Auto-discovers every *.assert.ts in this directory. Adding an assertion = drop
// a file that `export const assertion: Assertion`. No registration needed.

import * as fs from 'fs';
import * as path from 'path';

import type { Assertion } from '../core/types';

export function discoverAssertions(): Map<string, Assertion> {
  const map = new Map<string, Assertion>();
  const dir = __dirname;
  for (const file of fs.readdirSync(dir)) {
    if (!/\.assert\.(ts|js)$/.test(file)) continue;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(dir, file)) as { assertion?: Assertion };
    if (mod.assertion && typeof mod.assertion.id === 'string') {
      map.set(mod.assertion.id, mod.assertion);
    }
  }
  return map;
}
