// Integration requirements — the per-role "definition of done" stored on the
// bootstrap envelope and rendered into the child SessionStart header (the
// readable delivery surface since the per-run context-pack snapshot was
// removed; the deterministic STRUCT_* gates verify these regardless).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileIntegrationRequirements } from '../run-bootstrap-policy';

test('integration requirements compile per role from surfaces and outputs', () => {
  const frontend = compileIntegrationRequirements('senior-frontend', ['web-ui', 'api'], [
    'packages/api-client/src/index.ts',
    'apps/web/public/robots.txt',
  ]);
  assert.ok(frontend.some((line) => line.includes('STRUCT_API_CLIENT_UNUSED')));
  assert.ok(frontend.some((line) => line.includes('STRUCT_ORPHAN_MODULE')));
  assert.ok(frontend.some((line) => line.includes('STRUCT_TAILWIND_NO_TOOLCHAIN')));
  assert.ok(frontend.some((line) => line.includes('<Trans>')));
  assert.ok(frontend.some((line) => line.includes('VITE_SITE_URL')));
  assert.ok(frontend.some((line) => line.includes('default-export')));
  assert.ok(frontend.some((line) => line.includes('no-any')));
  assert.ok(frontend.some((line) => line.includes('web-inline-style')));
  assert.ok(frontend.some((line) => line.includes('pages-service-files')));
  assert.ok(frontend.some((line) => line.includes('websocket-location')));
  assert.ok(frontend.some((line) => line.includes('asset-extension-mismatch')));

  const backend = compileIntegrationRequirements('senior-backend', ['api'], [
    'packages/api-client/src/index.ts',
  ]);
  assert.ok(backend.some((line) => line.includes('packages/api-client')));
  assert.ok(backend.some((line) => line.includes('no-any')));
  assert.ok(backend.some((line) => line.includes('websocket-location')));
  assert.ok(!backend.some((line) => line.includes('asset-extension-mismatch')));

  assert.deepEqual(compileIntegrationRequirements('senior-reviewer', ['web-ui'], []), []);
});
