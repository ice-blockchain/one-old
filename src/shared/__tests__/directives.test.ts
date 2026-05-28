import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autoDetectedAnnouncement, postWriteIncompleteWarning } from '../directives';

test('autoDetectedAnnouncement shows detected fields + the supabase note', () => {
  const out = autoDetectedAnnouncement({ stack: 'default', frontend: 'react-vite', backend: 'supabase', realtime: 'none', evidence: ['react in deps'] });
  assert.ok(out.includes('stack auto-detected'));
  assert.ok(out.includes('stack=default'));
  assert.ok(out.includes('react in deps'));
  assert.ok(out.includes('Supabase detected'));
});

test('autoDetectedAnnouncement adds the Next.js note for nextjs frontends', () => {
  const out = autoDetectedAnnouncement({ stack: 'custom-frontend', frontend: 'nextjs', backend: 'none', realtime: 'none', evidence: ['next in deps'] });
  assert.ok(out.includes('Next.js detected'));
  assert.ok(!out.includes('Supabase detected'));
});

test('postWriteIncompleteWarning flags a missing stack + missing codeGraphProvider', () => {
  const out = postWriteIncompleteWarning({ stack: null, validStackIds: ['minimal', 'default'] });
  assert.ok(out.includes('write incomplete'));
  assert.ok(out.includes('without a `stack` field'));
  assert.ok(out.includes('did not set local `codeGraphProvider`'));
});

test('postWriteIncompleteWarning stays quiet when stack + provider are valid', () => {
  const out = postWriteIncompleteWarning({
    stack: 'default', validStackIds: ['minimal', 'default'],
    codeGraphProvider: 'gitnexus', validCodeGraphProviders: ['gitnexus', 'graphify'],
  });
  assert.ok(!out.includes('without a `stack` field'));
  assert.ok(!out.includes('did not set local `codeGraphProvider`'));
});
