import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { OPENCODE_RUN_MAX_BUFFER } from '../run-model';

test('opencode run raises spawnSync maxBuffer above the 1 MiB default', () => {
  assert.ok(OPENCODE_RUN_MAX_BUFFER > 1024 * 1024);
  const src = fs.readFileSync(path.join(__dirname, '..', 'run-model.ts'), 'utf8');
  assert.match(src, /spawnTool\(/);
  assert.match(src, /maxBuffer:\s*OPENCODE_RUN_MAX_BUFFER/);
});
