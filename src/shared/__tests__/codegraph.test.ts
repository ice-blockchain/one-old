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

function withDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cg-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function write(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
}
function setSec(p: string, sec: number): void { fs.utimesSync(p, sec, sec); }

const EMPTY_GRAPH = JSON.stringify({ nodes: [], links: [] });
const POPULATED_GRAPH = JSON.stringify({ nodes: [{ id: 'a' }], links: [] });

test('codeGraphIndexIsStale: a newer source file marks the index stale; older does not', async () => {
  const { codeGraphIndexIsStale } = await import('../codegraph');
  withDir((dir) => {
    const indexSec = 1_000_000;
    const indexMtimeMs = indexSec * 1000;
    write(path.join(dir, 'src', 'old.ts'), 'x');
    setSec(path.join(dir, 'src', 'old.ts'), indexSec - 500); // older than index
    assert.equal(codeGraphIndexIsStale(dir, indexMtimeMs), false);
    write(path.join(dir, 'src', 'new.ts'), 'x');
    setSec(path.join(dir, 'src', 'new.ts'), indexSec + 500); // newer than index
    assert.equal(codeGraphIndexIsStale(dir, indexMtimeMs), true);
  });
});

test('codeGraphIndexIsStale: newer files in skip-dirs do NOT count (graph output / node_modules cannot self-defeat)', async () => {
  const { codeGraphIndexIsStale } = await import('../codegraph');
  withDir((dir) => {
    const indexSec = 1_000_000;
    for (const rel of [
      ['.traffic-one', 'graphify-out', 'graph.json'],
      ['.traffic-one', '.gitnexus', 'meta.json'],
      ['node_modules', 'pkg', 'index.js'],
      ['dist', 'bundle.js'],
      ['.git', 'HEAD'],
    ]) {
      const p = path.join(dir, ...rel);
      write(p, 'x');
      setSec(p, indexSec + 9000); // much newer than the index, but in excluded trees
    }
    assert.equal(codeGraphIndexIsStale(dir, indexSec * 1000), false);
  });
});

test('codeGraphIndexIsStale: unknown index mtime (0) is never stale', async () => {
  const { codeGraphIndexIsStale } = await import('../codegraph');
  withDir((dir) => {
    write(path.join(dir, 'src', 'a.ts'), 'x');
    assert.equal(codeGraphIndexIsStale(dir, 0), false);
  });
});

test('codeGraphIsEmpty dispatches by provider; unknown → false', async () => {
  const { codeGraphIsEmpty, graphifyGraphIsEmpty, gitnexusGraphIsEmpty } = await import('../codegraph');
  withDir((dir) => {
    // graphify: graph.json node count
    write(path.join(dir, '.traffic-one', 'graphify-out', 'graph.json'), EMPTY_GRAPH);
    assert.equal(codeGraphIsEmpty(dir, 'graphify'), true);
    assert.equal(graphifyGraphIsEmpty(dir), true);
    write(path.join(dir, '.traffic-one', 'graphify-out', 'graph.json'), POPULATED_GRAPH);
    assert.equal(codeGraphIsEmpty(dir, 'graphify'), false);
    // gitnexus: meta.json stats (moved here from the runner — still works)
    write(path.join(dir, '.traffic-one', '.gitnexus', 'meta.json'), JSON.stringify({ stats: { files: 0, nodes: 0 } }));
    assert.equal(codeGraphIsEmpty(dir, 'gitnexus'), true);
    assert.equal(gitnexusGraphIsEmpty(dir), true);
    write(path.join(dir, '.traffic-one', '.gitnexus', 'meta.json'), JSON.stringify({ stats: { files: 12, nodes: 80 } }));
    assert.equal(codeGraphIsEmpty(dir, 'gitnexus'), false);
    // unknown provider → false (can't tell → don't force a rebuild)
    assert.equal(codeGraphIsEmpty(dir, 'nope'), false);
  });
});

test('CODE_GRAPH_SCAN_EXCLUDES keeps plugin/host docs out of the scan', async () => {
  const { CODE_GRAPH_SCAN_EXCLUDES } = await import('../codegraph');
  assert.ok(CODE_GRAPH_SCAN_EXCLUDES.includes('.traffic-one'), '.traffic-one must be excluded');
  for (const p of ['.claude', '.cursor', 'AGENTS.md', 'CLAUDE.md']) {
    assert.ok(CODE_GRAPH_SCAN_EXCLUDES.includes(p), `${p} must be excluded`);
  }
});

test('applyCodeGraphScanIgnore: creates a scoped ignore file then removes it on restore', async () => {
  const { applyCodeGraphScanIgnore } = await import('../codegraph');
  withDir((dir) => {
    const ip = path.join(dir, '.gitnexusignore');
    assert.equal(fs.existsSync(ip), false);
    const restore = applyCodeGraphScanIgnore(dir, '.gitnexusignore', ['.traffic-one', 'AGENTS.md']);
    // during the scan window the patterns are present
    const during = fs.readFileSync(ip, 'utf8');
    assert.match(during, /^\.traffic-one$/m);
    assert.match(during, /^AGENTS\.md$/m);
    restore();
    // created-by-us → removed on restore (no permanent root pollution)
    assert.equal(fs.existsSync(ip), false);
  });
});

test('applyCodeGraphScanIgnore: appends missing patterns to a user file, restores original content', async () => {
  const { applyCodeGraphScanIgnore } = await import('../codegraph');
  withDir((dir) => {
    const ip = path.join(dir, '.gitnexusignore');
    const original = '# my rules\nsecret.env\n';
    fs.writeFileSync(ip, original, 'utf8');
    const restore = applyCodeGraphScanIgnore(dir, '.gitnexusignore', ['.traffic-one', 'secret.env']);
    const during = fs.readFileSync(ip, 'utf8');
    assert.match(during, /secret\.env/);       // user's pattern preserved
    assert.match(during, /^\.traffic-one$/m);   // missing one appended
    restore();
    // pre-existing user file is restored byte-for-byte
    assert.equal(fs.readFileSync(ip, 'utf8'), original);
  });
});

test('applyCodeGraphScanIgnore: no-op when all patterns already present', async () => {
  const { applyCodeGraphScanIgnore } = await import('../codegraph');
  withDir((dir) => {
    const ip = path.join(dir, '.gitnexusignore');
    const original = '.traffic-one\nnode_modules\n';
    fs.writeFileSync(ip, original, 'utf8');
    const restore = applyCodeGraphScanIgnore(dir, '.gitnexusignore', ['.traffic-one']);
    assert.equal(fs.readFileSync(ip, 'utf8'), original); // untouched
    restore();
    assert.equal(fs.readFileSync(ip, 'utf8'), original); // still untouched
  });
});

test('applyCodeGraphScanIgnore: graphify seeds a fresh .graphifyignore from .gitignore (so it does not shadow it)', async () => {
  const { applyCodeGraphScanIgnore } = await import('../codegraph');
  withDir((dir) => {
    // graphify reads .graphifyignore INSTEAD of .gitignore per-dir; a fresh one
    // must carry the user's .gitignore patterns + ours.
    fs.writeFileSync(path.join(dir, '.gitignore'), 'my-secrets/\n*.log\n', 'utf8');
    const gp = path.join(dir, '.graphifyignore');
    assert.equal(fs.existsSync(gp), false);
    const restore = applyCodeGraphScanIgnore(dir, '.graphifyignore', ['.traffic-one'], { seedFromGitignore: true });
    const during = fs.readFileSync(gp, 'utf8');
    assert.match(during, /my-secrets\//);   // user's .gitignore carried over
    assert.match(during, /\*\.log/);
    assert.match(during, /^\.traffic-one$/m); // + our exclude
    restore();
    assert.equal(fs.existsSync(gp), false);   // created-by-us → removed
    // the .gitignore itself is never touched
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'my-secrets/\n*.log\n');
  });
});

test('wouldIgnoreAllSource: true only when source EXISTS and every file is ignored', async () => {
  const { wouldIgnoreAllSource } = await import('../codegraph');
  withDir((dir) => {
    write(path.join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
    write(path.join(dir, 'main.ts'), 'export const y = 2;\n');
    assert.equal(wouldIgnoreAllSource(dir, []), false);            // nothing ignored
    assert.equal(wouldIgnoreAllSource(dir, ['src/']), false);      // main.ts survives
    assert.equal(wouldIgnoreAllSource(dir, ['*.ts']), true);       // slashless glob, any depth → both hidden
    assert.equal(wouldIgnoreAllSource(dir, ['*', '!keep.md']), true); // allowlist .gitignore (negation ignored)
    assert.equal(wouldIgnoreAllSource(dir, ['/src', '/main.ts']), true); // root-anchored, covers all
  });
  withDir((dir) => {
    // Built-in-skipped trees are not "source" — a repo of only node_modules has none.
    write(path.join(dir, 'node_modules', 'pkg', 'a.ts'), 'export {};\n');
    assert.equal(wouldIgnoreAllSource(dir, ['*']), false); // no candidate source at all
  });
});

test('applyCodeGraphScanIgnore drops a .gitignore seed that would hide ALL source', async () => {
  const { applyCodeGraphScanIgnore } = await import('../codegraph');
  withDir((dir) => {
    write(path.join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
    // A degenerate .gitignore whose pattern covers the only source dir.
    fs.writeFileSync(path.join(dir, '.gitignore'), 'src/\n', 'utf8');
    const gp = path.join(dir, '.graphifyignore');
    const restore = applyCodeGraphScanIgnore(dir, '.graphifyignore', ['.traffic-one'], { seedFromGitignore: true });
    const during = fs.readFileSync(gp, 'utf8');
    assert.doesNotMatch(during, /^src\/?$/m, 'source-hiding .gitignore pattern must be dropped');
    assert.match(during, /^\.traffic-one$/m, 'our own (source-safe) exclude is still written');
    restore();
    assert.equal(fs.existsSync(gp), false);
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'src/\n'); // .gitignore untouched
  });
});
