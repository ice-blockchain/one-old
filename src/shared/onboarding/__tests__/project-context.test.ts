import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_CONTEXT_ANSWER_KEYS,
  projectContextDomainQuestionLines,
  projectContextOriginalPrompt,
} from '../project-context';

test('PROJECT_CONTEXT_ANSWER_KEYS lists the canonical 14 answer keys', () => {
  assert.equal(PROJECT_CONTEXT_ANSWER_KEYS.length, 14);
  assert.ok(PROJECT_CONTEXT_ANSWER_KEYS.includes('audience'));
  assert.ok(PROJECT_CONTEXT_ANSWER_KEYS.includes('domainSpecific'));
});

test('projectContextOriginalPrompt prefers projectContext.originalPrompt, then aliases', () => {
  assert.equal(projectContextOriginalPrompt({ projectContext: { originalPrompt: 'build an LMS' } }), 'build an LMS');
  assert.equal(projectContextOriginalPrompt({ initialPrompt: '  a shop  ' }), 'a shop');
  assert.equal(projectContextOriginalPrompt({ prompt: 'x' }), 'x');
  assert.equal(projectContextOriginalPrompt({}), '');
  assert.equal(projectContextOriginalPrompt(null), '');
});

test('projectContextDomainQuestionLines selects domain questions by keyword', () => {
  assert.ok(projectContextDomainQuestionLines('an online course academy')[0]!.startsWith('Learning platform'));
  assert.ok(projectContextDomainQuestionLines('a freelancer marketplace with payouts').some((l) => l.startsWith('Marketplace')));
  // ecommerce keywords also trip the payment line
  const shop = projectContextDomainQuestionLines('a store with cart and checkout');
  assert.ok(shop.some((l) => l.startsWith('Ecommerce')));
  assert.ok(shop.some((l) => l.startsWith('Payment integration')));
});

test('projectContextDomainQuestionLines always returns a generic fallback when nothing matches', () => {
  const lines = projectContextDomainQuestionLines('a thing');
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.startsWith('Domain specifics'));
  // empty prompt → still one generic line
  assert.equal(projectContextDomainQuestionLines('').length, 1);
});
