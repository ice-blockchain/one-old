import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOST_CAPABILITY_FLAGS,
  type HostCapabilityFlags,
  hostFlags,
} from '../capability-flags';
import { HOST_CAPABILITIES, type TrafficOneHost } from '../capability-schema';

// The exact host set for every flag. This is the migration's safety net: each
// flag replaced a literal host-name comparison at one or two call sites, so a
// wrong host in the row below is a silently changed gate — the exact failure
// mode that makes migrating these branches blind dangerous.
const EXPECTED: Readonly<Record<keyof HostCapabilityFlags, readonly TrafficOneHost[]>> = {
  opencodeSelfHosted: ['opencode', 'kilo'],
  modelChoiceNeedsUserReply: ['cursor'],
  availableModelsMustBeCaptured: ['cursor'],
  sandboxNeedsEscalation: ['codex'],
  denyEndsTheTurn: ['windsurf'],
  noTaskCompletionLifecycle: ['kilo'],
  nativeWritesCarryNoAgentIdentity: ['windsurf'],
  ignoresMaterializedGuidance: ['windsurf'],
  nativeBootstrapEnforcementPoint: ['claude'],
};

const ALL_HOSTS = Object.keys(HOST_CAPABILITY_FLAGS) as TrafficOneHost[];
const FLAG_NAMES = Object.keys(EXPECTED) as Array<keyof HostCapabilityFlags>;

test('every host has a row, and every flag has a declared expectation', () => {
  assert.deepEqual(ALL_HOSTS.sort(), (Object.keys(HOST_CAPABILITIES) as TrafficOneHost[]).sort());
  for (const host of ALL_HOSTS) {
    assert.deepEqual(
      Object.keys(HOST_CAPABILITY_FLAGS[host]).sort(),
      [...FLAG_NAMES].sort(),
      `${host} row does not carry exactly the declared flags`,
    );
  }
});

test('each flag is true for exactly the hosts that have that quirk', () => {
  for (const flag of FLAG_NAMES) {
    const actual = ALL_HOSTS.filter((host) => HOST_CAPABILITY_FLAGS[host][flag]).sort();
    assert.deepEqual(actual, [...EXPECTED[flag]].sort(), flag);
  }
});

test('no flag is phrased as something most hosts have', () => {
  // The naming rule, as a test. A flag that is true for a majority of hosts is
  // norm-shaped, and a norm-shaped flag CHANGES behaviour for an unrecognized
  // host the moment it replaces a host-name comparison (hostFlags answers false
  // there, so `!flag` flips). Rejecting the shape is cheaper than auditing the
  // call sites again later.
  for (const flag of FLAG_NAMES) {
    const count = ALL_HOSTS.filter((host) => HOST_CAPABILITY_FLAGS[host][flag]).length;
    assert.ok(count > 0, `${flag} is true for no host — delete it or fix the row`);
    assert.ok(
      count * 2 < ALL_HOSTS.length,
      `${flag} is true for ${count}/${ALL_HOSTS.length} hosts: name the quirk, not the norm`,
    );
  }
});

test('an unknown, empty, or missing host has no quirks — the behaviour-neutrality rule', () => {
  // Every migrated call site used to compare a host name, which is false for a
  // string that names no host. hostFlags must answer the same way, or a typo in
  // TRAFFIC_ONE_HOST silently takes a different branch than it did before.
  for (const value of ['not-a-real-host', 'copliot', '', undefined, null]) {
    assert.deepEqual(
      hostFlags(value),
      Object.fromEntries(FLAG_NAMES.map((flag) => [flag, false])),
      `hostFlags(${JSON.stringify(value)})`,
    );
  }
  // …and a known host still answers from its row (not a frozen copy of it).
  for (const host of ALL_HOSTS) {
    assert.deepEqual(hostFlags(host), HOST_CAPABILITY_FLAGS[host], host);
  }
});

test('nativeBootstrapEnforcementPoint agrees with the published enforcement contract', () => {
  // The one flag that duplicates a fact the run's enforcement contract already
  // states. Kept as an explicit flag (deriving it would change behaviour the day
  // another host adds the point), so it needs this guard against the two drifting.
  for (const host of ALL_HOSTS) {
    assert.equal(
      HOST_CAPABILITY_FLAGS[host].nativeBootstrapEnforcementPoint,
      HOST_CAPABILITIES[host].enforcementPoints.includes('native-bootstrap'),
      `${host}: flag and HOST_CAPABILITIES.enforcementPoints disagree about native-bootstrap`,
    );
  }
});
