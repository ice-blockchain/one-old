// cleanupPrevious across all three consent states.
//
// Deleting is a write. The product contract's pending half is byte-identity and
// its declined half is "left untouched", and this function is the one that used
// to break the second half while the first was being fixed: it reclaimed a
// previously materialized tree through raw `fs.rmSync`/`fs.renameSync`, so a
// project that had been materialized under an earlier version and then declined
// could still be swept — irreversibly, which a refused write is not.
//
// PENDING is covered alongside DECLINED, not assumed to follow from it. The two
// are different predicates over different recorded values ("no answer" vs
// "answered no"), and a regression that special-cased `enabled === false` — the
// shape a careless fix takes — passes every declined case in this file while
// sweeping every project that has simply not been asked yet.
//
// The asymmetry mattered most for the ROOT documentation migration: `api.md` and
// friends are the user's files at their repo root, and the migration used to
// MOVE them into `.traffic-one/`. With the destination fenced and the source not,
// an unfenced move deleted the root file and put nothing in its place. It COPIES
// now (cleanup.ts adoptLegacyRootDocumentationFile) — Traffic One cannot prove it
// wrote a file called `api.md` — so the consent question for these five is only
// about the copy landing in `.traffic-one/`, and the assertions below say so.
//
// Every fixture below is a real generated artifact — cleanupPrevious only touches
// files carrying the GENERATED marker (or a `generatedBy: traffic-one` manifest),
// so a fixture without them would make the test pass by having nothing to delete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cleanupPrevious } from '../cleanup';
import { GENERATED_MARKER } from '../generated';
import { preserveManualRootContext, writeRootAgents } from '../render-agents';
import { recordPluginUseChoice, resetPluginUseCache } from '../../state/plugin-use';

type Consent = 'pending' | 'declined' | 'consented';

const RULE_REL = 'rules/core/coding.md';
const STALE_SKILL = 'stale-skill';

function generated(body: string): string {
  return `${body}\n\n${GENERATED_MARKER}\n`;
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// A project materialized by an EARLIER version: current-layout generated rule,
// the legacy `rules/active/` tree, the legacy rule AGENTS.md + manifest, legacy
// `rules/coding.md`/`security.md`, a stale generated skill dir, and root
// documentation awaiting migration. cleanupPrevious has a branch for each.
function seedMaterialized(project: string): void {
  const memory = path.join(project, '.traffic-one');
  write(path.join(project, 'package.json'), '{"name":"demo"}\n');
  write(path.join(memory, RULE_REL), generated('# coding'));
  write(path.join(memory, 'rules', 'active', RULE_REL), generated('# legacy active coding'));
  write(path.join(memory, 'rules', 'AGENTS.md'), generated('# legacy rules index'));
  write(path.join(memory, 'rules', 'manifest.json'), `${JSON.stringify({ generatedBy: 'traffic-one', rules: [RULE_REL] })}\n`);
  write(path.join(memory, 'rules', 'coding.md'), generated('# legacy memory coding'));
  write(path.join(memory, 'rules', 'security.md'), generated('# legacy memory security'));
  write(path.join(memory, 'skills', STALE_SKILL, 'SKILL.md'), generated('# stale skill'));
  // Root documentation: the user's own files, at their repo root.
  write(path.join(project, 'api.md'), '# my api notes\n');
  write(path.join(project, 'database.md'), '# my database notes\n');
}

const PREVIOUS = { rules: [RULE_REL], skills: [STALE_SKILL] };

function withProject(consent: Consent, fn: (project: string) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-cleanup-consent-')));
  const project = path.join(base, 'project');
  const env = process.env;
  const saved = { prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH, ask: env.TRAFFIC_ONE_ASK_USE_PLUGIN, home: env.HOME, xdg: env.XDG_STATE_HOME };
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  env.HOME = path.join(base, 'home');
  env.XDG_STATE_HOME = path.join(base, 'xdg');
  fs.mkdirSync(project, { recursive: true });
  resetPluginUseCache();
  seedMaterialized(project);
  // Recorded BEFORE the snapshot: recordPluginUseChoice(false) runs its own
  // decline sweep, and what is being measured here is cleanupPrevious. 'pending'
  // records nothing at all — that is the state.
  if (consent !== 'pending') recordPluginUseChoice(project, consent === 'consented', 'test');
  resetPluginUseCache();
  try {
    fn(project);
  } finally {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_ASK_USE_PLUGIN: saved.ask,
      HOME: saved.home,
      XDG_STATE_HOME: saved.xdg,
    })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { out.set(`${key}/`, 'dir'); walk(abs, key); continue; }
      if (entry.isSymbolicLink()) { out.set(key, `symlink:${fs.readlinkSync(abs)}`); continue; }
      out.set(key, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
    }
  };
  walk(root, '');
  return out;
}

const REFUSING: readonly Consent[] = ['pending', 'declined'];

for (const consent of REFUSING) {
  test(`${consent.toUpperCase()}: cleanupPrevious deletes nothing, copies nothing, and reports 0`, () => {
    withProject(consent, (project) => {
      const before = snapshot(project);
      // Empty next-sets: every previous rule and skill is stale, so every branch
      // in cleanupPrevious wants to delete.
      const removed = cleanupPrevious(project, { ...PREVIOUS }, new Set<string>(), new Set<string>());

      assert.equal(removed, 0, 'a refused delete must not be counted as one');
      const after = snapshot(project);
      const drift = [...before.keys()].filter((k) => before.get(k) !== after.get(k))
        .concat([...after.keys()].filter((k) => !before.has(k)));
      assert.deepEqual(drift, [], `a ${consent} project is left untouched`);
      // Spelled out, because the root files are the user's own, outside the
      // fenced state dir: the copy into `.traffic-one/` is refused, and the
      // originals are never touched by this function in any consent state.
      assert.equal(fs.readFileSync(path.join(project, 'api.md'), 'utf8'), '# my api notes\n');
      assert.equal(fs.readFileSync(path.join(project, 'database.md'), 'utf8'), '# my database notes\n');
      assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'api.md')), false, 'and nothing was copied in either');
    });
  });
}

// ── the root context takeover ────────────────────────────────────────────────
// preserveManualRootContext is the only function allowed to delete a
// user-authored root AGENTS.md, and it may only do so once the copy that
// replaces it is on disk. The observed failure was exactly the split: the
// preserving copy into `.traffic-one/` was refused while the delete still
// landed, so the content was destroyed rather than moved.

const NEW_PROJECT = { mode: 'new-project' } as const;
const HAND_WRITTEN = '# My own notes\n\nIrreplaceable.\n';

for (const consent of REFUSING) {
  test(`${consent.toUpperCase()}: the root context takeover neither preserves nor deletes — the hand-written file survives intact`, () => {
    withProject(consent, (project) => {
      const rootAgents = path.join(project, 'AGENTS.md');
      fs.writeFileSync(rootAgents, HAND_WRITTEN, 'utf8');

      assert.equal(preserveManualRootContext(project, 'AGENTS.md', { ...NEW_PROJECT }), false, 'it must decline rather than half-migrate');
      assert.equal(fs.readFileSync(rootAgents, 'utf8'), HAND_WRITTEN, 'the only copy of the content still exists');
      assert.equal(fs.existsSync(path.join(project, '.traffic-one', 'AGENTS.local.md')), false, 'and the preserving copy was refused');

      // The consequence of declining, asserted so the degradation is known to be
      // safe rather than assumed: the generated writer stands down on a
      // non-generated root file, so the project keeps the user's version.
      assert.equal(writeRootAgents(project, 'generated context\n'), false);
      assert.equal(fs.readFileSync(rootAgents, 'utf8'), HAND_WRITTEN);
    });
  });
}

test('CONSENTED: the root context takeover preserves first, then deletes', () => {
  withProject('consented', (project) => {
    const rootAgents = path.join(project, 'AGENTS.md');
    fs.writeFileSync(rootAgents, HAND_WRITTEN, 'utf8');

    assert.equal(preserveManualRootContext(project, 'AGENTS.md', { ...NEW_PROJECT }), true);
    const preserved = fs.readFileSync(path.join(project, '.traffic-one', 'AGENTS.local.md'), 'utf8');
    assert.ok(preserved.includes('Irreplaceable.'), 'the content survives the takeover');
    assert.equal(fs.existsSync(rootAgents), false, 'and only then is the root file removed');
  });
});

// The same fixture with consent recorded: proves the test above is not passing
// because the fixture has nothing to clean, and that the fence is behaviour-
// neutral once the question is answered yes.
test('CONSENTED: the same call performs the whole sweep and the migration', () => {
  withProject('consented', (project) => {
    const memory = path.join(project, '.traffic-one');
    const removed = cleanupPrevious(project, { ...PREVIOUS }, new Set<string>(), new Set<string>());

    // 8, not the 10 this asserted before: the two root documentation files are
    // copied now, and a copy is not a removal.
    assert.ok(removed >= 8, `expected the full sweep, got ${removed}`);
    assert.equal(fs.existsSync(path.join(memory, RULE_REL)), false, 'stale rule removed');
    assert.equal(fs.existsSync(path.join(memory, 'rules', 'active')), false, 'legacy active tree removed');
    assert.equal(fs.existsSync(path.join(memory, 'rules', 'AGENTS.md')), false, 'legacy rules index removed');
    assert.equal(fs.existsSync(path.join(memory, 'rules', 'manifest.json')), false, 'legacy manifest removed');
    assert.equal(fs.existsSync(path.join(memory, 'skills', STALE_SKILL)), false, 'stale skill dir removed');
    // Legacy memory files MOVE up one level rather than being deleted. They are
    // inside `.traffic-one/` at both ends — Traffic One's own tree, and provably
    // its own output (they carry the GENERATED marker).
    assert.equal(fs.existsSync(path.join(memory, 'rules', 'coding.md')), false);
    assert.ok(fs.readFileSync(path.join(memory, 'coding.md'), 'utf8').includes('legacy memory coding'), 'content preserved by the move');
    assert.ok(fs.readFileSync(path.join(memory, 'security.md'), 'utf8').includes('legacy memory security'));
    // Root documentation is COPIED into `.traffic-one/` and left at the root.
    // This assertion was inverted until the copy landed: it asserted `root
    // api.md migrated away`, which is the defect — `api.md`, `database.md`,
    // `deployment.md`, `environment-setup.md` and `security.md` are ordinary
    // filenames, Traffic One cannot prove it wrote one, and the move deleted all
    // five from a documentation repository it had never written a byte into.
    assert.equal(fs.readFileSync(path.join(project, 'api.md'), 'utf8'), '# my api notes\n', 'the user\'s root file stays where they put it');
    assert.equal(fs.readFileSync(path.join(memory, 'api.md'), 'utf8'), '# my api notes\n', 'and the canonical copy exists');
    assert.equal(fs.readFileSync(path.join(memory, 'database.md'), 'utf8'), '# my database notes\n');
    // Idempotent: the second sweep finds the root docs already carried and
    // neither re-appends them nor invents a removal to report.
    const again = cleanupPrevious(project, { ...PREVIOUS }, new Set<string>(), new Set<string>());
    assert.equal(again, 0, 'a second sweep has nothing left to do');
    assert.equal(fs.readFileSync(path.join(memory, 'api.md'), 'utf8'), '# my api notes\n', 'and nothing was appended twice');
  });
});
