import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { workspaceBoundaryGuard } from '../workspace-boundary-guard';
import { toolClassForRawName } from '../../../core/events';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

function ctxFor(
  cwd: string,
  workspaceRoot: string | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
): Ctx {
  const cls = toolClassForRawName(toolName) as ToolClass;
  const filePath = typeof toolInput.file_path === 'string'
    ? toolInput.file_path
    : (typeof toolInput.path === 'string' ? toolInput.path : undefined);
  const workdir = typeof toolInput.workdir === 'string'
    ? toolInput.workdir
    : (typeof toolInput.cwd === 'string' ? toolInput.cwd : undefined);
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'cursor',
    cwd,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    raw: { tool_name: toolName, tool_input: toolInput, ...(workspaceRoot ? { workspace_roots: [workspaceRoot] } : {}) },
    tool: { class: cls, rawName: toolName, ...(filePath ? { filePath } : {}), ...(workdir ? { workdir } : {}) },
  };
  return { input, host: 'cursor', cwd, now: () => 'x' } as unknown as Ctx;
}

function withSiblingWorkspaces(fn: (root: string, ws6b: string, ws5b: string) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-ws-boundary-')));
  const ws6b = path.join(root, '6b');
  const ws5b = path.join(root, '5b');
  fs.mkdirSync(ws6b, { recursive: true });
  fs.mkdirSync(ws5b, { recursive: true });
  fs.writeFileSync(path.join(ws6b, 'package.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(ws5b, 'package.json'), '{}\n', 'utf8');
  try {
    fn(root, ws6b, ws5b);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('allows paths inside the active workspace', () => {
  withSiblingWorkspaces((_root, ws6b) => {
    const result = workspaceBoundaryGuard(ctxFor(ws6b, ws6b, 'Read', { file_path: path.join(ws6b, 'package.json') }));
    assert.equal(result.kind, 'noop');
  });
});

test('denies absolute sibling workspace reads', () => {
  withSiblingWorkspaces((_root, ws6b, ws5b) => {
    const result = workspaceBoundaryGuard(ctxFor(ws6b, ws6b, 'Read', { file_path: path.join(ws5b, 'package.json') }));
    assert.equal(result.kind, 'deny');
    if (result.kind === 'deny') {
      assert.ok(result.reason.includes('workspace boundary blocked'));
      assert.ok(result.reason.includes(ws6b));
      assert.ok(result.reason.includes(ws5b));
    }
  });
});

test('denies relative escapes from the active workspace', () => {
  withSiblingWorkspaces((_root, ws6b) => {
    const result = workspaceBoundaryGuard(ctxFor(ws6b, ws6b, 'Read', { file_path: '../5b/package.json' }));
    assert.equal(result.kind, 'deny');
  });
});

test('denies search paths outside the active workspace but allows implicit workspace search', () => {
  withSiblingWorkspaces((_root, ws6b, ws5b) => {
    assert.equal(workspaceBoundaryGuard(ctxFor(ws6b, ws6b, 'Grep', { pattern: 'name' })).kind, 'noop');
    assert.equal(workspaceBoundaryGuard(ctxFor(ws6b, ws6b, 'Grep', { pattern: 'name', path: ws5b })).kind, 'deny');
  });
});

test('denies Glob patterns that escape to a sibling workspace', () => {
  withSiblingWorkspaces((_root, ws6b) => {
    const result = workspaceBoundaryGuard(ctxFor(ws6b, ws6b, 'Glob', { pattern: '../5b/**/*.json' }));
    assert.equal(result.kind, 'deny');
  });
});

test('denies symlink escapes even when the lexical path starts inside the workspace', () => {
  withSiblingWorkspaces((_root, ws6b, ws5b) => {
    const link = path.join(ws6b, 'linked-5b');
    fs.symlinkSync(ws5b, link, 'dir');
    const result = workspaceBoundaryGuard(ctxFor(ws6b, ws6b, 'Read', { file_path: path.join(link, 'package.json') }));
    assert.equal(result.kind, 'deny');
  });
});

test('no workspaceRoot means hosts without an authoritative boundary keep existing behavior', () => {
  withSiblingWorkspaces((_root, ws6b, ws5b) => {
    const result = workspaceBoundaryGuard(ctxFor(ws6b, undefined, 'Read', { file_path: path.join(ws5b, 'package.json') }));
    assert.equal(result.kind, 'noop');
  });
});
