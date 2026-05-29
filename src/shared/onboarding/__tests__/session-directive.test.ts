import { test } from 'node:test';
import assert from 'node:assert/strict';

import { onboardingDirectiveNewProject } from '../session-directive';
import type { OnboardingBlock } from '../fallbacks';
import { makeSkillBlock } from '../../skill-block';
import { pluginRoot } from '../../paths';

const skillBlock = makeSkillBlock(pluginRoot);
const skill: OnboardingBlock = (name, vars) => skillBlock('onboarding-gate', name, vars);

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
  // remaining procedure/scaffold now point at the single-source rules
  assert.ok(out.includes('rules/common/onboarding.md'));
  assert.ok(out.includes('rules/modes/new-project.md'));
  // no unresolved template vars
  assert.ok(!out.includes('{{'));
});
