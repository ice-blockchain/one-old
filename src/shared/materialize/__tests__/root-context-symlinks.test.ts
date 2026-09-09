// Root AGENTS.md / CLAUDE.md symlink rules (Phase 6).
//
// Three rules, each of which used to be false:
//
//   1. A symlink at AGENTS.md is user-authored unless its target isGenerated.
//      writeRootAgents used to skip isGenerated for any link and replace it.
//   2. Only replace a CLAUDE.md link whose target isGenerated.
//   3. Never delete a file a sibling link points at. In new-project mode the
//      previous shape was: preserveManualRootContext deleted CLAUDE.md while
//      AGENTS.md still linked at it, then writeRootClaude created
//      CLAUDE.md -> AGENTS.md (ELOOP; isGenerated fails; every hook rematerializes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GENERATED_MARKER } from '../generated';
import { preserveManualRootContext, writeRootAgents, writeRootClaude } from '../render-agents';

const USER = '# My notes\n\nDo not touch.\n';
const GENERATED = `# Traffic One Local Agent Context\n\n${GENERATED_MARKER}\n\nkernel\n`;
const GENERATED_NEXT = `# Traffic One Local Agent Context\n\n${GENERATED_MARKER}\n\nkernel v2\n`;
const NEW_PROJECT = { mode: 'new-project' } as const;

function withDir(fn: (dir: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-root-symlink-')));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function link(target: string, dest: string): boolean {
  try {
    fs.symlinkSync(target, dest);
    return true;
  } catch {
    return false;
  }
}

function isLoop(a: string, b: string): boolean {
  try {
    fs.readFileSync(a, 'utf8');
    fs.readFileSync(b, 'utf8');
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ELOOP';
  }
}

// ── 1. AGENTS.md symlink is user-authored unless the target isGenerated ──────

test('writeRootAgents does not replace a user AGENTS.md link whose target is not generated', () => {
  withDir((dir) => {
    const notes = path.join(dir, 'notes.md');
    fs.writeFileSync(notes, USER, 'utf8');
    if (!link('notes.md', path.join(dir, 'AGENTS.md'))) return;
    assert.equal(writeRootAgents(dir, GENERATED), false);
    assert.ok(fs.lstatSync(path.join(dir, 'AGENTS.md')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(dir, 'AGENTS.md')), 'notes.md');
    assert.equal(fs.readFileSync(notes, 'utf8'), USER, 'the target is never written through');
  });
});

test('writeRootAgents does not replace a dangling AGENTS.md link', () => {
  withDir((dir) => {
    if (!link('missing.md', path.join(dir, 'AGENTS.md'))) return;
    assert.equal(writeRootAgents(dir, GENERATED), false);
    assert.ok(fs.lstatSync(path.join(dir, 'AGENTS.md')).isSymbolicLink());
    assert.equal(fs.existsSync(path.join(dir, 'missing.md')), false);
  });
});

test('writeRootAgents does not replace an AGENTS.md link whose target is outside the project', () => {
  withDir((dir) => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-root-symlink-out-')));
    try {
      const victim = path.join(outside, 'authorized_keys');
      fs.writeFileSync(victim, USER, 'utf8');
      if (!link(victim, path.join(dir, 'AGENTS.md'))) return;
      assert.equal(writeRootAgents(dir, GENERATED), false);
      assert.ok(fs.lstatSync(path.join(dir, 'AGENTS.md')).isSymbolicLink());
      assert.equal(fs.readFileSync(victim, 'utf8'), USER);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('writeRootAgents replaces an AGENTS.md link whose target isGenerated, without deleting the target', () => {
  withDir((dir) => {
    const target = path.join(dir, 'generated.md');
    fs.writeFileSync(target, GENERATED, 'utf8');
    if (!link('generated.md', path.join(dir, 'AGENTS.md'))) return;
    assert.equal(writeRootAgents(dir, GENERATED_NEXT), true);
    assert.equal(fs.lstatSync(path.join(dir, 'AGENTS.md')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), GENERATED_NEXT);
    assert.equal(fs.readFileSync(target, 'utf8'), GENERATED, 'unlinking the link does not delete its target');
  });
});

// ── 2. Only replace a CLAUDE.md link whose target isGenerated ────────────────

test('writeRootClaude does not replace a user CLAUDE.md link whose target is not generated', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'notes.md'), USER, 'utf8');
    if (!link('notes.md', path.join(dir, 'CLAUDE.md'))) return;
    assert.equal(writeRootClaude(dir), false);
    assert.ok(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(dir, 'CLAUDE.md')), 'notes.md');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), USER);
  });
});

test('writeRootClaude does not replace a dangling CLAUDE.md link', () => {
  withDir((dir) => {
    if (!link('missing.md', path.join(dir, 'CLAUDE.md'))) return;
    assert.equal(writeRootClaude(dir), false);
    assert.ok(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink());
    assert.equal(fs.existsSync(path.join(dir, 'missing.md')), false);
  });
});

test('writeRootClaude replaces a CLAUDE.md link whose target isGenerated', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), GENERATED, 'utf8');
    const other = path.join(dir, 'other.md');
    fs.writeFileSync(other, GENERATED, 'utf8');
    if (!link('other.md', path.join(dir, 'CLAUDE.md'))) return;
    assert.equal(writeRootClaude(dir), true);
    assert.ok(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(dir, 'CLAUDE.md')), 'AGENTS.md');
    assert.equal(fs.readFileSync(other, 'utf8'), GENERATED, 'the previous target is left intact');
  });
});

test('writeRootClaude leaves the canonical CLAUDE.md -> AGENTS.md link alone', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), GENERATED, 'utf8');
    if (!link('AGENTS.md', path.join(dir, 'CLAUDE.md'))) return;
    assert.equal(writeRootClaude(dir), false);
    assert.equal(fs.readlinkSync(path.join(dir, 'CLAUDE.md')), 'AGENTS.md');
  });
});

test('writeRootClaude leaves a user CLAUDE.md -> AGENTS.md pair alone when AGENTS.md is hand-written', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), USER, 'utf8');
    if (!link('AGENTS.md', path.join(dir, 'CLAUDE.md'))) return;
    assert.equal(writeRootClaude(dir), false);
    assert.equal(fs.readlinkSync(path.join(dir, 'CLAUDE.md')), 'AGENTS.md');
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), USER);
  });
});

// ── 3. Never delete a file a sibling link points at ──────────────────────────

test('preserveManualRootContext does not delete CLAUDE.md when AGENTS.md points at it', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), USER, 'utf8');
    if (!link('CLAUDE.md', path.join(dir, 'AGENTS.md'))) return;
    assert.equal(preserveManualRootContext(dir, 'CLAUDE.md', { ...NEW_PROJECT }), false);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), USER);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'CLAUDE.local.md')), false);
  });
});

test('preserveManualRootContext treats ./CLAUDE.md as pointing at the sibling', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), USER, 'utf8');
    if (!link('./CLAUDE.md', path.join(dir, 'AGENTS.md'))) return;
    assert.equal(preserveManualRootContext(dir, 'CLAUDE.md', { ...NEW_PROJECT }), false);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), USER);
  });
});

test('preserveManualRootContext does not delete AGENTS.md when CLAUDE.md points at it', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), USER, 'utf8');
    if (!link('AGENTS.md', path.join(dir, 'CLAUDE.md'))) return;
    assert.equal(preserveManualRootContext(dir, 'AGENTS.md', { ...NEW_PROJECT }), false);
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), USER);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'AGENTS.local.md')), false);
  });
});

test('preserveManualRootContext still takes over a lone hand-written AGENTS.md', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), USER, 'utf8');
    assert.equal(preserveManualRootContext(dir, 'AGENTS.md', { ...NEW_PROJECT }), true);
    assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
    assert.ok(fs.readFileSync(path.join(dir, '.traffic-one', 'AGENTS.local.md'), 'utf8').includes('Do not touch.'));
  });
});

test('the materialize sequence never forms AGENTS.md <-> CLAUDE.md from a user AGENTS.md -> CLAUDE.md pair', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), USER, 'utf8');
    if (!link('CLAUDE.md', path.join(dir, 'AGENTS.md'))) return;

    assert.equal(preserveManualRootContext(dir, 'AGENTS.md', { ...NEW_PROJECT }), false);
    assert.equal(preserveManualRootContext(dir, 'CLAUDE.md', { ...NEW_PROJECT }), false);
    assert.equal(writeRootAgents(dir, GENERATED), false);
    assert.equal(writeRootClaude(dir), false);

    assert.ok(fs.lstatSync(path.join(dir, 'AGENTS.md')).isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(dir, 'AGENTS.md')), 'CLAUDE.md');
    assert.equal(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), USER);
    assert.equal(isLoop(path.join(dir, 'AGENTS.md'), path.join(dir, 'CLAUDE.md')), false);
  });
});

test('writeRootClaude refuses to close an AGENTS.md -> CLAUDE.md pair even when CLAUDE.md is missing', () => {
  withDir((dir) => {
    if (!link('CLAUDE.md', path.join(dir, 'AGENTS.md'))) return;
    assert.equal(writeRootClaude(dir), false, 'creating CLAUDE.md -> AGENTS.md would ELOOP');
    assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), false);
    assert.ok(fs.lstatSync(path.join(dir, 'AGENTS.md')).isSymbolicLink());
  });
});
