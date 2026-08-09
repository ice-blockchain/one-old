import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GENERATED_MARKER } from '../generated';
import { DECLARED_ROLE_DOC_IDS, writeWindsurfHostAssets } from '../windsurf-assets';
import { WINDSURF_RULES_REL } from '../../windsurf-rules';

const LEGACY_WINDSURF_SKILLS_REL = path.join('.windsurf', 'skills');

// The fixture ships the WHOLE declared roster, not a single role doc. A
// one-of-seven `agents/` is now the torn shape (windsurf-assets.ts
// roleRuleDocs), so a fixture that stayed short would characterize the tear
// this file is here to prove is caught — and every sweep assertion below would
// pass for the wrong reason.
function writeRoleDocs(plugin: string, roles: readonly string[]): void {
  fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
  for (const role of roles) {
    fs.writeFileSync(
      path.join(plugin, 'agents', `${role}.md`),
      `# ${role}\n\n${role === 'senior-architect' ? 'PLAN_READY' : 'Body.'}\n`,
      'utf8',
    );
  }
}

function withPlugin(fn: (project: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-assets-'));
  const plugin = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(plugin, 'rules', 'common'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'rules', 'common', 'auth-gate.md'), '# Auth Gate\n\nAuth body.\n', 'utf8');
  fs.mkdirSync(path.join(plugin, 'rules', 'frontend', 'react'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'rules', 'frontend', 'react', 'components.md'), [
    '---',
    'paths:',
    '  - "src/components/**"',
    '---',
    '',
    '# Components',
    '',
    'Component body.',
    '',
  ].join('\n'), 'utf8');
  writeRoleDocs(plugin, DECLARED_ROLE_DOC_IDS);
  fs.mkdirSync(path.join(plugin, 'skills-catalog', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills-catalog', 'project-memory', 'SKILL.md'), '---\nname: project-memory\ndescription: Memory\n---\n# Skill\n', 'utf8');
  fs.mkdirSync(project, { recursive: true });
  const previousRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  try {
    fn(project);
  } finally {
    if (previousRoot === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT;
    else process.env.TRAFFIC_ONE_PLUGIN_ROOT = previousRoot;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('writeWindsurfHostAssets mirrors active rules and role docs; skills stay canonical under .traffic-one', () => {
  withPlugin((project) => {
    const result = writeWindsurfHostAssets(project, ['rules/common/auth-gate.md', 'rules/frontend/react/components.md']);
    assert.equal(result.skills, 0);
    assert.ok(result.rules >= 3);

    const auth = fs.readFileSync(path.join(project, WINDSURF_RULES_REL, 'auth-required.md'), 'utf8');
    assert.match(auth, /^trigger: always_on$/m);
    const components = fs.readFileSync(path.join(project, WINDSURF_RULES_REL, 'react-components.md'), 'utf8');
    assert.match(components, /^trigger: glob$/m);
    assert.match(components, /^globs: /m);
    const architect = fs.readFileSync(path.join(project, WINDSURF_RULES_REL, '00-agent-senior-architect.md'), 'utf8');
    assert.match(architect, /PLAN_READY/);

    assert.equal(fs.existsSync(path.join(project, LEGACY_WINDSURF_SKILLS_REL)), false);

    assert.equal(fs.existsSync(path.join(project, '.windsurf', 'hooks.json')), false);
  });
});

// `docs` is the keep-list handed to cleanupGeneratedRuleFiles, so an empty
// `docs` means "keep nothing" and every generated file in the mirror is swept —
// and for Cascade the mirror is the ONLY copy, since Windsurf cannot read
// .traffic-one/rules. This writer therefore needs its own refusal instead of
// inheriting materializeProjectAssets' one by call-graph accident: it is
// exported, and nothing stops a future caller from reaching it directly.
test('writeWindsurfHostAssets refuses on its own when the plugin root resolves no rule and no role doc', () => {
  for (const shape of ['empty root', 'source checkout (rules under src/modules/**)'] as const) {
    withPlugin((project) => {
      const good = writeWindsurfHostAssets(project, ['rules/common/auth-gate.md', 'rules/frontend/react/components.md']);
      assert.equal(good.skipped, undefined, `${shape}: setup must write the mirror`);
      assert.ok(good.rules >= 3);

      // A manual file and a legacy generated skill dir, to prove a refused run
      // sweeps neither.
      const manualRule = path.join(project, WINDSURF_RULES_REL, 'manual.md');
      fs.writeFileSync(manualRule, '# manual\n', 'utf8');
      const legacySkill = path.join(project, LEGACY_WINDSURF_SKILLS_REL, 'old-skill');
      fs.mkdirSync(legacySkill, { recursive: true });
      fs.writeFileSync(path.join(legacySkill, 'SKILL.md'), `${GENERATED_MARKER}\n# old\n`, 'utf8');

      const mirrorDir = path.join(project, WINDSURF_RULES_REL);
      const before = new Map(fs.readdirSync(mirrorDir).sort().map(
        (name) => [name, fs.readFileSync(path.join(mirrorDir, name), 'utf8')] as const,
      ));
      assert.ok(before.size >= 4, `${shape}: the mirror carries generated rules and role docs`);

      const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-broken-'));
      if (shape !== 'empty root') {
        // Content present, but at its SOURCE paths, so `<root>/rules/**` and
        // `<root>/agents/**` resolve nothing — the reported incident's root shape.
        fs.mkdirSync(path.join(brokenRoot, 'src', 'modules', 'rules', 'rules', 'common'), { recursive: true });
        fs.writeFileSync(path.join(brokenRoot, 'src', 'modules', 'rules', 'rules', 'common', 'auth-gate.md'), '# Auth Gate\n', 'utf8');
        fs.mkdirSync(path.join(brokenRoot, 'src', 'modules', 'senior-architect'), { recursive: true });
        fs.writeFileSync(path.join(brokenRoot, 'src', 'modules', 'senior-architect', 'agent.md'), '# Senior Architect\n', 'utf8');
      }
      const previousRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
      process.env.TRAFFIC_ONE_PLUGIN_ROOT = brokenRoot;
      let refused;
      try {
        refused = writeWindsurfHostAssets(project, ['rules/common/auth-gate.md', 'rules/frontend/react/components.md']);
      } finally {
        if (previousRoot === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT;
        else process.env.TRAFFIC_ONE_PLUGIN_ROOT = previousRoot;
        fs.rmSync(brokenRoot, { recursive: true, force: true });
      }

      assert.equal(refused.skipped, 'windsurf-content-empty', shape);
      assert.deepEqual(
        { rules: refused.rules, skills: refused.skills, written: refused.written, removed: refused.removed },
        { rules: 0, skills: 0, written: 0, removed: 0 },
        `${shape}: nothing resolved, nothing written, nothing removed`,
      );

      const after = new Map(fs.readdirSync(mirrorDir).sort().map(
        (name) => [name, fs.readFileSync(path.join(mirrorDir, name), 'utf8')] as const,
      ));
      assert.deepEqual([...after.keys()], [...before.keys()], `${shape}: the mirror still holds every generated file`);
      for (const [name, body] of before) {
        assert.equal(after.get(name), body, `${shape}: ${name} is byte-identical`);
      }
      assert.equal(fs.existsSync(manualRule), true, `${shape}: a manual rule is never swept`);
      assert.equal(fs.existsSync(path.join(legacySkill, 'SKILL.md')), true, `${shape}: a refused run performs no legacy sweep either`);

      // Self-healing: the same call against a resolvable root converges again.
      const recovered = writeWindsurfHostAssets(project, ['rules/common/auth-gate.md', 'rules/frontend/react/components.md']);
      assert.equal(recovered.skipped, undefined, `${shape}: the refusal is transient, not sticky`);
      assert.equal(recovered.rules, good.rules);
    });
  }
});

// The PARTIAL shape, which the empty-content refusal above cannot see. Both
// halves of the keep-list are resolved independently, so a root that supplies
// one of them and not the other still produces a non-empty `docs` — and the
// sweep then deletes every mirror belonging to the half that came back short.
// `.devin/rules` is the only copy Cascade reads, and a materialization that gets
// this far reports success and stamps the project, so nothing retries.
test('writeWindsurfHostAssets: a root missing agents/ keeps the mirrored role docs instead of sweeping them', () => {
  withPlugin((project) => {
    const active = ['rules/common/auth-gate.md', 'rules/frontend/react/components.md'];
    const good = writeWindsurfHostAssets(project, active);
    assert.equal(good.skipped, undefined);
    const roleMirror = path.join(project, WINDSURF_RULES_REL, '00-agent-senior-architect.md');
    const roleBytes = fs.readFileSync(roleMirror, 'utf8');
    const ruleBytes = fs.readFileSync(path.join(project, WINDSURF_RULES_REL, 'auth-required.md'), 'utf8');

    // The tear: `rules/**` is whole, `agents/**` is gone. materializeProjectAssets
    // does not refuse this — agent docs are not part of the rule/skill candidate
    // set its completeness check reads — so it reaches this writer for real.
    fs.rmSync(path.join(path.dirname(project), 'plugin', 'agents'), { recursive: true, force: true });

    const torn = writeWindsurfHostAssets(project, active);

    assert.equal(torn.skipped, undefined, 'the rule half still converges');
    assert.equal(fs.existsSync(roleMirror), true, 'the mirrored role contract is NOT swept');
    assert.equal(fs.readFileSync(roleMirror, 'utf8'), roleBytes, 'and is byte-identical');
    assert.equal(fs.readFileSync(path.join(project, WINDSURF_RULES_REL, 'auth-required.md'), 'utf8'), ruleBytes);

    // Still swept on a run that DID resolve the whole agents tree, so a role a
    // PAST release shipped cannot leave a stale contract behind forever. The
    // retirement is spelled the way a real one arrives: the role is absent from
    // the roster AND from the tree (one `npm run gen` from one commit emits
    // both), so nothing reads as missing and the sweep is authorized.
    writeRoleDocs(path.join(path.dirname(project), 'plugin'), DECLARED_ROLE_DOC_IDS);
    const retiredMirror = path.join(project, WINDSURF_RULES_REL, '00-agent-retired-by-an-upgrade.md');
    fs.writeFileSync(
      retiredMirror,
      `---\ntrigger: always_on\n---\n${GENERATED_MARKER}\n<!-- GENERATED FROM: agents/retired-by-an-upgrade.md -->\n\n# gone\n`,
      'utf8',
    );

    const restored = writeWindsurfHostAssets(project, active);
    assert.equal(restored.skipped, undefined);
    assert.equal(fs.existsSync(retiredMirror), false, 'a role neither shipped nor declared is still swept');
    assert.equal(fs.existsSync(roleMirror), true, 'and a role that IS declared keeps its mirror');
  });
});

// RESIDUAL (1), closed. The absent-agents/ case above was already handled; a
// PARTIALLY copied one was not, and it is the shape an interrupted rsync
// actually produces. Measured before the fix on a root torn to 3 of 7 role docs
// against a project mirrored from a whole root: the run was not refused,
// `removed` was 8, and eight role-contract mirrors were deleted from the only
// copy Cascade reads.
//
// The keep-list is what makes it silent: `docs` stays non-empty from the rule
// half, so the empty-content refusal cannot fire, and "3 entries came back" is
// indistinguishable from "this release ships 3" while the directory is its own
// authority. DECLARED_ROLE_DOC_IDS is that authority moved off the tree.
test('writeWindsurfHostAssets: a PARTIALLY copied agents/ does not authorize the role-mirror sweep', () => {
  withPlugin((project) => {
    const active = ['rules/common/auth-gate.md', 'rules/frontend/react/components.md'];
    const good = writeWindsurfHostAssets(project, active);
    assert.equal(good.skipped, undefined, 'the whole root must write the mirror first');

    const mirrorDir = path.join(project, WINDSURF_RULES_REL);
    const roleMirrors = (): string[] => fs.readdirSync(mirrorDir).filter((n) => n.startsWith('00-agent-')).sort();
    const before = roleMirrors();
    // The baseline that stops this passing vacuously: if the fixture ever stopped
    // mirroring role docs at all, every "not swept" assertion below would hold
    // over an empty set.
    assert.equal(
      before.length,
      DECLARED_ROLE_DOC_IDS.length,
      `every declared role must be mirrored first, got ${before.join(', ')}`,
    );
    const bytes = new Map(before.map((n) => [n, fs.readFileSync(path.join(mirrorDir, n), 'utf8')] as const));

    // The tear: keep 3 of 7, the ordinary interrupted-copy shape.
    const agentsDir = path.join(path.dirname(project), 'plugin', 'agents');
    const kept = DECLARED_ROLE_DOC_IDS.slice(0, 3);
    for (const role of DECLARED_ROLE_DOC_IDS) {
      if (!kept.includes(role)) fs.rmSync(path.join(agentsDir, `${role}.md`), { force: true });
    }

    const torn = writeWindsurfHostAssets(project, active);

    assert.equal(torn.skipped, undefined, 'the rule half still converges — this is not a whole-run refusal');
    assert.equal(torn.removed, 0, 'a keep-list the root could not fill may not authorize one delete');
    assert.deepEqual(roleMirrors(), before, 'every mirrored role contract survives a torn agents/');
    for (const [name, body] of bytes) {
      assert.equal(fs.readFileSync(path.join(mirrorDir, name), 'utf8'), body, `${name} is byte-identical`);
    }
  });
});

// Found by MOVE-ASIDE-PLUS-LINK on the read path: `roleRuleDocs` filtered with
// the Dirent's own `isFile()`, which reflects lstat, so an installed root whose
// `agents/*.md` are SYMLINKS resolved 0 of 7 role docs. Harmless while nothing
// counted them; once the shortfall became the torn signal it would report such a
// root as permanently torn and stop the role-mirror sweep forever.
//
// Not a hypothetical layout: paths.ts classifyPluginRootLayout stats through
// links on purpose, "so an installed tree may symlink its runtime", and the
// fixtures in this suite reach the real content trees the same way.
test('writeWindsurfHostAssets resolves role docs that are symlinks, not just regular files', () => {
  withPlugin((project) => {
    const agentsDir = path.join(path.dirname(project), 'plugin', 'agents');
    for (const role of DECLARED_ROLE_DOC_IDS) {
      const link = path.join(agentsDir, `${role}.md`);
      const real = path.join(agentsDir, `${role}.md.real`);
      fs.renameSync(link, real);
      fs.symlinkSync(real, link);
      // The fixture guard the technique requires: a DANGLING link would make the
      // reader throw on its own precondition and this test would prove nothing.
      assert.ok(fs.readFileSync(link, 'utf8').includes(role), `fixture guard: ${role}.md reads through the link`);
    }

    const result = writeWindsurfHostAssets(project, ['rules/common/auth-gate.md']);

    assert.equal(result.skipped, undefined, 'a symlinked agents/ tree is a complete one');
    const mirrored = fs.readdirSync(path.join(project, WINDSURF_RULES_REL))
      .filter((n) => n.startsWith('00-agent-')).sort();
    assert.equal(
      mirrored.length,
      DECLARED_ROLE_DOC_IDS.length,
      `every symlinked role doc must resolve, got ${mirrored.join(', ')}`,
    );
    assert.match(
      fs.readFileSync(path.join(project, WINDSURF_RULES_REL, '00-agent-senior-architect.md'), 'utf8'),
      /PLAN_READY/,
      'and the body comes from the link target, not an empty placeholder',
    );
  });
});

// The tripwire that has to fail FIRST, in the sense content-completeness.test.ts
// uses: DECLARED_ROLE_DOC_IDS is compared against what `npm run gen` actually
// emits into `agents/` (one doc per content module declaring an agent in its
// module.json — src/gen/emit/agents.ts). A role added to the roster without its
// module, or a module retired without its roster entry, would otherwise make the
// completeness check above fire on a HEALTHY install for every Windsurf project.
test('DECLARED_ROLE_DOC_IDS is exactly the set of modules that ship an agent doc', () => {
  const modulesDir = path.resolve(__dirname, '..', '..', '..', 'modules');
  const shipped = fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(modulesDir, entry.name, 'agent.md')))
    .map((entry) => entry.name)
    .sort();
  assert.ok(shipped.length > 5, `expected the real roster, got ${shipped.length}`);
  assert.deepEqual(
    [...DECLARED_ROLE_DOC_IDS].sort(),
    shipped,
    'the declared roster and the emitted agents/ tree must shrink and grow together',
  );
});

test('writeWindsurfHostAssets: a rule the root cannot supply refuses instead of shortening the keep-list', () => {
  withPlugin((project) => {
    const active = ['rules/common/auth-gate.md', 'rules/frontend/react/components.md'];
    const good = writeWindsurfHostAssets(project, active);
    assert.equal(good.skipped, undefined);
    const mirrorDir = path.join(project, WINDSURF_RULES_REL);
    const before = new Map(fs.readdirSync(mirrorDir).sort().map(
      (name) => [name, fs.readFileSync(path.join(mirrorDir, name), 'utf8')] as const,
    ));

    // One of the two requested rules disappears from the root — the mid-rsync
    // shape, and the one that made the old keep-list short by exactly the mirror
    // it then deleted.
    fs.rmSync(path.join(path.dirname(project), 'plugin', 'rules', 'frontend', 'react', 'components.md'), { force: true });

    const torn = writeWindsurfHostAssets(project, active);

    assert.equal(torn.skipped, 'windsurf-content-incomplete');
    assert.deepEqual(
      { rules: torn.rules, written: torn.written, removed: torn.removed },
      { rules: 0, written: 0, removed: 0 },
      'nothing written, nothing removed',
    );
    const after = new Map(fs.readdirSync(mirrorDir).sort().map(
      (name) => [name, fs.readFileSync(path.join(mirrorDir, name), 'utf8')] as const,
    ));
    assert.deepEqual([...after.keys()], [...before.keys()], 'the mirror still holds every generated file');
    for (const [name, body] of before) assert.equal(after.get(name), body, `${name} is byte-identical`);
  });
});

test('writeWindsurfHostAssets removes stale generated Windsurf files and legacy skill mirrors only', () => {
  withPlugin((project) => {
    const staleRule = path.join(project, WINDSURF_RULES_REL, 'stale.md');
    const manualRule = path.join(project, WINDSURF_RULES_REL, 'manual.md');
    const staleSkill = path.join(project, LEGACY_WINDSURF_SKILLS_REL, 'old-skill');
    const manualSkill = path.join(project, LEGACY_WINDSURF_SKILLS_REL, 'manual-skill');
    fs.mkdirSync(path.dirname(staleRule), { recursive: true });
    fs.writeFileSync(staleRule, `${GENERATED_MARKER}\n# stale\n`, 'utf8');
    fs.writeFileSync(manualRule, '# manual\n', 'utf8');
    fs.mkdirSync(staleSkill, { recursive: true });
    fs.writeFileSync(path.join(staleSkill, 'SKILL.md'), `${GENERATED_MARKER}\n# old\n`, 'utf8');
    fs.mkdirSync(manualSkill, { recursive: true });
    fs.writeFileSync(path.join(manualSkill, 'SKILL.md'), '# manual\n', 'utf8');

    const result = writeWindsurfHostAssets(project, ['rules/common/auth-gate.md']);
    assert.ok(result.removed >= 2);
    assert.equal(fs.existsSync(staleRule), false);
    assert.equal(fs.existsSync(staleSkill), false);
    assert.equal(fs.existsSync(manualSkill), true);
    assert.equal(fs.existsSync(manualRule), true);
  });
});
