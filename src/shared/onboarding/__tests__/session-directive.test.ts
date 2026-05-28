import { test } from 'node:test';
import assert from 'node:assert/strict';

import { onboardingDirectiveNewProject } from '../session-directive';
import type { OnboardingBlock } from '../fallbacks';
import { makeSkillBlock } from '../../skill-block';
import { pluginRoot } from '../../paths';

const skillBlock = makeSkillBlock(pluginRoot);
const skill: OnboardingBlock = (name, vars, fallback) => skillBlock('onboarding-gate', name, vars, fallback);
const verbatim: OnboardingBlock = (_name, _vars, fallback) => fallback;

test('onboardingDirectiveNewProject (skill) is the full first-run directive with embedded popups', () => {
  const out = onboardingDirectiveNewProject(skill);
  assert.ok(out.includes('FIRST-RUN ONBOARDING (new project)'));
  // embedded composition blocks resolved (no leftover placeholders)
  assert.ok(out.includes('OPENCODE DELEGATION PREFLIGHT'));
  assert.ok(out.includes('AGENT PERFORMANCE PREFLIGHT'));
  assert.ok(out.includes('TEAM CONFIRMATION PREFLIGHT'));
  assert.ok(out.includes('CURRENT-THREAD ONBOARDING FALLBACK')); // codex fallback
  assert.ok(out.includes('request_user_input')); // host popup instruction
  // pitch labels filled
  assert.ok(out.includes('Supabase')); // backend label
  // later sections present
  assert.ok(out.includes('MOBILE DECISION PREFLIGHT'));
  assert.ok(out.includes('CODEBASE GRAPH PROVIDER PREFLIGHT'));
  assert.ok(out.includes('SCAFFOLD THE PROJECT STRUCTURE'));
  // no unresolved template vars
  assert.ok(!out.includes('{{'));
});

test('onboardingDirectiveNewProject (verbatim fallback) still composes the popups', () => {
  const out = onboardingDirectiveNewProject(verbatim);
  assert.ok(out.includes('FIRST-RUN ONBOARDING (new project)'));
  assert.ok(out.includes('OPENCODE DELEGATION PREFLIGHT'));
  assert.ok(out.includes('AGENT PERFORMANCE PREFLIGHT'));
  assert.ok(out.includes('TEAM CONFIRMATION PREFLIGHT'));
  assert.ok(!out.includes('{{'));
});
