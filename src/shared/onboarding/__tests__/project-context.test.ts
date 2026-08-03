import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROJECT_CONTEXT_ANSWER_KEYS } from '../../../config/onboarding';
import {
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

test('projectContextDomainQuestionLines: a bare `listing` is not marketplace vocabulary', () => {
  // The agency brief ("one landing page with projects listing, latest news,
  // reviews") used to be asked about commissions, payouts, and disputes.
  const agency = projectContextDomainQuestionLines(
    'create modern an agency presentation website. one landing page with projects listing, latest news, reviews.',
  );
  assert.ok(!agency.some((l) => l.startsWith('Marketplace')), agency.join(' | '));
  assert.ok(!agency.some((l) => l.startsWith('Payment integration')), agency.join(' | '));

  // `job`/`jobs` still triggers on its own — a job board is a two-sided market.
  assert.ok(projectContextDomainQuestionLines('a job board').some((l) => l.startsWith('Marketplace')));
  assert.ok(projectContextDomainQuestionLines('a site for jobs').some((l) => l.startsWith('Marketplace')));

  // `listings` qualifies alongside the market act.
  assert.ok(projectContextDomainQuestionLines('an apartment listings site where owners post rentals')
    .some((l) => l.startsWith('Marketplace')));
});

test('projectContextDomainQuestionLines always returns a generic fallback when nothing matches', () => {
  const lines = projectContextDomainQuestionLines('a thing');
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.startsWith('Domain specifics'));
  // empty prompt → still one generic line
  assert.equal(projectContextDomainQuestionLines('').length, 1);
});
