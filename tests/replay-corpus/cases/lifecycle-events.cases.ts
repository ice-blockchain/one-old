// tests/replay-corpus/cases/lifecycle-events.cases.ts
// Coverage for the non-PreToolUse canonical events: SessionStart,
// UserPromptSubmit, Stop, SubagentStart, SubagentStop, and PostToolUse. None
// of these carry a `gates` entry in any module.json (see the module.json
// dump gathered while designing this corpus), so decisionKind always resolves
// to 'context' or 'noop' for them — there is no denyId/gate to characterize.
// Their VALUE here is exercising the real, dynamically-loaded reconciliation/
// materialization/session-start handlers end-to-end on each fixture without
// crashing, and pinning which of context/noop each combination produces today.

import type { CaseSpec } from '../run-case';
import {
  existingCodebase,
  freshProject,
  greenfieldNoPlan,
  onboardedMidRun,
  onboardedNotMaterialized,
  scaffoldedGreenfield,
  undecidedProject,
} from '../fixtures';

export const LIFECYCLE_EVENT_CASES: CaseSpec[] = [
  {
    id: 'lifecycle.session-start-undecided-claude',
    notes: 'SessionStart on a project that has never answered the use-plugin question',
    host: 'claude',
    event: 'SessionStart',
    project: undecidedProject,
    expectGate: null,
  },
  {
    id: 'lifecycle.session-start-fresh-claude',
    notes: 'SessionStart on a consented-but-never-onboarded project',
    host: 'claude',
    event: 'SessionStart',
    project: freshProject,
    expectGate: null,
  },
  {
    id: 'lifecycle.session-start-scaffolded-cursor',
    notes: 'SessionStart on an onboarded, scaffolded greenfield project, Cursor host',
    host: 'cursor',
    event: 'SessionStart',
    project: scaffoldedGreenfield,
    expectGate: null,
  },
  {
    id: 'lifecycle.session-start-onboarded-midrun-codex',
    notes: 'SessionStart on a project with a live run + held claim, Codex host',
    host: 'codex',
    event: 'SessionStart',
    project: onboardedMidRun,
    expectGate: null,
  },
  {
    id: 'lifecycle.session-start-existing-codebase-windsurf',
    notes: 'SessionStart on a pre-existing codebase project, Windsurf host',
    host: 'windsurf',
    event: 'SessionStart',
    project: existingCodebase,
    expectGate: null,
  },
  {
    id: 'lifecycle.user-prompt-submit-fresh-claude',
    notes: 'UserPromptSubmit on a consented-but-never-onboarded project',
    host: 'claude',
    event: 'UserPromptSubmit',
    project: freshProject,
    expectGate: null,
    prompt: 'Please add a login form.',
  },
  {
    id: 'lifecycle.user-prompt-submit-scaffolded-opencode',
    notes: 'UserPromptSubmit on an onboarded scaffolded project, OpenCode host',
    host: 'opencode',
    event: 'UserPromptSubmit',
    project: scaffoldedGreenfield,
    expectGate: null,
    prompt: 'Continue implementing the feature.',
  },
  {
    id: 'lifecycle.user-prompt-submit-midrun-cursor',
    notes: 'UserPromptSubmit on a project with a live run + held claim, Cursor host',
    host: 'cursor',
    event: 'UserPromptSubmit',
    project: onboardedMidRun,
    expectGate: null,
    prompt: 'Status check.',
  },
  {
    id: 'lifecycle.stop-onboarding-incomplete-claude',
    notes: 'Stop while onboarding is still incomplete (onboarding-gate.stop + agent-model.cursor-stop both subscribe)',
    host: 'claude',
    event: 'Stop',
    project: freshProject,
    expectGate: null,
  },
  {
    id: 'lifecycle.stop-onboarded-cursor',
    notes: 'Stop on a fully onboarded, scaffolded Cursor project',
    host: 'cursor',
    event: 'Stop',
    project: scaffoldedGreenfield,
    expectGate: null,
  },
  {
    id: 'lifecycle.stop-midrun-cursor',
    notes: 'Stop on a project with a live run + held claim, Cursor host',
    host: 'cursor',
    event: 'Stop',
    project: onboardedMidRun,
    expectGate: null,
  },
  {
    id: 'lifecycle.subagent-start-codex-midrun',
    notes: 'Codex-only SubagentStart on a project with a live run + held claim',
    host: 'codex',
    event: 'SubagentStart',
    project: onboardedMidRun,
    expectGate: null,
    raw: { agent_id: 'replay-fixture-child-thread' },
  },
  {
    id: 'lifecycle.subagent-stop-cursor-midrun',
    notes: 'Cursor-only SubagentStop on a project with a live run + held claim',
    host: 'cursor',
    event: 'SubagentStop',
    project: onboardedMidRun,
    expectGate: null,
  },
  {
    id: 'lifecycle.post-tool-use-shell-scaffolded-claude',
    notes: 'PostToolUse(shell) on a scaffolded project (materialize.post-stack-setup + agent-model.after-shell-execution)',
    host: 'claude',
    event: 'PostToolUse',
    project: scaffoldedGreenfield,
    expectGate: null,
    tool: { class: 'shell', rawName: 'Bash', command: 'npm run build' },
  },
  {
    id: 'lifecycle.post-tool-use-write-greenfield-claude',
    notes: 'PostToolUse(file-write) on a fresh greenfield project (materialize.post-stack-setup convergence path)',
    host: 'claude',
    event: 'PostToolUse',
    project: greenfieldNoPlan,
    expectGate: null,
    tool: { class: 'file-write', rawName: 'Write', filePath: 'src/App.tsx', content: 'export default function App() { return null; }\n' },
  },
  {
    id: 'lifecycle.materialize-project-command',
    notes: 'The `materialize-project` manual remediation command every materialization deny points the agent at. It parses to a PreToolUse with NO tool, which is the exact shape materialize.materialize-project keys on (a real PreToolUse always carries one) — so this is the only case that makes that handler act rather than no-op. Run on the deliberately unmaterialized fixture, which is the state an agent is in when a deny sends it here',
    host: 'claude',
    event: 'PreToolUse',
    project: onboardedNotMaterialized,
    expectGate: null,
  },
];
