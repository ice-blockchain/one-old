import { test } from 'node:test';
import assert from 'node:assert/strict';

import { acceptableModelsFor, canonicalHost, canonicalPlan, canonicalTier, modelMatchesAny, modelMatchesExpected, planIsRecognized, recommendTierForPlan, resolveModel, tierModelTable } from '../model-tiers';
import { OPENCODE_FREE_MODELS } from '../../config/opencode-delegation';

test('canonicalTier maps ids + aliases and rejects unknown/non-strings', () => {
  assert.equal(canonicalTier('highest'), 'highest');
  assert.equal(canonicalTier('high'), 'highest');
  assert.equal(canonicalTier('HIGH'), 'highest');
  assert.equal(canonicalTier('balance'), 'balanced');
  assert.equal(canonicalTier('cheap'), 'cheapest');
  assert.equal(canonicalTier('nope'), null);
  assert.equal(canonicalTier(5), null);
});

test('resolveModel resolves per host', () => {
  assert.equal(resolveModel('highest', 'claude'), 'opus');
  assert.equal(resolveModel('balanced', 'codex'), 'gpt-5.4');
  // Cursor anchors to bare model FAMILIES (not Anthropic aliases, not full reasoning-variant
  // slugs) — the build's concrete slug is matched family-aware / captured separately.
  assert.equal(resolveModel('highest', 'cursor'), 'claude-opus-4-8');
  assert.equal(resolveModel('balanced', 'cursor'), 'claude-4.6-sonnet');
  assert.equal(resolveModel('cheapest', 'cursor'), 'composer-2.5');
  assert.equal(resolveModel('highest', 'opencode'), OPENCODE_FREE_MODELS[0]);
  assert.equal(resolveModel('balanced', 'opencode'), OPENCODE_FREE_MODELS[1]);
  assert.equal(resolveModel('cheapest', 'opencode'), OPENCODE_FREE_MODELS[2]);
  assert.equal(resolveModel('highest', 'windsurf'), 'Claude Opus 4.8 Medium');
  assert.equal(resolveModel('balanced', 'windsurf'), 'Claude Sonnet 5 Medium');
  assert.equal(resolveModel('cheapest', 'windsurf'), 'SWE-1.6 Slow');
  assert.equal(resolveModel('bad', 'claude'), null);
});

test('resolveModel: Cursor Free overlay maps the frontier tiers to Composer; paid plans share the frontier family', () => {
  // Free/Hobby cannot pick the frontier models → highest/balanced resolve to the Composer family.
  assert.equal(resolveModel('highest', 'cursor', 'free'), 'composer-2.5');
  assert.equal(resolveModel('balanced', 'cursor', 'free'), 'composer-2.5');
  assert.equal(resolveModel('cheapest', 'cursor', 'free'), 'composer-2.5');
  // Paid plans (Pro / Pro+→plus / Ultra→max / Teams→business / Enterprise) all share the
  // base frontier family — model availability differs by budget, not by which models you can pick.
  for (const plan of ['pro', 'plus', 'max', 'business', 'team', 'enterprise']) {
    assert.equal(resolveModel('highest', 'cursor', plan), 'claude-opus-4-8', `highest unchanged for ${plan}`);
    assert.equal(resolveModel('balanced', 'cursor', plan), 'claude-4.6-sonnet', `balanced unchanged for ${plan}`);
  }
  // No plan supplied → generous base family (NOT the Free overlay), so plan-agnostic callers
  // are never silently downgraded.
  assert.equal(resolveModel('highest', 'cursor'), 'claude-opus-4-8');
  assert.equal(resolveModel('highest', 'cursor', undefined), 'claude-opus-4-8');
  assert.equal(resolveModel('highest', 'cursor', ''), 'claude-opus-4-8');
  // claude/codex ignore the plan arg entirely.
  assert.equal(resolveModel('highest', 'claude', 'free'), 'opus');
  assert.equal(resolveModel('highest', 'codex', 'free'), 'gpt-5.5');
});

test('Cursor family anchor accepts any plan/build reasoning variant (the core fix)', () => {
  // A higher-plan build offers different reasoning suffixes than a lower plan; the family
  // anchor accepts them all so the gate never rejects a same-family variant.
  const highest = resolveModel('highest', 'cursor', 'max') as string; // 'claude-opus-4-8'
  for (const slug of ['claude-opus-4-8-thinking-max-fast', 'claude-opus-4-8-thinking-high', 'claude-opus-4-8']) {
    assert.equal(modelMatchesExpected(slug, highest), true, `${slug} satisfies highest`);
  }
  // The balanced alternate family (gpt-5.5) accepts the build's '-extra-high' variant.
  const balancedSet = acceptableModelsFor(resolveModel('balanced', 'cursor', 'pro'), 'cursor');
  assert.equal(modelMatchesAny('gpt-5.5-extra-high', balancedSet), true);
  // A different family still does not satisfy highest (tier enforcement holds).
  assert.equal(modelMatchesExpected('gpt-5.5-extra-high', highest), false);
});

test('tierModelTable: Cursor cell is plan-aware (Free → Composer family), other hosts plan-agnostic', () => {
  const free = tierModelTable('highest', 'free');
  assert.deepEqual(free, { tier: 'highest', claude: 'opus', codex: 'gpt-5.5', cursor: 'composer-2.5', opencode: OPENCODE_FREE_MODELS[0], copilot: 'gpt-5.4-mini', windsurf: 'SWE-1.6 Slow' });
  const paid = tierModelTable('highest', 'max');
  assert.equal(paid?.cursor, 'claude-opus-4-8');
  assert.equal(paid?.windsurf, 'Claude Opus 4.8 Medium');
  // No plan → base cursor family.
  assert.equal(tierModelTable('highest')?.cursor, 'claude-opus-4-8');
});

test('resolveModel: Windsurf Free overlay maps every tier to the selectable SWE model', () => {
  assert.equal(resolveModel('highest', 'windsurf', 'free'), 'SWE-1.6 Slow');
  assert.equal(resolveModel('balanced', 'windsurf', 'free'), 'SWE-1.6 Slow');
  assert.equal(resolveModel('cheapest', 'windsurf', 'free'), 'SWE-1.6 Slow');
  assert.equal(resolveModel('highest', 'windsurf', 'pro'), 'Claude Opus 4.8 Medium');
  assert.equal(resolveModel('balanced', 'windsurf', 'pro'), 'Claude Sonnet 5 Medium');
});

test('canonicalPlan: Cursor recognizes its 2026 tiers (ultra→max, pro+→plus, teams→team)', () => {
  assert.equal(canonicalPlan('cursor', 'ultra'), 'max');
  assert.equal(canonicalPlan('cursor', 'pro+'), 'plus');
  assert.equal(canonicalPlan('cursor', 'pro_plus'), 'plus');
  assert.equal(canonicalPlan('cursor', 'pro-plus'), 'plus');
  assert.equal(canonicalPlan('cursor', 'teams'), 'team');
  assert.equal(canonicalPlan('cursor', 'team'), 'team');
  assert.equal(canonicalPlan('cursor', 'enterprise'), 'enterprise');
  // A genuinely unknown membership string still collapses to the conservative default.
  assert.equal(canonicalPlan('cursor', 'galaxy'), 'free');
});

test('canonicalPlan: Copilot product labels resolve to paid plan ids', () => {
  assert.equal(canonicalPlan('copilot', 'Copilot Pro'), 'pro');
  assert.equal(canonicalPlan('copilot', 'GitHub Copilot Pro'), 'pro');
  assert.equal(canonicalPlan('copilot', 'Copilot Business'), 'business');
  assert.equal(canonicalPlan('copilot', 'GitHub Copilot Enterprise'), 'enterprise');
  assert.equal(recommendTierForPlan('copilot', 'Copilot Pro'), 'balanced');
  assert.equal(recommendTierForPlan('copilot', 'Copilot Pro', true), 'highest');
});

test('planIsRecognized: known ids/aliases true, unknown false', () => {
  assert.equal(planIsRecognized('ultra'), true);
  assert.equal(planIsRecognized('pro+'), true);
  assert.equal(planIsRecognized('Pro Plus'), true);
  assert.equal(planIsRecognized('Copilot Pro'), true);
  assert.equal(planIsRecognized('max'), true);
  assert.equal(planIsRecognized('galaxy'), false);
  assert.equal(planIsRecognized(''), false);
  assert.equal(planIsRecognized(42), false);
});

test('modelMatchesExpected accepts exact + same-family variants, rejects other families/empty', () => {
  // Exact match (Claude/Codex pass bare ids).
  assert.equal(modelMatchesExpected('gpt-5.5', 'gpt-5.5'), true);
  assert.equal(modelMatchesExpected('opus', 'opus'), true);
  // Cursor reasoning/speed variants of the same family.
  assert.equal(modelMatchesExpected('gpt-5.5-medium', 'gpt-5.5'), true);
  assert.equal(modelMatchesExpected('gpt-5.5-fast', 'gpt-5.5'), true);
  assert.equal(modelMatchesExpected('claude-4.6-sonnet-thinking', 'claude-4.6-sonnet'), true);
  assert.equal(modelMatchesExpected('composer-latest-fast', 'composer-latest'), true);
  // The agent's natural Opus spawn matches the Opus-family expected (the highest tier).
  assert.equal(modelMatchesExpected('claude-opus-4-8-thinking-max-fast', 'claude-opus-4-8'), true);
  // A DIFFERENT family never matches (tier enforcement holds).
  assert.equal(modelMatchesExpected('claude-opus-4-8-thinking-max-fast', 'gpt-5.5'), false);
  assert.equal(modelMatchesExpected('sonnet', 'opus'), false);
  // Empty/absent or non-string never matches (deny → inherit guard).
  assert.equal(modelMatchesExpected('', 'gpt-5.5'), false);
  assert.equal(modelMatchesExpected('gpt-5.5', ''), false);
  assert.equal(modelMatchesExpected(undefined, 'gpt-5.5'), false);
});

test('canonicalHost defaults to claude for unknowns', () => {
  assert.equal(canonicalHost('codex'), 'codex');
  assert.equal(canonicalHost('opencode'), 'opencode');
  assert.equal(canonicalHost('copilot'), 'copilot');
  assert.equal(canonicalHost('windsurf'), 'windsurf');
  assert.equal(canonicalHost('weird'), 'claude');
});

test('tierModelTable returns all host columns', () => {
  assert.deepEqual(tierModelTable('highest'), {
    tier: 'highest', claude: 'opus', codex: 'gpt-5.5', cursor: 'claude-opus-4-8', opencode: OPENCODE_FREE_MODELS[0], copilot: 'gpt-5.4', windsurf: 'Claude Opus 4.8 Medium',
  });
  assert.equal(tierModelTable('bad'), null);
});

test('opencode Go (plus) plan: paid opencode-go overlay + fallback chain; free inherits the free chain', () => {
  // free plan → base free chain (unchanged)
  assert.equal(resolveModel('highest', 'opencode', 'free'), OPENCODE_FREE_MODELS[0]);
  // Go (auth `opencode-go` → canonical `plus`) → the paid open-weight catalog
  assert.equal(canonicalPlan('opencode', 'go'), 'plus');
  assert.equal(resolveModel('highest', 'opencode', 'plus'), 'opencode-go/qwen3.7-max');
  assert.equal(resolveModel('balanced', 'opencode', 'plus'), 'opencode-go/glm-5.2');
  assert.equal(resolveModel('cheapest', 'opencode', 'plus'), 'opencode-go/deepseek-v4-flash');
  // Go recommends a real working tier, not cheapest
  assert.equal(recommendTierForPlan('opencode', 'plus'), 'balanced');
  // tierModelTable threads the plan through for opencode too
  assert.equal(tierModelTable('highest', 'plus')?.opencode, 'opencode-go/qwen3.7-max');
  // Fallback chain stays within Go, then degrades to the always-free chain — and never
  // offers pay-per-use `opencode/*` Zen frontier models (owner has Go, not Zen).
  const accept = acceptableModelsFor('opencode-go/qwen3.7-max', 'opencode');
  assert.equal(accept[0], 'opencode-go/qwen3.7-max');
  assert.ok(accept.includes('opencode-go/minimax-m3'));
  assert.ok(OPENCODE_FREE_MODELS.every((m) => accept.includes(m)), 'free chain is the ultimate fallback');
  assert.ok(!accept.some((m) => /^opencode\/(claude|gpt|gemini)/.test(m)), 'no Zen frontier models offered on Go');
});

test('canonicalPlan resolves ids/aliases per host and falls back to the host default', () => {
  assert.equal(canonicalPlan('claude', 'max'), 'max');
  assert.equal(canonicalPlan('claude', 'MAX'), 'max');
  assert.equal(canonicalPlan('claude', 'maximum'), 'max');
  assert.equal(canonicalPlan('claude', 'team'), 'team');
  assert.equal(canonicalPlan('codex', 'plus'), 'plus');
  assert.equal(canonicalPlan('codex', 'prolite'), 'plus'); // ChatGPT Go / Pro-Lite → Plus
  assert.equal(canonicalPlan('codex', 'Pro-Lite'), 'plus'); // separators + case normalized
  assert.equal(canonicalPlan('cursor', 'business'), 'business');
  assert.equal(canonicalPlan('opencode', 'free'), 'free');
  assert.equal(canonicalPlan('opencode', 'pro'), 'free');
  assert.equal(canonicalPlan('windsurf', 'pro'), 'pro');
  assert.equal(canonicalPlan('windsurf', 'max'), 'max');
  assert.equal(canonicalPlan('windsurf', 'teams'), 'team');
  assert.equal(canonicalPlan('windsurf', 'business'), 'free');
  // cross-host / unknown / non-string → host default
  assert.equal(canonicalPlan('claude', 'plus'), 'free'); // plus isn't a claude plan → claude default
  assert.equal(canonicalPlan('codex', 'max'), 'free'); // max isn't a codex plan → codex default
  assert.equal(canonicalPlan('cursor', 'nope'), 'free'); // unknown → cursor default
  assert.equal(canonicalPlan('claude', 5), 'free'); // non-string → default
});

test('acceptableModelsFor: Cursor folds in same-tier fallback FAMILIES; claude/codex stay exact', () => {
  // Cursor families per Cursor's own tier labels: balanced sonnet ↔ gpt-5.5 fallback.
  const balanced = acceptableModelsFor('claude-4.6-sonnet', 'cursor');
  assert.equal(balanced[0], 'claude-4.6-sonnet', 'preferred family stays first');
  assert.ok(balanced.includes('gpt-5.5'));
  // composer-2.5 is the LAST-RESORT fallback family on highest+balanced (survives API-budget
  // exhaustion — the only family in the included Composer bucket), ordered last.
  assert.equal(balanced[balanced.length - 1], 'composer-2.5', 'composer is the last-resort fallback');
  const highest = acceptableModelsFor('claude-opus-4-8', 'cursor');
  assert.ok(highest.includes('claude-opus-4-7'));
  assert.ok(highest.includes('claude-fable-5'));
  assert.equal(highest[highest.length - 1], 'composer-2.5', 'composer is the last-resort fallback');
  // cheapest has no configured fallback → just itself.
  assert.deepEqual(acceptableModelsFor('composer-2.5', 'cursor'), ['composer-2.5']);
  // claude/codex have no alternates → strict single-model enforcement preserved.
  assert.deepEqual(acceptableModelsFor('sonnet', 'claude'), ['sonnet']);
  assert.deepEqual(acceptableModelsFor('gpt-5.4', 'codex'), ['gpt-5.4']);
  // A model with no configured alternates → just itself, even on Cursor.
  assert.deepEqual(acceptableModelsFor('some-unknown-slug', 'cursor'), ['some-unknown-slug']);
  assert.deepEqual(acceptableModelsFor('', 'cursor'), []);
});

test('modelMatchesAny: the preferred family or any same-tier fallback variant satisfies the set', () => {
  const balanced = acceptableModelsFor('claude-4.6-sonnet', 'cursor');
  assert.equal(modelMatchesAny('claude-4.6-sonnet-medium-thinking', balanced), true); // preferred variant
  assert.equal(modelMatchesAny('gpt-5.5-extra-high', balanced), true); // same-tier fallback variant
  // A different-tier Cursor model (opus = highest) does NOT satisfy balanced.
  assert.equal(modelMatchesAny('claude-opus-4-8-thinking-max-fast', balanced), false);
});

test('recommendTierForPlan maps plan → tier, bumps one step with OpenCode, clamps at top', () => {
  assert.equal(recommendTierForPlan('claude', 'free'), 'cheapest');
  assert.equal(recommendTierForPlan('claude', 'free', true), 'balanced');
  assert.equal(recommendTierForPlan('claude', 'pro'), 'balanced');
  assert.equal(recommendTierForPlan('claude', 'pro', true), 'highest');
  assert.equal(recommendTierForPlan('claude', 'max'), 'highest');
  assert.equal(recommendTierForPlan('claude', 'max', true), 'highest'); // already top
  assert.equal(recommendTierForPlan('codex', 'plus'), 'balanced');
  assert.equal(recommendTierForPlan('codex', 'business', true), 'highest');
  // unknown plan → the host default plan's tier (codex default = free)
  assert.equal(recommendTierForPlan('codex', 'mystery'), 'cheapest');
  assert.equal(recommendTierForPlan('opencode', 'free'), 'cheapest');
  assert.equal(recommendTierForPlan('opencode', 'free', true), 'cheapest');
  assert.equal(recommendTierForPlan('windsurf', 'free'), 'cheapest');
  assert.equal(recommendTierForPlan('windsurf', 'max'), 'highest');
});
