import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Ctx, HookInput, ToolClass } from '../../core/types';
import { resetAuthoringRootCache } from '../authoring-root';
import { resolveToolScope } from '../tool-scope';

function makeAuthoringRoot(root: string): void {
  fs.mkdirSync(path.join(root, 'src', 'gen'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'gen', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'traffic-one' }));
}

function makeProject(root: string): void {
  fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'existing-codebase',
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'go',
  }));
}

function ctx(
  cwd: string,
  rawName: string,
  cls: ToolClass,
  toolInput: Record<string, unknown>,
  canonical: Partial<NonNullable<HookInput['tool']>> = {},
): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'codex',
    cwd,
    raw: { tool_name: rawName, tool_input: toolInput },
    tool: { class: cls, rawName, ...canonical },
  };
  return { input, host: 'codex', cwd, now: () => 'x' } as unknown as Ctx;
}

test('plugin-source stand-down stays active for calls confined to the plugin source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tool-scope-local-'));
  try {
    makeAuthoringRoot(root);
    resetAuthoringRootCache();
    const scope = resolveToolScope(ctx(root, 'Bash', 'shell', { command: 'npm test' }, { command: 'npm test' }));
    assert.equal(scope.standsDown, true);
    assert.equal(scope.externalTargets.length, 0);
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plugin-source stand-down stays active for standard local ./... command operands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tool-scope-local-glob-'));
  try {
    makeAuthoringRoot(root);
    resetAuthoringRootCache();
    for (const command of [
      'go test ./...',
      'pnpm --filter ./... test',
      'git add ./...',
      'rg foo ./...',
    ]) {
      const scope = resolveToolScope(ctx(root, 'Bash', 'shell', { command }, { command }));
      assert.equal(scope.standsDown, true, command);
      assert.equal(scope.externalTargets.length, 0, command);
    }
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('absolute shell target escapes plugin stand-down and resolves the real project', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tool-scope-shell-'));
  const authoring = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  try {
    makeAuthoringRoot(authoring);
    makeProject(project);
    resetAuthoringRootCache();
    const command = `/bin/zsh -lc 'cd "${project}" && touch src/server.go'`;
    const scope = resolveToolScope(ctx(authoring, 'exec_command', 'shell', { cmd: command }, { command }));
    assert.equal(scope.standsDown, false);
    assert.equal(scope.projectRoot, project);
    assert.ok(scope.externalTargets.some((target) => target.path === project));
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('relative shell directory transition escapes plugin stand-down and resolves the sibling project', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tool-scope-relative-shell-'));
  const authoring = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  try {
    makeAuthoringRoot(authoring);
    makeProject(project);
    resetAuthoringRootCache();
    const command = 'cd ../project && touch src/server.go';
    const scope = resolveToolScope(ctx(authoring, 'exec_command', 'shell', { cmd: command }, { command }));
    assert.equal(scope.standsDown, false);
    assert.equal(scope.projectRoot, project);
    assert.ok(scope.externalTargets.some((target) => target.path === project && target.directoryHint));
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('direct relative shell writers cannot inherit plugin-source stand-down', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tool-scope-relative-write-'));
  const authoring = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  try {
    makeAuthoringRoot(authoring);
    makeProject(project);
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    resetAuthoringRootCache();
    for (const command of [
      'touch ../project/src/server.go',
      'mkdir -p ../project/generated',
      'printf x > ../project/src/server.go',
      'tee ../project/src/server.go',
      "/bin/zsh -lc 'touch ../project/src/server.go'",
      'sed -i.bak s/old/new/ ../project/src/server.go',
      'custom-writer ../project/src/server.go',
    ]) {
      const scope = resolveToolScope(ctx(authoring, 'exec_command', 'shell', { cmd: command }, { command }));
      assert.equal(scope.standsDown, false, command);
      assert.equal(scope.projectRoot, project, command);
      assert.ok(scope.externalTargets.length > 0, command);
    }
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('$PWD and ${PWD} shell write targets resolve against the authenticated tool base', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tool-scope-pwd-'));
  const authoring = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  try {
    makeAuthoringRoot(authoring);
    makeProject(project);
    fs.mkdirSync(path.join(authoring, 'src'), { recursive: true });
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    resetAuthoringRootCache();

    for (const command of [
      'touch "$PWD/../project/src/server.go"',
      'touch ${PWD}/../project/src/server.go',
      'printf x > "${PWD}/../project/src/server.go"',
    ]) {
      const scope = resolveToolScope(ctx(authoring, 'exec_command', 'shell', { cmd: command }, { command }));
      assert.equal(scope.standsDown, false, command);
      assert.equal(scope.projectRoot, project, command);
      assert.equal(scope.unresolvedWriteTargets.length, 0, command);
      assert.ok(
        scope.externalTargets.some((target) => target.path === path.join(project, 'src', 'server.go')),
        command,
      );
    }

    for (const command of [
      'touch "$PWD/src/local.ts"',
      'touch ${PWD}/src/local.ts',
    ]) {
      const scope = resolveToolScope(ctx(authoring, 'exec_command', 'shell', { cmd: command }, { command }));
      assert.equal(scope.standsDown, true, command);
      assert.equal(scope.externalTargets.length, 0, command);
      assert.equal(scope.unresolvedWriteTargets.length, 0, command);
    }
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('unknown shell expansions fail closed only when they own a recognized write target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tool-scope-unknown-env-'));
  try {
    makeAuthoringRoot(root);
    resetAuthoringRootCache();

    for (const command of [
      'touch "$TARGET_ROOT/file.ts"',
      'printf x > "${OUTPUT_ROOT}/file.ts"',
      'cp source.ts "$DESTINATION/file.ts"',
      'cd "$TARGET_ROOT" && touch file.ts',
    ]) {
      const scope = resolveToolScope(ctx(root, 'exec_command', 'shell', { cmd: command }, { command }));
      assert.equal(scope.standsDown, false, command);
      assert.ok(scope.unresolvedWriteTargets.length > 0, command);
    }

    for (const command of [
      'rg "$PATTERN" .',
      'go test "$PACKAGE"',
      'cat "$INPUT_FILE"',
      'printf "%s\\n" "$VALUE"',
      'cd "$READ_ROOT" && rg needle .',
    ]) {
      const scope = resolveToolScope(ctx(root, 'exec_command', 'shell', { cmd: command }, { command }));
      assert.equal(scope.standsDown, true, command);
      assert.equal(scope.unresolvedWriteTargets.length, 0, command);
    }
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external workdir is the base for relative file targets', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tool-scope-workdir-'));
  const authoring = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  try {
    makeAuthoringRoot(authoring);
    makeProject(project);
    resetAuthoringRootCache();
    const scope = resolveToolScope(ctx(authoring, 'Edit', 'file-edit', {
      file_path: 'src/server.go',
      old_string: 'old',
      new_string: 'new',
      workdir: project,
    }, {
      filePath: 'src/server.go',
      workdir: project,
      content: 'new',
    }));
    assert.equal(scope.standsDown, false);
    assert.equal(scope.base, project);
    assert.equal(scope.projectRoot, project);
    assert.ok(scope.externalTargets.some((target) => target.path === path.join(project, 'src', 'server.go')));
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('git -C and option-assignment paths in shell text cannot inherit authoring stand-down', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tool-scope-options-'));
  const authoring = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  try {
    makeAuthoringRoot(authoring);
    makeProject(project);
    resetAuthoringRootCache();
    for (const command of [
      `git -C "${project}" add src/server.go`,
      `npm --prefix="${project}" install`,
      `printf x > "${path.join(project, 'src', 'server.go')}"`,
    ]) {
      const scope = resolveToolScope(ctx(authoring, 'Bash', 'shell', { command }, { command }));
      assert.equal(scope.standsDown, false, command);
      assert.equal(scope.projectRoot, project, command);
    }
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a READ that merely names an absolute foreign path does not move the project root', () => {
  // Live regression: `ls -la <sibling-project>/.claude` issued from this repo made
  // the onboarding gate adopt that project, spawn a wizard inside it, and write
  // Claude host files into a Cursor-onboarded project. Reading is not adoption
  // evidence. standsDown must STAY false — the foreign target is still governed,
  // it just may not redefine which project is active.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-tool-scope-read-'));
  const authoring = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  const source = path.join(project, 'src', 'server.go');
  try {
    makeAuthoringRoot(authoring);
    makeProject(project);
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    resetAuthoringRootCache();
    for (const command of [
      `ls -la "${path.join(project, '.claude')}"`,
      `wc -l ${source}`,
      `cat "${source}"`,
      `grep -rn foo ${project}`,
    ]) {
      const scope = resolveToolScope(ctx(authoring, 'Bash', 'shell', { command }, { command }));
      assert.equal(scope.projectRoot, authoring, command);
      assert.equal(scope.standsDown, false, `${command} — the foreign target stays governed`);
      assert.ok(scope.externalTargets.length > 0, command);
    }
    // An explicit read TOOL is the same class.
    const read = resolveToolScope(ctx(authoring, 'Read', 'file-read', { file_path: source }, { filePath: source }));
    assert.equal(read.projectRoot, authoring);
    // …but a WRITE to the very same absolute path still re-anchors.
    for (const command of [`sed -i.bak s/old/new/ ${source}`, `touch "${source}"`]) {
      const scope = resolveToolScope(ctx(authoring, 'Bash', 'shell', { command }, { command }));
      assert.equal(scope.projectRoot, project, command);
    }
    const write = resolveToolScope(ctx(
      authoring,
      'Write',
      'file-write',
      { file_path: source, content: 'x' },
      { filePath: source },
    ));
    assert.equal(write.projectRoot, project);
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
