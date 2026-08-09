// The immutable/active envelope PAIR, and the one thing that makes it a pair:
// an active envelope resolves only when the immutable copy keyed by its own hash
// is there too. Both halves of that are pinned here, because the interesting
// failure is not a lost write — it is publishing the pointer over a twin the
// fence refused, which advances `active.json` to a hash that can never resolve
// and destroys the envelope that was resolving until that moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  activeRunBootstrapPath,
  ensureRunBootstrap,
  readActiveRunBootstrap,
} from '../run-bootstrap-policy';
import { immutableEnvelopePath } from '../run-bootstrap-policy/envelope-io';
import { writeJson } from '../fsjson';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-twin-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

const STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  onboardingComplete: true,
  mobile: { framework: 'none' },
};

const ROLE = 'senior-architect';
const OPTIONS = {
  host: 'codex' as const,
  hostAgentType: null,
  evidenceSource: 'spawn-task-name',
};

test('an active envelope whose immutable twin is missing never resolves', () => {
  withProject((cwd) => {
    const envelope = ensureRunBootstrap(cwd, 'R', ROLE, STATE, { ...OPTIONS, modelPolicyId: 'policy-1' });
    assert.ok(envelope);
    assert.equal(readActiveRunBootstrap(cwd, 'R', ROLE)?.envelopeHash, envelope.envelopeHash);
    // Only the twin is removed; `active.json` is left byte-identical and still
    // hash-valid on its own terms. This is what makes the pair unable to
    // DISAGREE — the integrity copy is a precondition of resolving the pointer,
    // not a decoration beside it — and it is the reason a half-landed publish
    // costs availability rather than admitting an envelope nothing vouches for.
    fs.rmSync(immutableEnvelopePath(cwd, 'R', ROLE, envelope.envelopeHash));
    assert.equal(
      readActiveRunBootstrap(cwd, 'R', ROLE),
      null,
      'an active envelope with no immutable twin must not resolve: the twin keyed by its hash is the integrity '
      + 'chain, and accepting the pointer without it is how a child binds to an envelope nothing can vouch for',
    );
  });
});

test('a refused immutable twin leaves the previously resolvable envelope intact', () => {
  withProject((cwd) => {
    const first = ensureRunBootstrap(cwd, 'R', ROLE, STATE, { ...OPTIONS, modelPolicyId: 'policy-1' });
    const second = ensureRunBootstrap(cwd, 'R', ROLE, STATE, { ...OPTIONS, modelPolicyId: 'policy-2' });
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.envelopeHash, second.envelopeHash);

    const activePath = activeRunBootstrapPath(cwd, 'R', ROLE);
    const roleDir = path.dirname(activePath);
    const secondTwin = immutableEnvelopePath(cwd, 'R', ROLE, second.envelopeHash);
    // Rewind to the state the run was in before the second publish: the pointer
    // names the first envelope, whose own twin is still on disk.
    fs.writeFileSync(activePath, `${JSON.stringify(first, null, 2)}\n`);
    fs.rmSync(secondTwin);
    assert.equal(
      readActiveRunBootstrap(cwd, 'R', ROLE)?.envelopeHash,
      first.envelopeHash,
      'the rewound fixture must resolve to the first envelope, or the assertion about destroying it proves nothing',
    );

    // The writable baseline, in the SAME directory, asserted before anything is
    // planted: a fixture that has stopped fencing must fail here rather than
    // pass by never refusing anything.
    const baseline = path.join(roleDir, 'writable-baseline.json');
    assert.equal(writeJson(baseline, { probe: true }), true, 'the role directory must be writable to begin with');
    fs.rmSync(baseline);

    // Fence exactly ONE path. A DANGLING link is the correct variant even though
    // the publisher reads this path before writing it: `fs.existsSync` follows
    // the link and answers false, which is the arm that goes on to write. A
    // move-aside-plus-link would answer true and skip the write altogether, and
    // the measurement would be vacuous.
    fs.symlinkSync(path.join(roleDir, 'no-such-target.json'), secondTwin);
    assert.equal(fs.existsSync(secondTwin), false, 'the planted link must be dangling, or the write is skipped');
    assert.equal(
      writeJson(secondTwin, { probe: true }),
      false,
      'the planted link must actually refuse a write at that path, or nothing below is being measured',
    );

    const republished = ensureRunBootstrap(cwd, 'R', ROLE, STATE, { ...OPTIONS, modelPolicyId: 'policy-2' });
    assert.equal(republished, null, 'a publish whose immutable twin was refused must not report success');
    assert.equal(
      (JSON.parse(fs.readFileSync(activePath, 'utf8')) as { envelopeHash: string }).envelopeHash,
      first.envelopeHash,
      'the refused twin must not cost the run its previous envelope: `active.json` was advanced to a hash whose '
      + 'twin is absent, which resolves for nobody, so the publish destroyed a working bootstrap to report the '
      + 'same null it would have reported anyway',
    );
    assert.equal(
      readActiveRunBootstrap(cwd, 'R', ROLE)?.envelopeHash,
      first.envelopeHash,
      'a child bound to this run must still resolve the envelope it had before the refused publish',
    );
  });
});
