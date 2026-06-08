import { test } from 'node:test';
import assert from 'node:assert/strict';

import { proposeLayoutSeed } from '../stack-layout';
import { scopesOverlap } from '../scope';

test('proposeLayoutSeed returns idiomatic seeds for known stacks', () => {
  const next = proposeLayoutSeed({ frontend: 'nextjs', backend: 'supabase' });
  assert.ok(next.frontend.includes('src/app/'));
  assert.ok(next.backend.includes('supabase/migrations/'));

  const laravel = proposeLayoutSeed({ frontend: 'vue', backend: 'laravel' });
  assert.ok(laravel.frontend.includes('src/'));
  assert.ok(laravel.backend.includes('app/Http/'));
  assert.ok(laravel.backend.includes('routes/'));
});

test('proposeLayoutSeed returns [] for unknown / unset ids (architect supplies real paths)', () => {
  const seed = proposeLayoutSeed({ frontend: 'other', backend: 'other' });
  assert.deepEqual(seed, { frontend: [], backend: [], mobile: [] });
  assert.deepEqual(proposeLayoutSeed({}), { frontend: [], backend: [], mobile: [] });
});

test('proposeLayoutSeed reads mobile framework off the nested mobile object', () => {
  const seed = proposeLayoutSeed({ frontend: 'react-vite', backend: 'node', mobile: { framework: 'react-native-expo' } });
  assert.ok(seed.mobile.includes('src/screens/'));
});

test('default stack (react-vite + supabase) seeds are prefix-disjoint front vs back', () => {
  const seed = proposeLayoutSeed({ frontend: 'react-vite', backend: 'supabase' });
  const probes = ['src/main.tsx', 'src/App.tsx', 'public/favicon.ico', 'supabase/migrations/0001.sql', 'supabase/functions/hello/index.ts'];
  assert.equal(
    scopesOverlap({ include: seed.frontend }, { include: seed.backend }, probes),
    false,
  );
});
