// tests/replay-corpus/cases/session-guards.cases.ts
// Priority 0-5 gates: session.auth, session.workspace-boundary,
// session.authoring-guard. These run before onboarding, so a bare
// freshProject/undecidedProject fixture is enough to reach them.

import * as path from 'path';
import type { CaseSpec } from '../run-case';
import { AUTH_ENFORCED } from '../env';
import { declinedProject, freshProject, greenfieldMainAgent, undecidedProject } from '../fixtures';

// The plugin's own source repo — two directories up from this file
// (tests/replay-corpus/cases/*.ts -> repo root). Used ONLY as the `cwd` a
// simulated tool call targets; the case never writes to it (a denied call
// performs no write, and an allowed read-only call here is harmless).
const PLUGIN_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const SESSION_GUARD_CASES: CaseSpec[] = [
  {
    id: 'auth.enforced-unauthenticated-mutating-shell',
    notes: 'The ONE pair of cases that turn auth enforcement ON (env.ts keeps it off for the rest of the corpus so no fixture needs a fake API key). While unauthenticated, the priority-0 auth gate delegates to onboardingGate and returns its verdict UNDER ITS OWN gate id — so the same project denies with the same denyId from session.auth here and from onboarding-gate in onboarding.use-plugin-question-claude. That attribution split is the thing worth freezing: a later retiering must not silently move a refusal between the two.',
    host: 'claude',
    event: 'PreToolUse',
    project: undecidedProject,
    expectGate: 'session.auth',
    env: AUTH_ENFORCED,
    tool: { class: 'shell', rawName: 'Bash', command: 'touch src/index.ts' },
  },
  {
    id: 'auth.enforced-declined-project-standsdown',
    notes: 'Control case: a declined project stands down even with auth enforced — authPreToolGate checks pluginUseDeclined BEFORE it reads the auth record, so declining is not overridden by enforcement',
    host: 'claude',
    event: 'PreToolUse',
    project: declinedProject,
    expectGate: null,
    env: AUTH_ENFORCED,
    tool: { class: 'shell', rawName: 'Bash', command: 'touch src/index.ts' },
  },
  {
    id: 'workspace-boundary.read-outside-workspace',
    notes: 'Cursor read targets an absolute path outside workspaceRoot -> workspace-boundary-guard',
    host: 'cursor',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'session.workspace-boundary',
    workspaceRoot: 'cwd',
    tool: { class: 'file-read', rawName: 'Read', filePath: '/etc/passwd' },
  },
  {
    id: 'workspace-boundary.shell-unresolved-expansion',
    notes: 'Shell write target with an unresolved $VAR expansion -> workspace-boundary-unresolved-expansion',
    host: 'cursor',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'session.workspace-boundary',
    workspaceRoot: 'cwd',
    tool: { class: 'shell', rawName: 'Bash', command: 'touch $UNRESOLVED_VAR/out.txt' },
  },
  {
    id: 'workspace-boundary.read-inside-workspace-allowed',
    notes: 'Control case: a read inside the workspace is not denied by the boundary guard. Needs an onboarded fixture, not freshProject: on an incomplete project ANY tool (including reads) can still be denied by a LATER-priority gate (onboarding-gate), which would make this "allowed" verdict accidental instead of actually characterizing workspace-boundary-guard standing aside. greenfieldMainAgent, not scaffoldedGreenfield: team.mode "subagents" (scaffoldedGreenfield\'s default) additionally requires a frozen Cursor model-tier snapshot before ANY tool call on the cursor host (onboarding-cursor-models-required) — main-agent mode has no such requirement, so this case actually isolates the workspace-boundary-guard verdict',
    host: 'cursor',
    event: 'PreToolUse',
    project: greenfieldMainAgent,
    expectGate: null,
    workspaceRoot: 'cwd',
    tool: { class: 'file-read', rawName: 'Read', filePath: 'package.json' },
  },
  {
    id: 'apply-patch.invalid-payload-via-workspace-boundary',
    notes: 'apply_patch with an unparseable patch body -> apply-patch-payload-invalid (workspace-boundary-guard)',
    host: 'claude',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'session.workspace-boundary',
    tool: { class: 'file-edit', rawName: 'apply_patch', patchText: 'this is not a real apply_patch payload' },
  },
  {
    id: 'authoring-guard.traffic-one-write-in-plugin-repo',
    notes: 'A write targeting .traffic-one/** while cwd is the plugin\'s own source repo -> authoring-guard',
    host: 'claude',
    event: 'PreToolUse',
    project: () => PLUGIN_REPO_ROOT,
    expectGate: 'session.authoring-guard',
    tool: { class: 'file-write', rawName: 'Write', filePath: '.traffic-one/stray.json', content: '{}' },
  },
  {
    id: 'authoring-guard.agents-md-generated-rewrite-in-plugin-repo',
    notes: 'A write rewriting AGENTS.md with the GENERATED-BY marker inside the plugin repo -> authoring-guard',
    host: 'codex',
    event: 'PreToolUse',
    project: () => PLUGIN_REPO_ROOT,
    expectGate: 'session.authoring-guard',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: 'AGENTS.md',
      content: '<!-- GENERATED BY traffic-one: project-local active rules -->\nstray project context',
    },
  },
  {
    id: 'authoring-guard.ordinary-source-edit-in-plugin-repo-allowed',
    notes: 'Control case: an ordinary source edit inside the plugin repo is not an authoring-guard target',
    host: 'claude',
    event: 'PreToolUse',
    project: () => PLUGIN_REPO_ROOT,
    expectGate: null,
    tool: { class: 'file-edit', rawName: 'Edit', filePath: 'tests/replay-corpus/fixtures.ts', content: '// no-op' },
  },
  {
    id: 'undecided.mutating-shell-blocked-before-onboarding',
    notes: 'Never-answered use-plugin project: writes are fenced (see onboarding.use-plugin-question for the denyId this actually reaches)',
    host: 'claude',
    event: 'PreToolUse',
    project: undecidedProject,
    expectGate: 'onboarding-gate',
    tool: { class: 'shell', rawName: 'Bash', command: 'echo hi' },
  },
];
