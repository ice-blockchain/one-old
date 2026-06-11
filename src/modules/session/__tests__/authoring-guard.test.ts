import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { authoringWriteGuard } from '../authoring-guard';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import { GENERATED_MARKER } from '../../../shared/materialize/generated';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';
import { toolClassForRawName } from '../../../core/events';

function ctxFor(cwd: string, toolName: string, toolInput: Record<string, unknown>): Ctx {
  const cls = toolClassForRawName(toolName) as ToolClass;
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
  const command = typeof toolInput.command === 'string' ? toolInput.command : undefined;
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    raw: { tool_name: toolName, tool_input: toolInput },
    tool: { class: cls, rawName: toolName, ...(filePath ? { filePath } : {}), ...(command ? { command } : {}) },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function withRepoInParent(fn: (parent: string, repo: string) => void): void {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-aguard-')));
  resetAuthoringRootCache();
  try {
    const repo = path.join(parent, 'one');
    fs.mkdirSync(path.join(repo, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'gen', 'index.ts'), '// gen', 'utf8');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    fn(parent, repo);
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

test('denies .traffic-one writes into the repo — from repo cwd AND parent-workspace cwd', () => {
  withRepoInParent((parent, repo) => {
    const target = path.join(repo, '.traffic-one', '.one.json');
    for (const cwd of [repo, parent]) {
      const result = authoringWriteGuard(ctxFor(cwd, 'Write', { file_path: target, content: '{}' }));
      assert.equal(result.kind, 'deny', `cwd=${cwd}`);
      if (result.kind === 'deny') assert.ok(result.reason.includes('plugin source repository'));
    }
  });
});

test('denies apply_patch adding .traffic-one files and shell commands targeting .traffic-one', () => {
  withRepoInParent((parent, repo) => {
    const patch = `*** Begin Patch\n*** Add File: ${path.join(repo, '.traffic-one', 'manifest.json')}\n+{}\n*** End Patch`;
    assert.equal(authoringWriteGuard(ctxFor(parent, 'apply_patch', { input: patch })).kind, 'deny');
    assert.equal(authoringWriteGuard(ctxFor(repo, 'Bash', { command: `mkdir -p ${path.join(repo, '.traffic-one')}` })).kind, 'deny');
  });
});

test('denies generated project-context content into root AGENTS.md/CLAUDE.md only', () => {
  withRepoInParent((_parent, repo) => {
    const agents = path.join(repo, 'AGENTS.md');
    const generated = authoringWriteGuard(ctxFor(repo, 'Write', { file_path: agents, content: `x\n${GENERATED_MARKER}\n` }));
    assert.equal(generated.kind, 'deny');
    const materialized = authoringWriteGuard(ctxFor(repo, 'Edit', { file_path: agents, new_string: '# Traffic One Local Agent Context\n' }));
    assert.equal(materialized.kind, 'deny');
    // Ordinary source edits to the maintainer guide stay allowed.
    const plain = authoringWriteGuard(ctxFor(repo, 'Write', { file_path: agents, content: '# Maintainer guide\n' }));
    assert.equal(plain.kind, 'noop');
  });
});

test('noop for ordinary source edits in the repo and for .traffic-one writes in real projects', () => {
  withRepoInParent((parent, repo) => {
    assert.equal(authoringWriteGuard(ctxFor(repo, 'Write', { file_path: path.join(repo, 'src', 'shared', 'x.ts'), content: '// ok' })).kind, 'noop');
    // A real project (no authoring ancestor) writing its own state is untouched.
    const project = path.join(parent, 'app');
    fs.mkdirSync(project, { recursive: true });
    assert.equal(authoringWriteGuard(ctxFor(project, 'Write', { file_path: path.join(project, '.traffic-one', '.one.json'), content: '{}' })).kind, 'noop');
  });
});
