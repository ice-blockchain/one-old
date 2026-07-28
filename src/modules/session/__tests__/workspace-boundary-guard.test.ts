import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { workspaceBoundaryGuard } from '../workspace-boundary-guard';
import { makeClaudeAdapter } from '../../../adapters/claude';
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

test('denies an atomic multi-file apply_patch when its second target is outside the workspace', () => {
  withSiblingWorkspaces((_root, ws6b, ws5b) => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/inside.ts',
      '+inside',
      `*** Add File: ${path.join(ws5b, 'src', 'outside.ts')}`,
      '+outside',
      '*** End Patch',
    ].join('\n');
    const result = workspaceBoundaryGuard(ctxFor(ws6b, ws6b, 'apply_patch', {
      output: { args: { patch } },
    }));
    assert.equal(result.kind, 'deny');
    if (result.kind === 'deny') assert.ok(result.reason.includes(ws5b));
  });
});

test('apply_patch resolves the project boundary when a host omits workspaceRoot', () => {
  withSiblingWorkspaces((_root, ws6b, ws5b) => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/inside.ts',
      '+inside',
      `*** Add File: ${path.join(ws5b, 'src', 'outside.ts')}`,
      '+outside',
      '*** End Patch',
    ].join('\n');
    const result = workspaceBoundaryGuard(ctxFor(ws6b, undefined, 'apply_patch', { patch }));
    assert.equal(result.kind, 'deny');
    if (result.kind === 'deny') assert.ok(result.reason.includes(ws5b));
  });
});

// Regression (3co, 1.0.28): Codex delivers the apply_patch payload in
// tool_input.command. The patch BODY must never be scanned as shell text —
// a semantic route string ("/courses/:courseSlug") in written content was
// extracted as an absolute path candidate and the whole multi-file patch was
// denied as a workspace escape.
test('allows a codex apply_patch whose CONTENT contains route strings and $vars (payload in tool_input.command)', () => {
  withSiblingWorkspaces((_root, ws6b) => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: .traffic-one/plan.md',
      '+# Plan',
      '+| `course-detail` | `/courses/:courseSlug` | detail page |',
      '+Set `$VITE_SITE_URL` in the environment before builds.',
      '*** Add File: .traffic-one/runs/123/architecture-input-v1.json',
      '+{ "routes": [ { "id": "course-detail", "path": "/courses/:courseSlug" } ] }',
      '*** End Patch',
    ].join('\n');
    const parsed = makeClaudeAdapter('codex').parse({
      stdin: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: patch },
        cwd: ws6b,
      }),
      argv: [],
    });
    assert.equal(parsed.tool?.command, undefined);
    assert.equal(parsed.tool?.patchText, patch);
    const ctx = { input: parsed, host: 'codex', cwd: ws6b, now: () => 'x' } as unknown as Ctx;
    const result = workspaceBoundaryGuard(ctx);
    assert.equal(result.kind, 'noop');
  });
});

test('still denies a codex command-shaped apply_patch whose OPERATION escapes the workspace', () => {
  withSiblingWorkspaces((_root, ws6b, ws5b) => {
    const patch = [
      '*** Begin Patch',
      `*** Add File: ${path.join(ws5b, 'src', 'outside.ts')}`,
      '+outside',
      '*** End Patch',
    ].join('\n');
    const parsed = makeClaudeAdapter('codex').parse({
      stdin: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: patch },
        cwd: ws6b,
      }),
      argv: [],
    });
    const ctx = { input: parsed, host: 'codex', cwd: ws6b, now: () => 'x' } as unknown as Ctx;
    const result = workspaceBoundaryGuard(ctx);
    assert.equal(result.kind, 'deny');
    if (result.kind === 'deny') assert.ok(result.reason.includes(ws5b));
  });
});

test('fails closed when a non-empty apply_patch payload cannot be parsed', () => {
  withSiblingWorkspaces((_root, ws6b) => {
    const result = workspaceBoundaryGuard(ctxFor(ws6b, ws6b, 'apply_patch', {
      patch: '*** Begin Patch\ninvalid\n*** End Patch',
    }));
    assert.equal(result.kind, 'deny');
    if (result.kind === 'deny') assert.match(result.reason, /cannot be validated|invalid/i);
  });
});

test('fails closed for unresolved shell write targets even without a host workspace boundary', () => {
  withSiblingWorkspaces((_root, ws6b) => {
    for (const command of [
      'touch "$UNKNOWN_ROOT/file.ts"',
      'printf x > "${UNKNOWN_ROOT}/file.ts"',
      'cp source.ts "$UNKNOWN_ROOT/file.ts"',
    ]) {
      const result = workspaceBoundaryGuard(ctxFor(ws6b, undefined, 'Bash', { command }));
      assert.equal(result.kind, 'deny', command);
      if (result.kind === 'deny') {
        assert.match(result.reason, /unresolved environment or command expansion/i, command);
      }
    }
  });
});

test('does not treat ordinary read-only shell variables as unresolved write targets', () => {
  withSiblingWorkspaces((_root, ws6b) => {
    for (const command of [
      'rg "$PATTERN" .',
      'go test "$PACKAGE"',
      'cat "$INPUT_FILE"',
    ]) {
      assert.equal(workspaceBoundaryGuard(ctxFor(ws6b, ws6b, 'Bash', { command })).kind, 'noop', command);
    }
  });
});

test('allows stderr redirection to the operating-system discard sink', () => {
  withSiblingWorkspaces((_root, ws6b) => {
    for (const command of [
      'rg "needle" . 2>/dev/null',
      'npm test 2> /dev/null',
    ]) {
      assert.equal(
        workspaceBoundaryGuard(ctxFor(ws6b, ws6b, 'Bash', { command })).kind,
        'noop',
        command,
      );
    }
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
