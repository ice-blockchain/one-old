import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isUninstallTrafficOneIntent, uninstallCommand, uninstallDirective } from '../uninstall-intent';

// The detector arms an irreversible machine-wide cleanup, so the negative cases
// matter more than the positive ones: talk ABOUT uninstalling must never match.
const REQUESTS = [
  'uninstall traffic one',
  'uninstall traffic-one',
  'uninstall traffic_one',
  'Uninstall Traffic One.',
  'please uninstall the traffic one plugin',
  'can you uninstall traffic one?',
  'could you please remove traffic one for me',
  'i want to uninstall traffic one',
  'we need to remove the traffic-one plugin',
  "let's uninstall traffic one completely",
  'remove the traffic-one plugin from my machine',
  'delete traffic one plugin',
  'get rid of traffic one',
  'uninstall traffic one from cursor',
  'uninstall plugin traffic one',
  // Romanian, with and without diacritics.
  'dezinstaleaza traffic one',
  'dezinstalează traffic one',
  'vreau sa dezinstalez traffic one',
  'vreau să dezinstalez pluginul traffic one',
  'șterge pluginul traffic one',
  'te rog dezinstalează traffic one complet',
  'scoate traffic one de pe calculator',
];

const NOT_REQUESTS = [
  '',
  'hi',
  'how do i uninstall traffic one?',
  'how can i uninstall traffic one',
  'why did uninstalling traffic one fail',
  'what does uninstalling traffic one remove?',
  'should i uninstall traffic one?',
  'is uninstalling traffic one safe',
  "don't uninstall traffic one",
  'do not uninstall traffic one',
  'never uninstall traffic one',
  'cum dezinstalez traffic one',
  'nu dezinstala traffic one',
  // Adjacent work that merely mentions the words.
  'uninstall traffic one and then reinstall it',
  'uninstall traffic one after the build finishes',
  'document how uninstall traffic one works',
  // A different target.
  'uninstall the react plugin',
  'uninstall node',
  'remove the traffic one banner from the header',
  // Plain talk about the plugin.
  'traffic one is great',
  'disable traffic one for this project',
];

test('isUninstallTrafficOneIntent matches explicit uninstall requests', () => {
  for (const prompt of REQUESTS) {
    assert.equal(isUninstallTrafficOneIntent(prompt), true, `expected a match: ${prompt}`);
  }
});

test('isUninstallTrafficOneIntent ignores questions, negations, and other targets', () => {
  for (const prompt of NOT_REQUESTS) {
    assert.equal(isUninstallTrafficOneIntent(prompt), false, `expected no match: ${prompt}`);
  }
});

test('isUninstallTrafficOneIntent ignores non-string input and long prompts', () => {
  assert.equal(isUninstallTrafficOneIntent(undefined), false);
  assert.equal(isUninstallTrafficOneIntent(null), false);
  assert.equal(isUninstallTrafficOneIntent({}), false);
  // A long prompt that merely contains the phrase is prose, not a command.
  assert.equal(isUninstallTrafficOneIntent(`${'context '.repeat(30)}uninstall traffic one`), false);
});

test('uninstallDirective prescribes confirmation, the apply command, and the restart', () => {
  const directive = uninstallDirective('claude');
  assert.match(directive, /ONE explicit confirmation/);
  assert.ok(directive.includes(uninstallCommand(true)), 'directive carries the apply command');
  assert.ok(directive.includes(uninstallCommand(false)), 'directive carries the preview command');
  assert.match(directive, /RESTART Claude Code/);
  assert.match(directive, /Onboarded project content stays/);
  assert.match(directive, /Generated host Task\/subagent files/);
  assert.match(directive, /\.opencode\/agents/);
  assert.match(directive, /Cursor/);
});

test('uninstallCommand is a single quoted node invocation', () => {
  assert.match(uninstallCommand(true), /^node '.*\/scripts\/traffic-one-uninstall\.cjs' --yes$/);
  assert.match(uninstallCommand(false), /^node '.*\/scripts\/traffic-one-uninstall\.cjs' --dry-run$/);
});
