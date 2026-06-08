import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalMobileSource,
  canonicalOpenCodeSource,
  canonicalTeamOverrides,
  canonicalizeStateShape,
  codeGraphProviderFromValue,
  resolvedTeamMode,
} from '../canonicalize';

test('canonicalizeStateShape migrates a compact stack object into flat fields', () => {
  const s: Record<string, unknown> = {
    stack: { id: 'default', frontend: 'react-vite', backend: 'supabase', codeGraph: 'gitnexus', team: { mode: 'subagents', source: 'prompted' } },
  };
  assert.equal(canonicalizeStateShape(s), true);
  assert.equal(s.stack, 'default');
  assert.equal(s.frontend, 'react-vite');
  assert.equal(s.backend, 'supabase');
  assert.equal(s.codeGraphProvider, 'gitnexus');
  assert.deepEqual(s.team, { mode: 'subagents', source: 'prompted' });
});

test('canonicalizeStateShape migrates projectMode → mode and deletes projectMode', () => {
  const s: Record<string, unknown> = { projectMode: 'new-project' };
  canonicalizeStateShape(s);
  assert.equal(s.mode, 'new-project');
  assert.equal('projectMode' in s, false);
});

test('canonicalizeStateShape coerces mobile/performance strings and codeGraph alias', () => {
  const s: Record<string, unknown> = { mobile: 'ionic', performance: 'high', codeGraph: 'graphify' };
  canonicalizeStateShape(s);
  assert.deepEqual(s.mobile, { enabled: true, framework: 'ionic-capacitor', source: 'prompted' });
  assert.deepEqual(s.performance, { level: 'high', source: 'prompted' });
  assert.equal(s.codeGraphProvider, 'graphify');
  assert.equal('codeGraph' in s, false);
});

test('canonicalTeamOverrides drops defaults + unknown roles, keeps real overrides', () => {
  assert.deepEqual(canonicalTeamOverrides({ 'senior-tester': 'highest' }, 'high'), { 'senior-tester': 'highest' });
  assert.equal(canonicalTeamOverrides({ 'senior-frontend': 'highest' }, 'high'), null); // equals the level default
  assert.equal(canonicalTeamOverrides({ 'bogus-role': 'highest' }, 'high'), null);
});

test('resolvedTeamMode reads state.team.mode, applies aliases, and defaults to main-agent', () => {
  assert.equal(resolvedTeamMode({ team: { mode: 'subagents' } }), 'subagents');
  assert.equal(resolvedTeamMode({ team: { mode: 'main-agent' } }), 'main-agent');
  assert.equal(resolvedTeamMode({ team: { mode: 'enabled' } }), 'subagents'); // alias → subagents
  assert.equal(resolvedTeamMode({ team: { mode: 'disabled' } }), 'main-agent'); // alias → main-agent
  assert.equal(resolvedTeamMode({}), 'main-agent'); // team absent
  assert.equal(resolvedTeamMode({ team: {} }), 'main-agent'); // mode absent
  assert.equal(resolvedTeamMode(null), 'main-agent');
});

test('vocab canonicalizers match legacy aliasing', () => {
  assert.equal(canonicalMobileSource('web-only'), 'none');
  assert.equal(canonicalOpenCodeSource('explicit'), 'explicit');
  assert.equal(canonicalOpenCodeSource('bogus'), 'prompted');
  assert.equal(codeGraphProviderFromValue({ provider: 'gitnexus' }), 'gitnexus');
});
