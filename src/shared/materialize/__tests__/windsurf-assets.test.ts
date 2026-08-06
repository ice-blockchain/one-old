import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GENERATED_MARKER } from '../generated';
import { writeWindsurfHostAssets } from '../windsurf-assets';
import { WINDSURF_RULES_REL } from '../../windsurf-rules';

const LEGACY_WINDSURF_SKILLS_REL = path.join('.windsurf', 'skills');

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
  fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'agents', 'senior-architect.md'), '# Senior Architect\n\nPLAN_READY\n', 'utf8');
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

    // Still swept on a run that DID resolve the agents tree, so a retired role
    // cannot leave a stale contract behind: restore agents/ with a different role
    // and the old mirror goes.
    fs.mkdirSync(path.join(path.dirname(project), 'plugin', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(project), 'plugin', 'agents', 'senior-backend.md'),
      '# Senior Backend\n\nBody.\n',
      'utf8',
    );
    const renamed = writeWindsurfHostAssets(project, active);
    assert.equal(renamed.skipped, undefined);
    assert.equal(fs.existsSync(roleMirror), false, 'a role the current root no longer ships is still swept');
    assert.equal(
      fs.existsSync(path.join(project, WINDSURF_RULES_REL, '00-agent-senior-backend.md')),
      true,
      'and the role it does ship is mirrored',
    );
  });
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
