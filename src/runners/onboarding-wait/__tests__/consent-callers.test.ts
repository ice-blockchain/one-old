// The three production callers of `recordPluginUseChoice`, and what each of them
// can say when the answer did not reach disk.
//
// `updateProjectPrefs` refuses to CREATE a preferences root for a directory an
// enclosing project owns (state/local-prefs/prefs-store.ts, the
// `mercury/strategies` incident) and reports that refusal by returning the prefs
// it just READ — an object shaped exactly like a successful merge. So on a plain
// sub-directory of a workspace the choice is simply not recorded, and for the
// DECLINE that is worse than a lost preference: `removeDeclinedProjectArtifacts`
// has already run, so the project's runtime files are gone AND the "no" is not
// on record.
//
// The fixtures use the NATURAL trigger — a marker-less directory inside a `.git`
// repo — rather than a planted permission fence, because that is the shape the
// defect was measured on and a fence can make the write fail on its own
// precondition, which passes the test for the wrong reason. Each case carries a
// fixture guard proving the refusal really happened, plus a writable baseline in
// the same call shape proving the same code path DOES write when it is allowed
// to; without that pair a green test says nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { applyReconsiderChoice } from '../consent';
import { applyUseChoice, declineOutput } from '../wizard-output';
import {
  projectWritesPermitted,
  pluginUseDeclined,
  readPluginUseChoice,
  recordPluginUseChoice,
  resetPluginUseCache,
} from '../../../shared/state/plugin-use';

const RECORDED_DECLINE_BODY = "Traffic One is disabled for this project — continue the user's request "
  + 'without Traffic One conventions. It stays silent here until the user explicitly asks for Traffic One again.\n';

interface EnclosedCase {
  /** A directory that OWNS a project: it carries version control of its own. */
  repo: string;
  /** A marker-less directory inside it — the shape that gets no preferences root. */
  sub: string;
  base: string;
  /** Point the prefs store at a fresh, NON-EXISTENT path (creation is what is refused). */
  usePrefs: (name: string) => string;
}

const ENV_KEYS = ['TRAFFIC_ONE_PROJECT_PREFS_PATH', 'TRAFFIC_ONE_ASK_USE_PLUGIN'] as const;

function withEnclosedSubdirectory(fn: (ctx: EnclosedCase) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-consent-callers-')));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const repo = path.join(base, 'workspace');
  const sub = path.join(repo, 'services', 'billing');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  // The shipped default, pinned explicitly: with ask-first off there is no
  // use-plugin question for any of this to be pending on.
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  const usePrefs = (name: string): string => {
    const prefsPath = path.join(base, `${name}.json`);
    process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefsPath;
    resetPluginUseCache();
    return prefsPath;
  };
  usePrefs('initial');
  try {
    fn({ repo, sub, base, usePrefs });
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** Pre-decline runtime residue, so "the sweep already ran" is observable. */
function plantResidue(dir: string): string {
  const marker = path.join(dir, '.traffic-one', 'runs', '.once', 'marker');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, 'x\n', 'utf8');
  fs.mkdirSync(path.join(dir, '.traffic-one', 'debug'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', 'debug', 'decisions.jsonl'), '{"decision":"deny"}\n', 'utf8');
  return marker;
}

// ── CALLER 1: declineOutput, whose RETURN VALUE is the promise ───────────────

test('declineOutput stops promising silence when the decline never reached disk', () => {
  withEnclosedSubdirectory((ctx) => {
    const prefsPath = ctx.usePrefs('sub-decline');
    const residue = plantResidue(ctx.sub);

    const out = declineOutput(ctx.sub, 'cursor');

    // Fixture guards: the refusal really happened, and it happened AFTER the sweep.
    assert.equal(fs.existsSync(prefsPath), false, 'fixture guard: no preferences root was created');
    assert.equal(readPluginUseChoice(ctx.sub), null, 'fixture guard: the decline is NOT on record');
    assert.equal(fs.existsSync(residue), false,
      'fixture guard: the artifacts were already swept — that is what makes the false promise costly');
    assert.equal(fs.existsSync(path.join(ctx.sub, '.traffic-one')), false, 'fixture guard: the state dir went too');

    // Line 1 is the protocol token; only the body varies.
    assert.match(out, /^TRAFFIC_ONE_DISABLED\n/, 'the stdout protocol token is byte-identical');
    assert.doesNotMatch(out, /stays silent here/,
      'the sentence that is false: the question returns next session');
    assert.doesNotMatch(out, /disabled for this project/,
      'nothing durable was recorded, so nothing is disabled for this project');
    assert.match(out, /decline was NOT saved/, 'names what did not happen');
    assert.match(out, /deleted before that was known and do not come back/,
      'names the irreversible half — the sweep ran before the refusal was known');
    assert.match(out, /the question returns next session/, 'names the consequence for the user');
    assert.ok(out.includes(ctx.repo),
      'names the enclosing project root, which is the only place a decline would stick');

    // The writable baseline, in the same call shape: the enclosing project ROOT
    // owns a project of its own, so the identical call really does write.
    ctx.usePrefs('root-decline');
    const rootResidue = plantResidue(ctx.repo);
    const rootOut = declineOutput(ctx.repo, 'cursor');
    assert.equal(readPluginUseChoice(ctx.repo)?.enabled, false,
      'baseline: an unfenced path IS written by the same call');
    assert.equal(fs.existsSync(rootResidue), false, 'baseline: the sweep runs there too');
    assert.equal(rootOut, `TRAFFIC_ONE_DISABLED\n${RECORDED_DECLINE_BODY}`,
      'the recorded branch is unchanged, byte for byte');
  });
});

// ── CALLER 2: applyUseChoice — the `--use` yes path ──────────────────────────
//
// VERDICT: left alone. It returns void into `beginOnboardingAttempt`, whose own
// answer is `alreadyDone` (a different question), and it asserts nothing — so
// there is no false statement to correct and no value a caller already consumes.
// This test is the evidence behind that verdict, not a blessing of the silence:
// it pins the blast radius, so a change to the prefs guard that makes the yes
// land, or a future surface that starts speaking here, has to come back through
// this file.

test('the --use yes path records nothing on an enclosed sub-directory, and the fence keeps it harmless', () => {
  withEnclosedSubdirectory((ctx) => {
    const prefsPath = ctx.usePrefs('sub-use');
    const stateFile = path.join(ctx.sub, '.traffic-one', '.one.json');
    const seen: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      seen.push(String(chunk));
      return (realWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
      applyUseChoice(ctx.sub, ['--use', ctx.sub, '--seed-prompt=build a billing dashboard with charts']);
    } finally {
      process.stderr.write = realWrite;
    }

    assert.equal(fs.existsSync(prefsPath), false, 'fixture guard: no preferences root was created');
    assert.equal(readPluginUseChoice(ctx.sub), null, 'fixture guard: the yes is NOT on record');
    // The floor the verdict rests on: the refusal is not silent even with every
    // caller discarding it.
    assert.ok(
      seen.some((line) => line.includes('[traffic-one] plugin-use:') && line.includes('NOT')),
      'recordPluginUseChoice still reports the unrecorded answer on stderr',
    );
    // …and nothing destructive happened on this path. The yes writes no project
    // files, and `seedOriginalPrompt` — which runs afterwards regardless — checks
    // projectWritesPermitted itself, so an unrecorded yes cannot seed either.
    assert.equal(projectWritesPermitted(ctx.sub), false,
      'the write fence is still closed, because the question is still unanswered');
    assert.equal(fs.existsSync(stateFile), false, 'no project state file is created by an unrecorded yes');
    assert.equal(fs.existsSync(path.join(ctx.sub, '.traffic-one')), false, 'the project stays byte-identical');

    // Writable baseline in the same call shape.
    ctx.usePrefs('root-use');
    applyUseChoice(ctx.repo, ['--use', ctx.repo]);
    assert.equal(readPluginUseChoice(ctx.repo)?.enabled, true, 'baseline: the same call writes when allowed');
  });
});

// ── CALLER 3: applyReconsiderChoice ──────────────────────────────────────────
//
// VERDICT: left alone, and the reason is structural rather than a judgement
// call. `--reconsider` is offered by exactly one surface (modules/session/
// prompt-submit.ts), behind `pluginUseDeclined(cwd)` — which can only be true
// once a decline is ON DISK, i.e. once the preferences file EXISTS. The refusal
// in `updateProjectPrefs` is creation-time only. So the failing case cannot be
// reached from the route that produces the command.

test('reconsider cannot meet the refusal: it is only offered once the preferences file exists', () => {
  withEnclosedSubdirectory((ctx) => {
    // The sub-directory whose decline was refused is never offered reconsider,
    // because nothing recorded it as declined in the first place.
    ctx.usePrefs('sub-reconsider');
    declineOutput(ctx.sub, 'cursor');
    assert.equal(readPluginUseChoice(ctx.sub), null, 'fixture guard: the decline was refused');
    assert.equal(pluginUseDeclined(ctx.sub), false,
      'prompt-submit gates the reconsider command on this, so the command is never printed here');

    // Where reconsider IS offered, the preferences file is already on disk and
    // the creation-time refusal does not apply — even for the sub-directory.
    const subPrefs = ctx.usePrefs('sub-reconsider-existing');
    fs.writeFileSync(subPrefs, `${JSON.stringify({ pluginUse: { enabled: false, source: 'command', decidedAt: 'x' } })}\n`, 'utf8');
    resetPluginUseCache();
    assert.equal(pluginUseDeclined(ctx.sub), true, 'now the reconsider command would be offered');
    let syncedWith: unknown;
    applyReconsiderChoice(ctx.sub, 'codex', (syncCwd) => { syncedWith = syncCwd; }, undefined, process.env, true);
    assert.equal(readPluginUseChoice(ctx.sub)?.enabled, true,
      'an existing preferences file keeps updating, so reconsider records');
    assert.ok(syncedWith, 'and the public sync runs only behind that recorded consent');
  });
});

// The sync guard is the other half of caller 3's verdict: even if a reconsider
// somehow reached the refusal, `syncOneMcpOnce` re-checks `pluginUseEnabled`
// itself, so an unrecorded consent cannot leak into public MCP work.
test('an unrecorded reconsider cannot start public MCP work', () => {
  withEnclosedSubdirectory((ctx) => {
    ctx.usePrefs('sub-reconsider-refused');
    let synced = false;
    applyReconsiderChoice(ctx.sub, 'codex', () => { synced = true; }, undefined, process.env, true);
    assert.equal(readPluginUseChoice(ctx.sub), null, 'fixture guard: the consent was refused');
    assert.equal(synced, false, 'the sync stands down on its own consent read');

    ctx.usePrefs('root-reconsider');
    recordPluginUseChoice(ctx.repo, false, 'command');
    applyReconsiderChoice(ctx.repo, 'codex', () => { synced = true; }, undefined, process.env, true);
    assert.equal(readPluginUseChoice(ctx.repo)?.enabled, true, 'baseline: the same call records when allowed');
    assert.equal(synced, true, 'baseline: and the sync runs');
  });
});
