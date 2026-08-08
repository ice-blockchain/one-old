import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import { authEnforced, authSatisfied } from '../index';
import { AUTH_ENABLED } from '../../../config/auth';
import { isTrafficOneDoctorCommand } from '../../tool-classify';
import { gateExemptDoctorScriptPaths } from '../../doctor-command';

// The predicate's own grammar. Pinned because the OFF spellings are the ones a
// classification claim is made about (see the header comment on authEnforced):
// a fifth accepted spelling appearing here is a change to what a host
// environment can switch off, not a tidy-up.
test('authEnforced accepts exactly the documented on/off spellings', () => {
  for (const on of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) {
    assert.equal(authEnforced({ TRAFFIC_ONE_AUTH: on }), true, `${JSON.stringify(on)} pins enforcement on`);
  }
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' no ']) {
    assert.equal(authEnforced({ TRAFFIC_ONE_AUTH: off }), false, `${JSON.stringify(off)} opts out`);
  }
  // Anything else is not an opt-out. A typo must not silently disable auth, and
  // an empty value is what an unset-but-exported variable looks like.
  for (const other of ['', '  ', 'disabled', 'nope', '2', 'null', 'undefined']) {
    assert.equal(authEnforced({ TRAFFIC_ONE_AUTH: other }), AUTH_ENABLED,
      `${JSON.stringify(other)} falls through to the committed default`);
  }
  assert.equal(authEnforced({}), AUTH_ENABLED, 'absent falls through to the committed default');
});

// The direction claim in the header: `off` does not disable the handlers that
// consult authSatisfied() — it makes them ENTER. They stand down for an
// unauthenticated machine, so the opt-out turns that enforcement ON.
test('the opt-out satisfies auth rather than standing down authSatisfied consumers', () => {
  assert.equal(authSatisfied({ TRAFFIC_ONE_AUTH: 'off' }), true,
    'auth is satisfied without a key, so graphify/page-speed/post-stack-setup proceed');
  assert.equal(authSatisfied({ TRAFFIC_ONE_AUTH: '1', TRAFFIC_ONE_STATE_PATH: path.join(__dirname, 'no-such-state.json') }), false,
    'and with enforcement pinned on and no stored key it is not satisfied');
});

// The reachability claim: the ONE place a command's argv is admitted past a gate
// anchors on the literal `node`, so an env-assignment prefix does not smuggle
// `TRAFFIC_ONE_AUTH=0` into an exempt command — it costs the command its
// exemption. Revert the `words[0] !== 'node'` anchor in tool-classify.ts and the
// third assertion here goes red.
test('an env-assignment prefix cannot ride the gate-exempt doctor grammar', () => {
  const doctor = gateExemptDoctorScriptPaths()[0] as string;
  assert.ok(doctor && path.isAbsolute(doctor), 'fixture guard: an absolute exempt doctor path exists');

  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${doctor}` }), true,
    'fixture guard: the bare command IS the exempt form');
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `TRAFFIC_ONE_AUTH=0 node ${doctor}` }), false,
    'prefixing the exempt command with an auth opt-out loses the exemption');
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `env TRAFFIC_ONE_AUTH=0 node ${doctor}` }), false,
    'and the `env` wrapper spelling is not admitted either');
});
