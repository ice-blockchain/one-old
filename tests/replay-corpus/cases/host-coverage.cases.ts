// tests/replay-corpus/cases/host-coverage.cases.ts
// Deliberate breadth cases: every host and every tool class gets at least one
// case somewhere in the corpus. This file plugs the gaps the theme-based files
// (session-guards/onboarding/plan-guard/agent-model) don't already cover, so
// the coverage report's per-host and per-tool-class tallies are non-zero
// everywhere. Uses workspaceBoundary-safe, read-mostly calls on an already
// onboarded fixture so these characterize ordinary orientation traffic, not
// another gate's deny.

import type { CaseSpec } from '../run-case';
import { existingCodebase, scaffoldedGreenfield } from '../fixtures';

export const HOST_COVERAGE_CASES: CaseSpec[] = [
  {
    id: 'host-coverage.copilot-file-read',
    notes: 'Copilot host, file-read tool class',
    host: 'copilot',
    event: 'PreToolUse',
    project: scaffoldedGreenfield,
    expectGate: null,
    tool: { class: 'file-read', rawName: 'Read', filePath: 'src/App.tsx' },
  },
  {
    id: 'host-coverage.kilo-search',
    notes: 'Kilo host, search tool class',
    host: 'kilo',
    event: 'PreToolUse',
    project: scaffoldedGreenfield,
    expectGate: null,
    tool: { class: 'search', rawName: 'Grep', command: 'App' },
  },
  {
    id: 'host-coverage.windsurf-search',
    notes: 'Windsurf host, search tool class',
    host: 'windsurf',
    event: 'PreToolUse',
    project: scaffoldedGreenfield,
    expectGate: null,
    tool: { class: 'search', rawName: 'grep_search', command: 'export default' },
  },
  {
    id: 'host-coverage.opencode-other',
    notes: 'OpenCode host, "other" tool class (a tool that maps to no more specific class)',
    host: 'opencode',
    event: 'PreToolUse',
    project: scaffoldedGreenfield,
    expectGate: null,
    tool: { class: 'other', rawName: 'todowrite' },
  },
  {
    id: 'host-coverage.codex-other',
    notes: 'Codex host, "other" tool class',
    host: 'codex',
    event: 'PreToolUse',
    project: scaffoldedGreenfield,
    expectGate: null,
    tool: { class: 'other', rawName: 'update_plan' },
  },
  {
    id: 'host-coverage.cursor-search',
    notes: 'Cursor host, search tool class',
    host: 'cursor',
    event: 'PreToolUse',
    project: scaffoldedGreenfield,
    expectGate: null,
    workspaceRoot: 'cwd',
    tool: { class: 'search', rawName: 'codebase_search', command: 'App component' },
  },
  {
    id: 'host-coverage.claude-shell-readonly',
    notes: 'Claude host, shell tool class, read-only command on an existing-codebase fixture',
    host: 'claude',
    event: 'PreToolUse',
    project: existingCodebase,
    expectGate: null,
    tool: { class: 'shell', rawName: 'Bash', command: 'ls -la src' },
  },
  {
    id: 'host-coverage.kilo-file-write-existing-codebase',
    notes: 'Kilo host, file-write tool class, existing-codebase fixture (own-conventions stand-down for stack gates)',
    host: 'kilo',
    event: 'PreToolUse',
    project: existingCodebase,
    expectGate: null,
    tool: { class: 'file-write', rawName: 'write_to_file', filePath: 'src/util.ts', content: 'export const helper = () => true;\n' },
  },
];
