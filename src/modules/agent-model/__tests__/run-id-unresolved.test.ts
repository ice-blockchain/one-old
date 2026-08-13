// src/modules/agent-model/__tests__/run-id-unresolved.test.ts
// The `spawn-run-id-unparseable` deny, pinned CLAUSE BY CLAUSE, because it is a
// deny an agent must act on rather than an advisory it can weigh — the reason IS
// the remedy, so a false clause is a product defect and not a typo.
//
// Three things were wrong in the sentence this file now guards:
//   * it named a backup "under `.traffic-one/backups/`". Nothing writes a state
//     pointer there — that directory only ever receives `AGENTS.md`, `CLAUDE.md`
//     and a `.claude/skills` copy from the gitnexus bootstrap, and it is itself
//     gitignored. The same clause was corrected in shared/retention.ts's
//     suspension notice in the same lane.
//   * it said "do NOT … hand-write the file" without qualification, which forbids
//     the ONE route an agent has: writing HEAD's committed bytes back to the state
//     path, permitted by the write fence's deliberate exemption (measured in
//     state/state-loss.ts). The prohibition is kept where it is TRUE — inventing a
//     run id, authoring state — and the restore is spelled out beside it.
//   * it announced "exists but could not be parsed" UNCONDITIONALLY, in states
//     where nothing was read and nothing was parsed. `ensureCurrentRunId` fails
//     closed for four different shapes; only one of them is a torn pointer.
//
// So the rows below drive the real gate over all four shapes and assert what the
// agent is TOLD in each, plus the two facts the prose leans on: that a live run
// would have been adopted instead of reaching this deny at all, and that the
// restore it prescribes actually clears the deny and adopts the committed id
// rather than minting a sibling. Fixtures are mkdtemp roots (withMaterialized);
// every path under this checkout is a non-project by the authoring stand-down.
//
// ── A FOURTH DEFECT OF THE SAME CLASS, ONE ROUND LATER ─────────────────────────
// The `parses` arm — the pointer is fine and the WRITE is what failed — carried a
// parenthesised list of three causes, and that list was complete only while a
// refused write was the only way to reach the arm. Containing the escaping lock
// failure in `ensureCurrentRunId` (state/run-agent/run-paths.ts) routed TWO more
// states into it: a state directory this process may not write, and plain lock
// CONTENTION, which needs no unusual permissions and is ordinary on a busy
// project. Their remedies are a `chmod` only the user can run and a RETRY that
// needs nobody — and the arm told both to report to a human. One of the three
// causes it did list, a symlink at the destination, cannot reach the arm at all,
// because the SYMLINK row above claims that shape first.
//
// The four rows in the second half of this file are that repair: the arm probes
// the fence and the filesystem with side-effect-free questions instead of listing,
// and each row pins both what its own arm says and what the OTHER three arms must
// not say inside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { agentModelGate } from '../handler';
import { withMaterialized } from './agent-model-fixtures';
import { clearPluginUseChoice, recordPluginUseChoice, resetPluginUseCache } from '../../../shared/state/plugin-use';
import type { Ctx, HookInput, HookResult, ToolClass } from '../../../core/types';

const T1 = '.traffic-one';
const TORN = '{"mode":"new-project","currentRunId":"17851';

function spawnCtx(cwd: string): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    raw: {
      tool_name: 'Task',
      tool_input: { subagent_type: 'senior-frontend', model: 'opus', prompt: 'build the thing' },
      session_id: 'parent-1',
    },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function statePath(cwd: string): string {
  return path.join(cwd, T1, '.one.json');
}

// The fixture's own pointer minus `currentRunId` — every materialization stamp
// kept, so an arm about the run id is not answered by the materialization gate.
function dropRunId(cwd: string): void {
  const one = JSON.parse(fs.readFileSync(statePath(cwd), 'utf8')) as Record<string, unknown>;
  delete one.currentRunId;
  fs.writeFileSync(statePath(cwd), JSON.stringify(one), 'utf8');
}

function denyReason(result: HookResult, denyId: string): string {
  assert.equal(result.kind, 'deny');
  if (result.kind !== 'deny') return '';
  assert.equal(result.denyId, denyId, result.reason);
  return result.reason;
}

// Every arm asserts these, whatever the pointer's shape: the false backup route is
// gone, the fabrication prohibition is intact, and the adoption claim is only made
// because the gate really did look (the row below proves it looked).
function assertInvariants(reason: string): void {
  assert.doesNotMatch(reason, /backups/,
    'no state pointer is ever written under `.traffic-one/backups/` — the directory takes AGENTS.md, '
    + 'CLAUDE.md and .claude/skills, and is gitignored');
  assert.match(reason, /Do NOT mint one and do NOT author state/,
    'inventing a run id remains forbidden: a fabricated id splits the run');
  assert.match(reason, /looked for a live run in `\.traffic-one\/runs\/` and found none/);
}

test('a torn pointer is named as torn, and the agent is pointed at the copies that exist', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    fs.writeFileSync(statePath(cwd), TORN, 'utf8');
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), 'spawn-run-id-unparseable');
    assertInvariants(reason);
    assert.match(reason, /`\.traffic-one\/\.one\.json` is there and its bytes do not parse\./);
    // The route state-loss.ts measured: read HEAD, write those bytes, change nothing.
    assert.match(reason, /git show HEAD:\.traffic-one\/\.one\.json/);
    assert.match(reason, /write those exact bytes with Write or apply_patch/);
    assert.match(reason, /Change NOTHING in them/);
    // …and the actor split, identical to state-loss.ts's and retention.ts's.
    assert.match(reason, /Restoring the state directory with git is refused for you/);
    assert.match(reason, /the user's route, in their own terminal/);
    // The quarantine is NOT named in this state, because it is not on disk: the
    // sibling is written by the state write that REPLACES unparseable bytes.
    assert.equal(fs.existsSync(`${statePath(cwd)}.corrupt`), false);
    assert.doesNotMatch(reason, /\.one\.json\.corrupt/,
      'a path that is not there must not be offered as a recovery route — that was the defect');
  });
});

test('the `.one.json.corrupt` quarantine is named exactly when it is on disk', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    fs.writeFileSync(statePath(cwd), TORN, 'utf8');
    fs.writeFileSync(`${statePath(cwd)}.corrupt`, '{"mode":"new-project","older":true', 'utf8');
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), 'spawn-run-id-unparseable');
    assertInvariants(reason);
    assert.match(reason, /preserved beside it at `\.traffic-one\/\.one\.json\.corrupt`/);
    assert.match(reason, /nothing in the runtime reads that file/,
      'the sibling is kept to be repaired FROM; a reader would make deleting it a data loss');
  });
});

test('a pointer nothing can READ is not reported as a parse failure', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    // A directory where the pointer belongs: the bounded read never reads a byte,
    // so "could not be parsed" describes a parse that never happened, and "repair
    // its JSON" names JSON that does not exist.
    fs.rmSync(statePath(cwd));
    fs.mkdirSync(statePath(cwd));
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), 'spawn-run-id-unparseable');
    assertInvariants(reason);
    assert.match(reason, /nothing can be read at `\.traffic-one\/\.one\.json` \(EISDIR\)/);
    assert.match(reason, /no JSON bytes there to repair/);
    assert.match(reason, /a removal rather than a write/);
    assert.doesNotMatch(reason, /bytes do not parse/);
  });
});

test('a symlink at the pointer path is named as one, not as an absent file', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    // The shape write-refusal.test.ts calls what a hostile repo ships on clone.
    // The bounded read reports `absent` (it will not follow the link) while lstat
    // still finds an entry — and a Write here is refused for the link-ness alone,
    // so "it is not there, restore it" would send the agent into a refusal.
    fs.rmSync(statePath(cwd));
    fs.symlinkSync(path.join(cwd, T1, 'absent-target.json'), statePath(cwd));
    const reason = denyReason(agentModelGate(spawnCtx(cwd)), 'spawn-run-id-unparseable');
    assertInvariants(reason);
    assert.match(reason, /is a SYMLINK: the state write fence refuses to write THROUGH one/);
    assert.match(reason, /The link has to be cleared/);
    assert.doesNotMatch(reason, /is not there at all/);
  });
});

// ── THE FOUR CAUSES OF A PERSIST THAT DID NOT LAND ─────────────────────────────
// These four rows share one branch — the pointer PARSES, so nothing is wrong with
// it and the WRITE is what failed — and they exist because that branch used to
// print one parenthesised list of three causes for all of them. Two of the four
// arrived when the sibling lane contained `ensureCurrentRunId`'s escaping lock
// failure (state/run-agent/run-paths.ts): the throw that used to leave through the
// hook is now the designed `return ''`, which lands here. One of the three the list
// named was never reachable in this branch at all.
//
// The remedies are genuinely different — one is the agent's to clear, two are the
// user's, and one needs nobody — so each row pins BOTH what its arm says and what
// the other arms must not say in it.

test('an unanswered consent question is named as the ONE cause the agent can clear', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    const prevAsk = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    try {
      dropRunId(cwd);
      // Pinned rather than inherited: the fence's answer for a pending project IS
      // this value, so a suite that inherits it is not testing the product.
      process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
      clearPluginUseChoice(cwd);
      resetPluginUseCache();
      const reason = denyReason(agentModelGate(spawnCtx(cwd)), 'spawn-run-id-unparseable');
      assertInvariants(reason);
      assert.match(reason, /parses, so the pointer is not what is wrong — the id could not be PERSISTED/);
      assert.match(reason, /has not answered "use Traffic One here\?" yet/);
      // The corrected remedy. This arm used to end in "report this to the user",
      // which is an escalation for the one cause of this deny that needs none:
      // answering the question clears it, and the row below proves it does.
      assert.match(reason, /the ONE cause of this deny you can clear yourself: answer that question/);
      assert.doesNotMatch(reason, /report (this|the directory|that exact path) to the user/,
        'a question the agent can answer must not be handed to a human instead');
      // MEASURED in this state: every tool call is refused, `cat` and `ls`
      // included — so an arm that offered a read here would be offering a refusal.
      assert.match(reason, /every tool call in this project is refused/);
      assert.doesNotMatch(reason, /`ls -la/);
      // Nothing the agent writes fixes a refused write, so the restore route is
      // NOT offered here: printing it would be an instruction that cannot succeed.
      assert.doesNotMatch(reason, /git show HEAD/);

      // The prescribed route actually clears it.
      recordPluginUseChoice(cwd, true, 'test');
      resetPluginUseCache();
      const after = agentModelGate(spawnCtx(cwd));
      if (after.kind === 'deny') {
        assert.notEqual(after.denyId, 'spawn-run-id-unparseable',
          'answering the question is the remedy, so it must clear this deny');
      }
    } finally {
      if (prevAsk === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
      else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = prevAsk;
      resetPluginUseCache();
    }
  });
});

test('a fence refusal over the PATH SHAPE is separated from the consent question', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    // `.traffic-one` itself is a link out of the project: the fence refuses, and
    // consent is recorded, so the two halves of `classifyStateWrite` are split.
    // This is also the ONLY way the fence's `symlink` reason reaches this arm — a
    // link AT the pointer is claimed by the SYMLINK row above, which is why the
    // old list's "a symlink planted at the destination" was unreachable here.
    dropRunId(cwd);
    const dir = path.join(cwd, T1);
    const away = path.join(cwd, 'elsewhere');
    fs.renameSync(dir, away);
    fs.symlinkSync(away, dir);

    const reason = denyReason(agentModelGate(spawnCtx(cwd)), 'spawn-run-id-unparseable');
    assertInvariants(reason);
    assert.match(reason, /NOT over the consent question — this project has answered that/);
    assert.match(reason, /What it refuses is the SHAPE of the path/);
    assert.match(reason, /This gate cannot tell which of the three from here, and it will not guess/,
      'three fence reasons remain and classifyStateWrite exports none of them: enumerate, never assert');
    // MEASURED in this state: `ls -la .traffic-one` and `cat` pass while Write,
    // rm and chmod are refused — so the read is offered and the removal is not.
    assert.match(reason, /`ls -la \.traffic-one` is worth running/);
    assert.match(reason, /removals there are refused for you/);
    assert.doesNotMatch(reason, /clear yourself/, 'this one is not the agent\'s to clear');
    assert.doesNotMatch(reason, /chmod u\+w/, 'the mode is fine here; naming it would be a cause nobody checked');
    assert.doesNotMatch(reason, /re-send this SAME spawn ONCE/, 'a path shape is not transient');

    // The user's removal is what clears it.
    fs.unlinkSync(dir);
    fs.renameSync(away, dir);
    const after = agentModelGate(spawnCtx(cwd));
    if (after.kind === 'deny') assert.notEqual(after.denyId, 'spawn-run-id-unparseable');
  });
});

test('a state dir the process may not write is named as a mode, not as a refused write', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    // The first of the two states the sibling lane's containment routed here: the
    // lock stages a directory INSIDE the state dir, so acquisition raises EACCES
    // and so does the mint its catch runs. The fence PERMITS this path, which is
    // what makes it a different sentence from the two above.
    dropRunId(cwd);
    const dir = path.join(cwd, T1);
    const mode = fs.statSync(dir).mode & 0o777;
    fs.chmodSync(dir, 0o555);
    try {
      const reason = denyReason(agentModelGate(spawnCtx(cwd)), 'spawn-run-id-unparseable');
      assertInvariants(reason);
      assert.match(reason, /The fence PERMITS that write and the filesystem refused it/);
      assert.match(reason, /cannot be written by the process running this hook/);
      // MEASURED: `chmod u+w` is refused for the agent in this exact state.
      assert.match(reason, /`chmod u\+w` on that directory, which is refused for you/);
      assert.match(reason, /the user's, in their own terminal/);
      assert.doesNotMatch(reason, /SHAPE of the path|use Traffic One here/,
        'the fence is not what refused this, so its causes must not be printed');
      assert.doesNotMatch(reason, /re-send this SAME spawn ONCE/, 'no retry changes a directory mode');
    } finally {
      fs.chmodSync(dir, mode);
    }
    const after = agentModelGate(spawnCtx(cwd));
    if (after.kind === 'deny') {
      assert.notEqual(after.denyId, 'spawn-run-id-unparseable', 'the chmod is the remedy, so it must clear it');
    }
  });
});

test('plain lock CONTENTION gets a bounded retry, not an escalation', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    // The second state the containment routed here, and the one the old sentence
    // got backwards: it needs no unusual permissions, no repair and no human. A
    // live owner on the project state lock — our OWN pid, so neither reaper may
    // take it and the contention is deterministic rather than a race.
    dropRunId(cwd);
    const lockPath = `${statePath(cwd)}.report-id.lock`;
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, 'owner-contended.json'),
      JSON.stringify({ pid: process.pid, token: 'contended', createdAt: Date.now() }),
      'utf8',
    );

    const reason = denyReason(agentModelGate(spawnCtx(cwd)), 'spawn-run-id-unparseable');
    assertInvariants(reason);
    assert.match(reason, /nothing that refuses DURABLY is in the way/);
    assert.match(reason, /what did not complete is the serialized write itself/);
    assert.match(reason, /it clears on its own with no repair by anyone/);
    assert.match(reason, /re-send this SAME spawn ONCE, unchanged/,
      'the remedy is a retry: telling the agent to report this to a human wastes them');
    // Bounded, with the escape named — the cause cannot be CONFIRMED from here,
    // so an unbounded retry would be the loop this whole class of deny prevents.
    assert.match(reason, /If this identical deny comes back on that retry, stop retrying/);
    assert.match(reason, /a refusal that survives a retry is not contention/);
    // None of the three checkable causes may be claimed here: all three passed.
    assert.doesNotMatch(reason, /use Traffic One here|SHAPE of the path|chmod u\+w/);
    assert.doesNotMatch(reason, /clear yourself/);

    // Still held → the same deny. Released → it mints and moves on.
    denyReason(agentModelGate(spawnCtx(cwd)), 'spawn-run-id-unparseable');
    fs.rmSync(lockPath, { recursive: true, force: true });
    const after = agentModelGate(spawnCtx(cwd));
    if (after.kind === 'deny') {
      assert.notEqual(after.denyId, 'spawn-run-id-unparseable',
        'the retry the deny prescribes has to work once the holder is gone');
    }
    assert.match(
      String((JSON.parse(fs.readFileSync(statePath(cwd), 'utf8')) as { currentRunId?: unknown }).currentRunId),
      /^\d{13}$/,
      'and the id it then mints is PERSISTED, which is the promise the empty string was protecting',
    );
  });
});

test('"nothing to adopt" is only ever printed where the gate really found nothing', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    // A live, non-terminal spawn-gate ledger in runs/ is ADOPTED over a torn
    // pointer, so this deny is never reached in that state — which is what makes
    // its adoption clause true, and what makes restoring a committed pointer safe
    // here: there is no running team for the committed id to strand.
    const runId = String(Date.now());
    const runDir = path.join(cwd, T1, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1, runId, status: 'planned', kind: 'spawn-gate', createdAt: new Date().toISOString(),
    }), 'utf8');
    fs.writeFileSync(statePath(cwd), TORN, 'utf8');

    const result = agentModelGate(spawnCtx(cwd));
    assert.equal(result.kind, 'deny');
    if (result.kind === 'deny') {
      assert.notEqual(result.denyId, 'spawn-run-id-unparseable',
        'the adoptable run is taken; the spawn proceeds to the ordinary phase gates');
      assert.match(result.reason, new RegExp(runId), 'and it proceeds under the ADOPTED id');
    }
  });
});

test('the route the deny prescribes clears it, and adopts the committed id', () => {
  withMaterialized({ teamApproved: true, architectComplete: false }, (cwd) => {
    // What HEAD carries for a project that committed its pointer, including the
    // stale `currentRunId` the committed copy always has.
    const committed = JSON.parse(fs.readFileSync(statePath(cwd), 'utf8')) as Record<string, unknown>;
    committed.currentRunId = '1700000000000';
    const bytes = JSON.stringify(committed);

    fs.writeFileSync(statePath(cwd), TORN, 'utf8');
    denyReason(agentModelGate(spawnCtx(cwd)), 'spawn-run-id-unparseable');

    // The agent's one permitted move: those exact bytes, written to the state path.
    fs.writeFileSync(statePath(cwd), bytes, 'utf8');
    const after = agentModelGate(spawnCtx(cwd));
    if (after.kind === 'deny') {
      assert.notEqual(after.denyId, 'spawn-run-id-unparseable',
        'the restore is the remedy, so it must actually clear this deny');
    }
    assert.equal(
      (JSON.parse(fs.readFileSync(statePath(cwd), 'utf8')) as { currentRunId?: string }).currentRunId,
      '1700000000000',
      'the committed id is ADOPTED, not re-minted — so the prescribed route cannot split the run',
    );
  });
});
