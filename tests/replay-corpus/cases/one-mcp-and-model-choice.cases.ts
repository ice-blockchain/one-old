// tests/replay-corpus/cases/one-mcp-and-model-choice.cases.ts
// The machine-global and Cursor-only gates: one-mcp-tool-gate (priority -100,
// runs before auth/onboarding), model-choice-gate (15, cursor-only) and the
// pre-spawn model-gate command's approve/reject prompt (agent-model.model-gate,
// 41 — the one non-refusal that travels as a deny kind).

import type { CaseSpec } from '../run-case';
import { cursorModelChoice, cursorModelChoiceDelivered, freshProject, FIXTURE_SESSION_ID } from '../fixtures';
import { CURSOR_PAID_PLAN } from '../env';
import { modelGateCommand } from '../../../src/shared/model-gate-command';

export const ONE_MCP_CASES: CaseSpec[] = [
  {
    id: 'one-mcp.claude-get-config-denied',
    notes: 'A model-originated call to the managed public MCP tool is always denied, independent of project state',
    host: 'claude',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'one-mcp-tool-gate.agent-call',
    tool: { class: 'other', rawName: 'mcp__traffic-one-mcp__get_config' },
  },
  {
    id: 'one-mcp.cursor-report-codebase-denied',
    notes: 'Cursor spelling of the same managed-tool deny',
    host: 'cursor',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'one-mcp-tool-gate.agent-call',
    tool: { class: 'other', rawName: 'traffic-one-mcp.report_codebase_metadata' },
  },
  {
    id: 'one-mcp.opencode-get-config-denied',
    notes: 'OpenCode spelling of the same managed-tool deny',
    host: 'opencode',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'one-mcp-tool-gate.agent-call',
    tool: { class: 'other', rawName: 'traffic-one-mcp_get_config' },
  },
  {
    id: 'one-mcp.unmanaged-mcp-tool-allowed',
    notes: 'Control case: an MCP tool that is not one of the two managed names is not this gate\'s business',
    host: 'claude',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: null,
    tool: { class: 'other', rawName: 'mcp__some-other-server__some_tool' },
  },
];

export const MODEL_CHOICE_CASES: CaseSpec[] = [
  {
    id: 'model-choice.non-cursor-host-noop',
    notes: 'model-choice-gate is cursor-only; every other host is an immediate noop regardless of state',
    host: 'claude',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: null,
    tool: { class: 'shell', rawName: 'Bash', command: 'echo hi' },
  },
  {
    id: 'model-choice.stop-first-cursor',
    notes: 'Cursor build paused on an unavailable picked model: the FIRST gated tool call of the session gets the full unavailable-model table -> model-choice-stop-first. The fixture freezes a run model policy whose picks are absent from the captured Cursor list, which is the real shape of this state (see cursorModelChoice)',
    host: 'cursor',
    event: 'PreToolUse',
    project: cursorModelChoice,
    env: CURSOR_PAID_PLAN,
    expectGate: 'model-choice-gate.pre-tool',
    workspaceRoot: 'cwd',
    tool: { class: 'file-write', rawName: 'Write', filePath: 'apps/web/src/components/Widget.tsx', content: 'export const Widget = () => null;\n' },
    raw: { session_id: 'model-choice-first-session', tool_input: { file_path: 'apps/web/src/components/Widget.tsx' } },
  },
  {
    id: 'model-choice.stop-repeat-cursor',
    notes: 'Same paused state, same session, walkthrough already emitted -> model-choice-stop-repeat (the short "reply fallback or enable" form). Reached by pointing the case at a session id whose first-emit marker the fixture already burned',
    host: 'cursor',
    event: 'PreToolUse',
    project: cursorModelChoiceDelivered,
    env: CURSOR_PAID_PLAN,
    expectGate: 'model-choice-gate.pre-tool',
    workspaceRoot: 'cwd',
    tool: { class: 'file-write', rawName: 'Write', filePath: 'apps/web/src/components/Widget.tsx', content: 'export const Widget = () => null;\n' },
    raw: { session_id: FIXTURE_SESSION_ID, tool_input: { file_path: 'apps/web/src/components/Widget.tsx' } },
  },
  {
    id: 'model-choice.plan-write-pending-on-read-only-shell',
    notes: 'The SECOND gate that owns this state: model-choice-gate releases read-only orientation once the walkthrough is delivered, so a non-mutating shell command falls through to plan-write, which refuses it with its own id (plan-write-model-choice-pending). Two gates, two ids, one cause — worth freezing because a retiering that unifies them changes which one a run sees',
    host: 'cursor',
    event: 'PreToolUse',
    project: cursorModelChoiceDelivered,
    env: CURSOR_PAID_PLAN,
    expectGate: 'plan-guard.write',
    workspaceRoot: 'cwd',
    tool: { class: 'shell', rawName: 'Bash', command: 'ls -la apps/web' },
    raw: { session_id: FIXTURE_SESSION_ID, tool_input: { command: 'ls -la apps/web' } },
  },
  {
    id: 'model-choice.model-gate-command-user-approval-request',
    notes: 'NOT a refusal: the pre-spawn model-gate command on Cursor pops a user APPROVE/REJECT dialog (permission:"ask"), which travels as a deny KIND so merge/short-circuit semantics are unchanged — hence its own id, user-approval-request, and a note in the catalog that a deny budget must SKIP it. Only reachable once the user has answered the model-choice question (choice: answered): while it is pending, plan-write refuses this same command first',
    host: 'cursor',
    event: 'PreToolUse',
    project: (host) => cursorModelChoice(host, 'answered'),
    env: CURSOR_PAID_PLAN,
    expectGate: 'agent-model.model-gate',
    workspaceRoot: 'cwd',
    // The grammar only accepts an argv naming THIS project root, which is a
    // per-run temp path — hence the function form.
    tool: (cwd) => ({ class: 'shell', rawName: 'Bash', command: modelGateCommand(cwd, 'cursor') }),
  },
];
