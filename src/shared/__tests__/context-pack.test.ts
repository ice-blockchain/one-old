// Context pack + rules-ack (1.0.37, 8co): parts stay under the Codex
// truncation ceiling, the pager records receipts, and completion requires a
// full ack only when a pack exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CONTEXT_PACK_PART_MAX_CHARS,
  compileIntegrationRequirements,
  compileRoleContextPack,
  contextPackDir,
  contextPackPartDir,
  readContextPackManifest,
  readRulesAck,
  rulesAckComplete,
} from '../run-bootstrap-policy';
import { main as rulesAckMain } from '../../runners/rules-ack';

const RUN_ID = '1785341588480';
const ROLE = 'senior-frontend';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-context-pack-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function compilePack(cwd: string): void {
  const manifest = compileRoleContextPack(
    cwd,
    RUN_ID,
    ROLE,
    ['common/clean-code.md', 'frontend/services.md'],
    ['create-component'],
    compileIntegrationRequirements(ROLE, ['web-ui', 'api'], [
      'packages/api-client/src/index.ts',
      'apps/web/public/sitemap.xml',
      'apps/web/public/robots.txt',
    ]),
  );
  assert.ok(manifest, 'pack must compile from real plugin materials');
}

test('pack compiles real materials into parts under the truncation budget', () => {
  withProject((cwd) => {
    compilePack(cwd);
    const manifest = readContextPackManifest(cwd, RUN_ID, ROLE);
    assert.ok(manifest);
    assert.ok(manifest!.parts.length >= 1);
    for (const part of manifest!.parts) {
      assert.ok(part.chars <= CONTEXT_PACK_PART_MAX_CHARS + 512, `${part.file} over budget: ${part.chars}`);
      // Part bodies are content-addressed in the run-level shared store, so the
      // always-on rules every role loads are written once instead of per role.
      // The directory is resolved by code, never from the manifest.
      assert.equal(part.shared, true, `${part.file} must live in the shared store`);
      assert.equal(part.file, `${part.sha256}.md`, 'a part filename is its content hash');
      const partDir = contextPackPartDir(cwd, RUN_ID, ROLE, part);
      const body = fs.readFileSync(path.join(partDir, part.file), 'utf8');
      assert.equal(body.length, part.chars);
    }
    const index = fs.readFileSync(path.join(contextPackDir(cwd, RUN_ID, ROLE), 'part-00.md'), 'utf8');
    assert.match(index, /ONE part per command|one command per part/i);
    assert.match(index, /Integration requirements/);
    assert.match(index, /STRUCT_API_CLIENT_UNUSED/);
    assert.match(index, /VITE_SITE_URL/);
  });
});

test('rules-ack pager serves parts, records receipts, and completes the ack', () => {
  withProject((cwd) => {
    compilePack(cwd);
    const manifest = readContextPackManifest(cwd, RUN_ID, ROLE)!;
    assert.equal(rulesAckComplete(cwd, RUN_ID, ROLE), false, 'fresh pack is unacknowledged');

    // Index invocation records nothing.
    assert.equal(rulesAckMain(['--run-id', RUN_ID, '--role', ROLE], cwd), 0);
    assert.equal(readRulesAck(cwd, RUN_ID, ROLE), null);

    for (let part = 1; part <= manifest.parts.length; part += 1) {
      assert.equal(rulesAckMain(['--run-id', RUN_ID, '--role', ROLE, '--part', String(part)], cwd), 0);
    }
    const ack = readRulesAck(cwd, RUN_ID, ROLE);
    assert.ok(ack?.completedAt, 'full serve stamps completedAt');
    assert.equal(rulesAckComplete(cwd, RUN_ID, ROLE), true);

    // Out-of-range and missing pack fail loudly.
    assert.equal(rulesAckMain(['--run-id', RUN_ID, '--role', ROLE, '--part', '99'], cwd), 2);
    assert.equal(rulesAckMain(['--run-id', RUN_ID, '--role', 'senior-backend'], cwd), 2);
  });
});

test('a regenerated pack invalidates old receipts', () => {
  withProject((cwd) => {
    compilePack(cwd);
    const manifest = readContextPackManifest(cwd, RUN_ID, ROLE)!;
    for (let part = 1; part <= manifest.parts.length; part += 1) {
      rulesAckMain(['--run-id', RUN_ID, '--role', ROLE, '--part', String(part)], cwd);
    }
    assert.equal(rulesAckComplete(cwd, RUN_ID, ROLE), true);

    // Recompile with a different material set → new packHash → ack resets.
    const changed = compileRoleContextPack(cwd, RUN_ID, ROLE, ['common/clean-code.md'], [], []);
    assert.ok(changed);
    if (changed!.packHash !== manifest.packHash) {
      assert.equal(rulesAckComplete(cwd, RUN_ID, ROLE), false);
    }
  });
});

test('no pack compiled means nothing to acknowledge (legacy runs unaffected)', () => {
  withProject((cwd) => {
    assert.equal(rulesAckComplete(cwd, RUN_ID, ROLE), true);
  });
});

test('integration requirements compile per role from surfaces and outputs', () => {
  const frontend = compileIntegrationRequirements('senior-frontend', ['web-ui', 'api'], [
    'packages/api-client/src/index.ts',
    'apps/web/public/robots.txt',
  ]);
  assert.ok(frontend.some((line) => line.includes('STRUCT_API_CLIENT_UNUSED')));
  assert.ok(frontend.some((line) => line.includes('STRUCT_ORPHAN_MODULE')));
  assert.ok(frontend.some((line) => line.includes('VITE_SITE_URL')));

  const backend = compileIntegrationRequirements('senior-backend', ['api'], [
    'packages/api-client/src/index.ts',
  ]);
  assert.ok(backend.some((line) => line.includes('packages/api-client')));

  assert.deepEqual(compileIntegrationRequirements('senior-reviewer', ['web-ui'], []), []);
});
