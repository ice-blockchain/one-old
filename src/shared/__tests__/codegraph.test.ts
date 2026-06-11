import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('relocateProviderSkills adopts grouped + flat .claude/skills into .traffic-one/skills', async () => {
  const { relocateProviderSkills } = await import('../codegraph');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-provskills-'));
  try {
    // gitnexus layout: grouped under .claude/skills/gitnexus/<name>/SKILL.md
    for (const name of ['gitnexus-guide', 'gitnexus-cli']) {
      fs.mkdirSync(path.join(dir, '.claude', 'skills', 'gitnexus', name), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'skills', 'gitnexus', name, 'SKILL.md'), `# ${name}\n`, 'utf8');
    }
    // flat layout + a pre-existing destination that must not be clobbered
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'flat-skill'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'skills', 'flat-skill', 'SKILL.md'), '# flat\n', 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one', 'skills', 'gitnexus-cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'skills', 'gitnexus-cli', 'SKILL.md'), '# existing\n', 'utf8');

    const relocated = relocateProviderSkills(dir);
    assert.deepEqual(relocated, ['flat-skill', 'gitnexus-guide']);
    assert.ok(fs.existsSync(path.join(dir, '.traffic-one', 'skills', 'gitnexus-guide', 'SKILL.md')));
    assert.equal(fs.readFileSync(path.join(dir, '.traffic-one', 'skills', 'gitnexus-cli', 'SKILL.md'), 'utf8'), '# existing\n', 'existing skill preserved');
    // the un-relocated duplicate stays under .claude/skills; emptied dirs are swept
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'gitnexus', 'gitnexus-cli', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills', 'flat-skill')));

    // a fully-adopted tree sweeps .claude/skills (and .claude) away
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 't1-provskills2-'));
    try {
      fs.mkdirSync(path.join(clean, '.claude', 'skills', 'gitnexus', 'gitnexus-x'), { recursive: true });
      fs.writeFileSync(path.join(clean, '.claude', 'skills', 'gitnexus', 'gitnexus-x', 'SKILL.md'), '# x\n', 'utf8');
      assert.deepEqual(relocateProviderSkills(clean), ['gitnexus-x']);
      assert.ok(!fs.existsSync(path.join(clean, '.claude')), '.claude removed when emptied');
    } finally {
      fs.rmSync(clean, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
