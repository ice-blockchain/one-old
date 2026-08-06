import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UNCERTIFIED_HOST_OPT_OUT_ENV,
  hostLabel,
  isUncertifiedHost,
  uncertifiedHostInstallRefusal,
  uncertifiedHostOptOutSet,
  uncertifiedHostSessionBanner,
} from '../tiers';
import { HOST_CAPABILITIES } from '../capability-schema';

// Deliberately a LITERAL expectation, not a loop over HOST_CAPABILITIES. The
// loop this replaced asserted `isUncertifiedHost(host) === (contract.tier ===
// 'uncertified')` — the implementation restated against the same data, which
// passes just as happily if every host's tier is flipped. The product decision
// is "which hosts carry the guarantee", so that is what gets pinned.
const CERTIFIED = ['claude', 'codex', 'cursor'];
const UNCERTIFIED = ['copilot', 'kilo', 'opencode', 'windsurf'];

test('the certified/uncertified split is the exact product decision, not whatever the table says', () => {
  for (const host of CERTIFIED) assert.equal(isUncertifiedHost(host), false, host);
  for (const host of UNCERTIFIED) assert.equal(isUncertifiedHost(host), true, host);
  // No host may be missing from the split: a newly added host must be classified
  // here (and get a label) rather than inheriting a tier by accident.
  assert.deepEqual(
    Object.keys(HOST_CAPABILITIES).sort(),
    [...CERTIFIED, ...UNCERTIFIED].sort(),
  );
});

test('an unknown host is uncertified — no free pass through either surface', () => {
  // Fail CLOSED. A typo in TRAFFIC_ONE_HOST, or a host wired into the adapters
  // without a row in HOST_CAPABILITIES, is the strongest case of "no evidence
  // this host enforces anything", so it must not read as certified.
  assert.equal(isUncertifiedHost('not-a-real-host'), true);
  assert.equal(isUncertifiedHost('copliot'), true);
  assert.notEqual(uncertifiedHostInstallRefusal('not-a-real-host', {}), null);
  assert.notEqual(uncertifiedHostSessionBanner('not-a-real-host'), null);
});

test('uncertifiedHostOptOutSet requires the exact value "1"', () => {
  assert.equal(uncertifiedHostOptOutSet({}), false);
  assert.equal(uncertifiedHostOptOutSet({ [UNCERTIFIED_HOST_OPT_OUT_ENV]: 'true' }), false);
  assert.equal(uncertifiedHostOptOutSet({ [UNCERTIFIED_HOST_OPT_OUT_ENV]: '1' }), true);
});

test('uncertifiedHostInstallRefusal refuses a certified host never, an uncertified host by default', () => {
  for (const host of CERTIFIED) {
    assert.equal(uncertifiedHostInstallRefusal(host, {}), null, host);
  }
  for (const host of UNCERTIFIED) {
    const refusal = uncertifiedHostInstallRefusal(host, {});
    assert.notEqual(refusal, null, host);
    assert.match(refusal!, /is not a certified host/);
    assert.match(refusal!, new RegExp(`${UNCERTIFIED_HOST_OPT_OUT_ENV}=1`));
  }
});

test('uncertifiedHostInstallRefusal proceeds once the named opt-out is set', () => {
  assert.equal(
    uncertifiedHostInstallRefusal('opencode', { [UNCERTIFIED_HOST_OPT_OUT_ENV]: '1' }),
    null,
  );
});

test('the SessionStart banner fires only for an uncertified host, and names it', () => {
  for (const host of CERTIFIED) {
    assert.equal(uncertifiedHostSessionBanner(host), null, host);
  }
  assert.match(uncertifiedHostSessionBanner('windsurf')!, /^traffic-one \[Windsurf is not a certified host\]$/m);
  assert.match(uncertifiedHostSessionBanner('copilot')!, /^traffic-one \[Copilot is not a certified host\]$/m);
});

// The banner is the ONE user-facing string in this module a user did not ask
// for, so it gets the strictest wording constraints. Each assertion below is a
// bug this text has actually had.
test('the banner never leaks an internal identifier a user cannot act on', () => {
  // It used to print `enforcementPoints` verbatim ("enforcement points:
  // pre_write_code, pre_run_command, …"). Derived from the record, so a hook
  // point renamed or added tomorrow is covered without touching this test.
  // Filtered to identifier-SHAPED points (`_`, `.`, `-`, or an inner capital):
  // kilo's point list contains the bare word `event`, which is a substring of
  // ordinary English ("prevent"), and a test that fails on English prose is a
  // trap for the next person to edit this banner rather than a guard.
  const identifiers = new Set(
    Object.values(HOST_CAPABILITIES)
      .flatMap((contract) => [...contract.enforcementPoints, contract.primaryBlockingPoint])
      .filter((point) => /[._-]/.test(point) || /.[A-Z]/.test(point)),
  );
  for (const host of UNCERTIFIED) {
    const banner = uncertifiedHostSessionBanner(host)!;
    for (const identifier of identifiers) {
      assert.ok(
        !banner.includes(identifier),
        `${host} banner leaks the internal hook identifier "${identifier}"`,
      );
    }
    assert.doesNotMatch(banner, /\bdeny\b|\bdenied\b/i, host);
    assert.doesNotMatch(banner, /PreToolUse|SubagentStart|tool\.execute|hook/i, host);
  }
});

test('the banner claims nothing about what the user agreed to', () => {
  // It used to say "Running here already accepted that risk — either via
  // TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST=1, or because <host> has no install step
  // Traffic One can gate." False on the second branch: Copilot installs through
  // `copilot plugin install`, so a Copilot user is never asked anything and
  // accepted nothing. And the env var is inert at SessionStart — quoting it
  // there invites the reader to "fix" a state that changes nothing.
  for (const host of UNCERTIFIED) {
    const banner = uncertifiedHostSessionBanner(host)!;
    assert.doesNotMatch(banner, /accept|agree|consent|opt(ed)?[ -]in|risk/i, host);
    assert.ok(!banner.includes(UNCERTIFIED_HOST_OPT_OUT_ENV), host);
  }
});

test('the banner says it blocks nothing, and points at the hosts that do carry the guarantee', () => {
  for (const host of UNCERTIFIED) {
    const banner = uncertifiedHostSessionBanner(host)!;
    assert.match(banner, /blocks nothing/, host);
    // The banner builds this list from HOST_CAPABILITIES.tier + the host labels,
    // so promoting a host to certified updates the prose. Pinned to the exact
    // rendered form, so a broken join ("Claude Code, Codex, and") fails here.
    assert.ok(banner.includes('Claude Code, Codex and Cursor'), host);
    // …and says plainly that THIS host is not one of them, so the sentence can
    // never read as if the running host were covered.
    assert.ok(banner.includes(`${hostLabel(host)} is not in that set`), host);
  }
});
