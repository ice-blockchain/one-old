import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { materializeFromProjectMemoryWrite, materializeFromToolInputHints } from '../converge-from-write';
import { GENERATED_MARKER } from '../../../shared/materialize/generated';
import { writeMaterializedContent } from '../../../shared/materialize/__tests__/fixtures/materialized-content';
import { stackFingerprint, stateVersion } from '../../../shared/state';

function withProject(state: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-cfw-')));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  if (state) fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  try { fn(dir); } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('materializeFromProjectMemoryWrite: null for non-memory paths', () => {
  withProject({ stack: 'default', onboardingComplete: true }, (cwd) => {
    assert.equal(materializeFromProjectMemoryWrite(cwd, path.join(cwd, 'src', 'app.ts')), null);
    // a generated subtree write is not project memory
    assert.equal(materializeFromProjectMemoryWrite(cwd, path.join(cwd, '.traffic-one', 'rules', 'core.md')), null);
  });
});

test('materializeFromProjectMemoryWrite: null when stack/onboarding incomplete', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    // a project-memory write but no valid stack / not onboarded → no materialization
    assert.equal(materializeFromProjectMemoryWrite(cwd, path.join(cwd, '.traffic-one', 'product.md')), null);
  });
});

test('materializeFromProjectMemoryWrite never imports or stamps the legacy Cursor capture file', () => {
  withProject({
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none',
  }, (cwd) => {
    const legacy = path.join(cwd, '.traffic-one', 'cursor-models.json');
    const payload = { models: ['composer-2.5-fast'] };
    fs.writeFileSync(legacy, JSON.stringify(payload), 'utf8');
    const out = materializeFromProjectMemoryWrite(cwd, legacy);
    assert.deepEqual(JSON.parse(fs.readFileSync(legacy, 'utf8')), payload);
    assert.doesNotMatch((out && out.systemMessage) || '', /model choice|required model/i);
  });
});

test('materializeFromProjectMemoryWrite short-circuits an already-materialized project (reporter fires, no writes)', () => {
  const base = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', onboardingComplete: true };
  const state = {
    ...base,
    materializedStack: stackFingerprint(base),
    materializedVersion: stateVersion(),
    materializedAt: '2026-01-01T00:00:00Z',
  };
  withProject(state, (cwd) => {
    const t1 = path.join(cwd, '.traffic-one');
    // The full declared set, not a one-rule stand-in: a short manifest is the
    // shape of a project truncated by a partially copied plugin root, and
    // convergence now re-materializes that instead of short-circuiting (see
    // shared/materialize/has-assets.ts materializedContentIsIncomplete).
    writeMaterializedContent(cwd, { state });
    const skillPath = path.join(t1, 'skills', 'project-memory', 'SKILL.md');
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), `# ctx\n\n${GENERATED_MARKER}\n`, 'utf8');
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# claude', 'utf8');

    const before = fs.statSync(skillPath).mtimeMs;
    let reported = 0;
    const out = materializeFromProjectMemoryWrite(cwd, path.join(t1, 'product.md'), {
      reportOneMcp: () => { reported += 1; },
    });
    assert.equal(out, null, 'fresh assets → no re-materialization outcome');
    assert.equal(reported, 1, 'the one-mcp reporter still fires');
    assert.equal(fs.statSync(skillPath).mtimeMs, before, 'skill tree untouched');
  });
});

// The canonicalization write at the top of this path used to be dropped, so a
// convergence over a `.one.json` the fence refuses answered `null` — "nothing
// happened, nothing needed" — about a project whose state file cannot be written
// at all. MOVE-ASIDE rather than a dangling link: `writeState` re-reads the file
// it replaces and `readEffectiveState` above it reads it too, so a dangling link
// makes this path bail on its own precondition and the case would pass vacuously.
test('materializeFromProjectMemoryWrite: a refused state write is reported, not answered with the generic null', () => {
  const base = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', onboardingComplete: true };
  const state = {
    ...base,
    materializedStack: stackFingerprint(base),
    materializedVersion: stateVersion(),
    materializedAt: '2026-01-01T00:00:00Z',
  };
  // `confirmed` is absent, so normalizeState reports a change and the
  // canonicalization write really is attempted — without that this proves nothing.
  // Two separate projects, because the baseline call CANONICALIZES: a second call
  // in the same directory finds nothing to normalize and never reaches the write.
  const seed = (cwd: string): string => {
    writeMaterializedContent(cwd, { state });
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), `# ctx\n\n${GENERATED_MARKER}\n`, 'utf8');
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# claude', 'utf8');
    return path.join(cwd, '.traffic-one', 'product.md');
  };

  withProject(state, (cwd) => {
    assert.equal(materializeFromProjectMemoryWrite(cwd, seed(cwd)), null,
      'writable baseline: an unfenced convergence on fresh assets needs nothing');
    assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')).confirmed, true,
      'writable baseline: and the canonicalization it dropped the boolean of really did land');
  });

  withProject(state, (cwd) => {
    const memoryDoc = seed(cwd);
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const aside = `${statePath}.aside`;
    const before = fs.readFileSync(statePath, 'utf8');
    fs.renameSync(statePath, aside);
    fs.symlinkSync(aside, statePath);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before,
      'fixture guard: reads still resolve through the link, so this path reaches its write');

    const out = materializeFromProjectMemoryWrite(cwd, memoryDoc);
    assert.equal(out?.status, 'failed',
      'a convergence whose state write was refused is not "nothing needed"');
    assert.match(out?.context || '', /\.one\.json/,
      'and the diagnostic names the exact refused path');
  });
});

// An 'installed'-classified plugin root: the compiled runtime entry plus real
// content at the SHIPPED paths. Needed by any case where materialization must
// actually HAPPEN — this repo is a 'source' checkout under tsx and the writer
// refuses it. (Same fixture shape as converge.test.ts's withInstalledPluginRoot.)
function withInstalledPluginRoot<T>(fn: () => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cfw-plugin-'));
  const modules = path.resolve(__dirname, '..', '..', '..', 'modules');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'hook-runtime.cjs'), '// test fixture stub\n', 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'traffic-one', version: '9.9.9' }), 'utf8');
  fs.symlinkSync(path.join(modules, 'rules', 'rules'), path.join(root, 'rules'), 'dir');
  fs.symlinkSync(path.join(modules, 'skills', 'skills-catalog'), path.join(root, 'skills-catalog'), 'dir');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  for (const role of ['senior-frontend', 'senior-backend']) {
    fs.copyFileSync(path.join(modules, role, 'agent.md'), path.join(root, 'agents', `${role}.md`));
  }
  const previous = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = root;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The OTHER dropped write on this path: the stamp. Distinguished from the
// canonicalization case above by `result` — the stamp-side refusal carries the
// MaterializeResult, so a case that actually short-circuited on the first write
// (result null) cannot pass here by accident.
test('materializeFromProjectMemoryWrite: a refused materialization stamp is reported as failed, not materialized', () => {
  const canonical = {
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
    projectContext: { source: 'prompted', originalPrompt: 'x', summary: 'x', answers: {}, collectedAt: '2026-01-01T00:00:00Z' },
    realtime: 'none',
    supabaseFunctionsAutoDeploy: 'ask',
    confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
  };

  withProject(canonical, (cwd) => {
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const memoryDoc = path.join(cwd, '.traffic-one', 'product.md');
    // Canonicalize first, through this very path, against the repo's own 'source'
    // plugin root (which the writer refuses, so nothing is stamped). Without this
    // the canonicalization write fires in the fenced run and returns before the
    // stamp — the case would then re-prove the previous one.
    assert.equal(materializeFromProjectMemoryWrite(cwd, memoryDoc)?.status, 'skipped',
      'fixture guard: a source checkout is refused by the writer, so nothing is stamped');

    const aside = `${statePath}.aside`;
    const before = fs.readFileSync(statePath, 'utf8');
    fs.renameSync(statePath, aside);
    fs.symlinkSync(aside, statePath);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before,
      'fixture guard: reads still resolve through the link, so materialization runs and reaches its stamp');

    const out = withInstalledPluginRoot(() => materializeFromProjectMemoryWrite(cwd, memoryDoc));
    assert.equal(out?.status, 'failed',
      'a materialization whose stamp was refused must not be reported as materialized');
    assert.ok(out?.result, 'and the refusal carries the materialize result, so this is the STAMP write, not the canonicalization');
    assert.ok((out?.result?.written ?? 0) > 0, 'fixture guard: assets really were written');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).materializedAt, undefined,
      'fixture guard: the stamp really was refused');
  });
});

// Every way materializeProjectAssets can refuse, reached through the
// project-memory write path — the highest-frequency materialization trigger in
// the product (every `.traffic-one/product.md` edit), and therefore the most
// likely one to be running while a plugin tree is mid-install or mid-rsync.
const REFUSALS = [
  {
    name: "'unverified' root: an unrelated directory",
    expect: 'carries neither a compiled runtime',
    build: (dir: string) => { fs.writeFileSync(path.join(dir, 'README.txt'), 'not a plugin\n', 'utf8'); },
  },
  {
    name: "'source' root: the Traffic One authoring checkout (the reported incident)",
    expect: 'SOURCE checkout',
    build: (dir: string) => {
      fs.mkdirSync(path.join(dir, 'src', 'gen', 'static'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'gen', 'static', 'plugin-instructions.md'), '# stub\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    },
  },
  {
    name: "'installed' root that resolves no rule and no skill (a partial install)",
    // Read off the counts rather than hedged: this id also serves "45 rules
    // resolved, no skills", which the old wording described as zero of both.
    expect: 'resolved nothing at all — not one rule file, not one skill',
    build: (dir: string) => {
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scripts', 'hook-runtime.cjs'), '// stub\n', 'utf8');
      fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'rules', 'unrelated.md'), '# not a Traffic One rule\n', 'utf8');
    },
  },
] as const;

test("materializeFromProjectMemoryWrite: every plugin-root refusal preserves existing rules/skills, reports 'skipped' (not the generic null), and never stamps", () => {
  for (const refusal of REFUSALS) {
    // No materializedStack → isMaterialized(state) is false, so the
    // already-materialized short-circuit is skipped and materializeProjectAssets
    // is actually invoked — the same call this whole item guards.
    withProject({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', onboardingComplete: true,
    }, (cwd) => {
      const t1 = path.join(cwd, '.traffic-one');
      const rulePath = path.join(t1, 'rules', 'common', 'auth-gate.md');
      const skillPath = path.join(t1, 'skills', 'project-memory', 'SKILL.md');
      const manifestPath = path.join(t1, 'manifest.json');
      fs.mkdirSync(path.dirname(rulePath), { recursive: true });
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.writeFileSync(rulePath, '# Auth gate rule\nbody\n', 'utf8');
      fs.writeFileSync(skillPath, `# project-memory\n\n${GENERATED_MARKER}\n`, 'utf8');
      fs.writeFileSync(manifestPath, JSON.stringify({
        generatedBy: 'traffic-one', stack: 'default', rules: ['rules/common/auth-gate.md'], skills: ['project-memory'],
      }), 'utf8');
      const before = {
        rule: fs.readFileSync(rulePath, 'utf8'),
        skill: fs.readFileSync(skillPath, 'utf8'),
        manifest: fs.readFileSync(manifestPath, 'utf8'),
      };

      const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cfw-refusal-'));
      refusal.build(brokenRoot);
      const prevPlugin = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
      process.env.TRAFFIC_ONE_PLUGIN_ROOT = brokenRoot;
      let out;
      try {
        out = materializeFromProjectMemoryWrite(cwd, path.join(t1, 'product.md'));
      } finally {
        if (prevPlugin === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = prevPlugin;
        fs.rmSync(brokenRoot, { recursive: true, force: true });
      }

      assert.ok(out, `${refusal.name}: a diagnostic outcome is returned, not the generic "nothing happened" null`);
      assert.equal(out?.status, 'skipped', refusal.name);
      assert.equal(out?.result?.removed, 0, `${refusal.name}: nothing deleted`);
      assert.equal(out?.result?.written, 0, `${refusal.name}: nothing written`);
      assert.ok(out?.context.includes('doctor'), `${refusal.name}: points at the doctor command`);
      assert.ok(out?.context.includes(refusal.expect), `${refusal.name}: explains the cause`);
      assert.equal(fs.readFileSync(rulePath, 'utf8'), before.rule, `${refusal.name}: rule is byte-identical`);
      assert.equal(fs.readFileSync(skillPath, 'utf8'), before.skill, `${refusal.name}: skill is byte-identical`);
      assert.equal(fs.readFileSync(manifestPath, 'utf8'), before.manifest, `${refusal.name}: manifest is byte-identical`);
      const state = JSON.parse(fs.readFileSync(path.join(t1, '.one.json'), 'utf8'));
      assert.equal('materializedAt' in state, false, `${refusal.name}: materializedAt is never stamped when materialization was refused`);
      assert.equal('materializedStack' in state, false, `${refusal.name}: materializedStack is never stamped either`);
    });
  }
});

test('materializeFromToolInputHints: null when no tool-input hints resolve to a project', () => {
  withProject({ stack: 'default', onboardingComplete: true }, (cwd) => {
    assert.equal(materializeFromToolInputHints(cwd, { command: 'ls -la' }), null);
    assert.equal(materializeFromToolInputHints(cwd, {}), null);
  });
});

test('materializeFromToolInputHints gives a legacy Cursor capture no special handling', () => {
  withProject({
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none',
  }, (cwd) => {
    const legacy = path.join(cwd, '.traffic-one', 'cursor-models.json');
    fs.writeFileSync(legacy, JSON.stringify({ models: ['composer-2.5-fast'] }), 'utf8');
    const out = materializeFromToolInputHints(cwd, { command: 'touch .traffic-one/cursor-models.json' });
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    assert.deepEqual(raw, { models: ['composer-2.5-fast'] });
    assert.doesNotMatch((out && out.systemMessage) || '', /model choice|required model/i);
  });
});

test('materializeFromToolInputHints: reporter is invoked for a resolved already-materialized root (returns null)', () => {
  // a fully-materialized project so materializeProjectIfNeeded early-returns null (no heavy writer)
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-cfw2-')));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    const t1 = path.join(dir, '.traffic-one');
    const state = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none' };
    // The whole declared set: a manifest short of it is a truncated project, which
    // convergence now re-materializes instead of short-circuiting.
    writeMaterializedContent(dir, { state });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'see agents', 'utf8');
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify(state), 'utf8');
    let reported = 0;
    const out = materializeFromToolInputHints(dir, { file_path: path.join(dir, 'apps', 'web', 'x.ts') }, { reportOneMcp: () => { reported += 1; } });
    assert.equal(out, null); // already materialized → nothing to converge
    assert.equal(reported, 1); // reporter fires once for the resolved root
  } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
