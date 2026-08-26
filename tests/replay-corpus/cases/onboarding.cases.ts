// tests/replay-corpus/cases/onboarding.cases.ts
// The priority-10 onboarding-gate (src/modules/onboarding-gate/handler.ts).
//
// Deliberately limited to branches that do NOT require a live onboarding wizard
// server: env.ts sets TRAFFIC_ONE_ONBOARDING_NO_SPAWN=1, so
// prepareOnboardingServer hands back an inert PLACEHOLDER (port 0, empty token —
// see ensure.ts) instead of binding a real port and spawning a real process.
// That placeholder is itself `kind: 'ready'`, which is what makes the
// server-deny ladder below reachable deterministically. The former
// wait-link-first deny ids (claude/cursor/codex-wait-link-first) are retired
// product-side: first wait is allowed and the link is injected via
// setupLinkNudge. They stay in UNREACHED_DENY_IDS with that reason.

import type { CaseSpec } from '../run-case';
import {
  cursorReady,
  declinedProject,
  existingCodebaseUndetectable,
  freshProject,
  freshProjectRecipeDelivered,
  FIXTURE_SESSION_ID,
  materializedGreenfield,
  onboardedNotMaterialized,
  roleContractsUnwritable,
  undecidedProject,
} from '../fixtures';
import { onboardingWaitCommand } from '../../../src/shared/onboarding-server/wait-command';
import { doctorShimCommand } from '../../../src/shared/doctor-command';

// onboardingRunnerInvocation (tool-classify.ts) only recognizes the EXACT
// `node <onboardingWaitScriptPath()> <absolute-cwd> [--host=...]` invocation
// it tells the agent to run — it does not need that cwd to equal the case's
// OWN fixture root, only to be absolute, so a fixed placeholder keeps this
// deterministic across machines/temp roots.
const REAL_WAIT_COMMAND = onboardingWaitCommand('/fixture/onboarding-target', 'claude');

// The shim spelling of the doctor command (`<state-home>/bin/doctor.cjs`), which
// is one of the exactly two argv shapes the gate exemption admits
// (gateExemptDoctorScriptPaths). Deliberately the shim and not doctorCommand():
// that one resolves through pluginRootInfo() and would name the corpus's
// synthetic plugin root, which is NOT one of the two exempt spellings — the
// exemption is anchored on the running runtime and HOME precisely so a
// *_PLUGIN_ROOT env var cannot steer it.
const REAL_DOCTOR_COMMAND = doctorShimCommand();

export const ONBOARDING_CASES: CaseSpec[] = [
  {
    id: 'onboarding.use-plugin-question-claude',
    notes: 'Never answered "use Traffic One here?" -> onboarding-use-plugin-question (ask-first fence)',
    host: 'claude',
    event: 'PreToolUse',
    project: undecidedProject,
    expectGate: 'onboarding-gate',
    tool: { class: 'shell', rawName: 'Bash', command: 'touch src/index.ts' },
  },
  {
    id: 'onboarding.use-plugin-question-cursor',
    notes: 'Same ask-first fence on a different host, to characterize the deny ID as host-independent',
    host: 'cursor',
    event: 'PreToolUse',
    project: undecidedProject,
    expectGate: 'onboarding-gate',
    workspaceRoot: 'cwd',
    tool: { class: 'file-write', rawName: 'Write', filePath: 'src/index.ts', content: 'x' },
  },
  {
    id: 'onboarding.doctor-command-allowed-pre-consent',
    notes: 'The recovery command this gate\'s own deny prose prescribes is exempt from EVERY fence, including the pre-consent one — the exemption is the first statement in the handler, ahead of resolveToolScope/computeOnboarding/prepareOnboardingServer, so a stuck user can always run it and a pre-consent project stays byte-identical. Uses the real shim argv (see REAL_DOCTOR_COMMAND); anything outside that bounded grammar is denied like any other shell command',
    host: 'claude',
    event: 'PreToolUse',
    project: undecidedProject,
    expectGate: null,
    tool: { class: 'shell', rawName: 'Bash', command: REAL_DOCTOR_COMMAND },
  },
  {
    id: 'onboarding.doctor-command-with-bundle-flag-allowed',
    notes: 'Control case for the same exemption\'s argv grammar: `--bundle` is one of the four accepted forms, so it stays allowed on a project that has not consented',
    host: 'codex',
    event: 'PreToolUse',
    project: undecidedProject,
    expectGate: null,
    tool: { class: 'shell', rawName: 'exec_command', command: `${REAL_DOCTOR_COMMAND} '--bundle'` },
  },
  {
    id: 'onboarding.browser-open-denied',
    notes: 'A browser-open shell command is denied unconditionally while onboarding is incomplete, before any tech-detect/server branch runs',
    host: 'claude',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'onboarding-gate',
    tool: { class: 'shell', rawName: 'Bash', command: "open 'https://example.com/setup'" },
  },
  {
    id: 'onboarding.claude-wait-background-denied',
    notes: 'Claude backgrounding the REAL onboarding wait command (byte-exact node invocation the deny prose itself prescribes — onboardingRunnerInvocation only recognizes that exact form) is always denied, checked before tech-detect/server branches',
    host: 'claude',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'onboarding-gate',
    tool: { class: 'shell', rawName: 'Bash', command: REAL_WAIT_COMMAND },
    raw: { tool_input: { command: REAL_WAIT_COMMAND, run_in_background: true } },
  },
  {
    id: 'onboarding.tech-classify-required',
    notes: 'existing-codebase mode, no deterministic stack signal in the fixture -> tech-classify-required. Needs mode:existing-codebase specifically: computeOnboarding only ever returns step==="tech-detect" for that branch (flow.ts) — a new-project fixture with no stack routes to the "open-code" wizard step instead, never tech-detect',
    host: 'claude',
    event: 'PreToolUse',
    project: existingCodebaseUndetectable,
    expectGate: 'onboarding-gate',
    tool: { class: 'shell', rawName: 'Bash', command: 'touch src/index.ts' },
  },
  {
    id: 'onboarding.tech-classify-read-allowed',
    notes: 'Control case for the same branch: inspection IS the classification work the deny asks for, so read-only orientation is released instead of denied',
    host: 'claude',
    event: 'PreToolUse',
    project: existingCodebaseUndetectable,
    expectGate: null,
    tool: { class: 'file-read', rawName: 'Read', filePath: 'package.json' },
  },
  {
    id: 'onboarding.read-only-pre-consent-still-denied',
    notes: 'Real behavior, and REPORTED AS A SUSPECTED BUG rather than endorsed (this case replaces one whose id claimed the read stays allowed): the ask-first branch in handler.ts has no read-only bypass, so an orientation-only Read is denied with onboarding-use-plugin-question. Its own comment says it denies "mutating work", the consent contract it enforces is a WRITE fence (state/plugin-use.ts), and every sibling branch in the same function releases isReadOnlyOrientationToolUse (tech-detect, windsurf, claude, and the repeat path). Pinned here so a fix lands as a reviewed one-line snapshot diff instead of silently',
    host: 'claude',
    event: 'PreToolUse',
    project: undecidedProject,
    expectGate: 'onboarding-gate',
    tool: { class: 'file-read', rawName: 'Read', filePath: 'package.json' },
  },
  {
    id: 'onboarding.declined-project-standsdown',
    notes: 'A project the user declined for is a permanent noop for onboarding-gate',
    host: 'claude',
    event: 'PreToolUse',
    project: declinedProject,
    expectGate: null,
    tool: { class: 'shell', rawName: 'Bash', command: 'touch src/index.ts' },
  },
  {
    id: 'onboarding.server-deny-first-claude',
    notes: 'Consented but not onboarded: the FIRST gated mutating call of a session gets the full setup walkthrough (onboarding-server-deny-first). The once-per-session marker is what splits this from the repeat case below, so both fixtures are separate projects and this one\'s marker is unburned',
    host: 'claude',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'onboarding-gate',
    tool: { class: 'shell', rawName: 'Bash', command: 'touch src/index.ts' },
    raw: { session_id: FIXTURE_SESSION_ID, tool_input: { command: 'touch src/index.ts' } },
  },
  {
    id: 'onboarding.server-deny-repeat-claude',
    notes: 'Same project state and same session, with the walkthrough marker ALREADY burned by the fixture (through the gate\'s own firstEmitThisSession writer) -> onboarding-server-deny-repeat, the link+wait-command-only variant. Burned in the fixture rather than by running the case above first, so neither verdict depends on corpus ordering',
    host: 'claude',
    event: 'PreToolUse',
    project: freshProjectRecipeDelivered,
    expectGate: 'onboarding-gate',
    tool: { class: 'shell', rawName: 'Bash', command: 'touch src/index.ts' },
    raw: { session_id: FIXTURE_SESSION_ID, tool_input: { command: 'touch src/index.ts' } },
  },
  {
    id: 'onboarding.claude-orientation-allowed-after-consent',
    notes: 'Control case: once consent is recorded, Claude orientation is released while setup is pending (its prompt-hook context is reliable and a denied read renders as a failed tool card), so the walkthrough waits for the first MUTATING call',
    host: 'claude',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: null,
    tool: { class: 'file-read', rawName: 'Read', filePath: 'package.json' },
  },
  {
    id: 'onboarding.codex-orientation-allowed-after-consent',
    notes: 'Codex matches Claude: SessionStart + UserPromptSubmit already carry the wizard URL, so a first Read is allowed (setupLinkNudge / context, not deny). A denied Read is a user-visible Error. onboarding-server-deny-first still fires on the first MUTATING tool (see server-deny-first-claude)',
    host: 'codex',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: null,
    tool: { class: 'file-read', rawName: 'Read', filePath: 'package.json' },
  },
  {
    id: 'onboarding.windsurf-server-deny-first',
    notes: 'Windsurf gets its own first-mutation deny variant (windsurf-server-deny-reason): its host entry turns that deny into an inline setup wait, so the prose differs from every other host\'s',
    host: 'windsurf',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'onboarding-gate',
    tool: { class: 'shell', rawName: 'run_command', command: 'touch src/index.ts' },
    raw: { session_id: FIXTURE_SESSION_ID, tool_input: { command: 'touch src/index.ts' } },
  },
  {
    id: 'onboarding.windsurf-server-deny-repeat',
    notes: 'Windsurf, walkthrough already delivered this session -> windsurf-server-deny-reason-repeat',
    host: 'windsurf',
    event: 'PreToolUse',
    project: freshProjectRecipeDelivered,
    expectGate: 'onboarding-gate',
    tool: { class: 'shell', rawName: 'run_command', command: 'touch src/index.ts' },
    raw: { session_id: FIXTURE_SESSION_ID, tool_input: { command: 'touch src/index.ts' } },
  },
  {
    id: 'onboarding.windsurf-orientation-allowed',
    notes: 'Control case: Windsurf renders a denied read as a failed tool card, so harmless orientation is never spent on that surface while the wizard is open',
    host: 'windsurf',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: null,
    tool: { class: 'file-read', rawName: 'view_file', filePath: 'package.json' },
  },
  {
    id: 'onboarding.opencode-setup-required',
    notes: 'OpenCode/Kilo get a deliberately minimal deny (onboarding-setup-required-opencode): the full multi-host walkthrough reads as a prompt-injection attempt to those models and gets refused wholesale',
    host: 'opencode',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'onboarding-gate',
    tool: { class: 'file-write', rawName: 'write', filePath: 'src/index.ts', content: 'x' },
  },
  {
    id: 'onboarding.kilo-setup-required',
    notes: 'Kilo shares OpenCode\'s compact deny id — the same cause on both wrapper hosts, which is what one id per CAUSE (not per call site) means',
    host: 'kilo',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'onboarding-gate',
    tool: { class: 'file-write', rawName: 'write_to_file', filePath: 'src/index.ts', content: 'x' },
  },
  {
    id: 'onboarding.cursor-models-required',
    notes: 'Onboarding COMPLETE, subagents team mode, Cursor host: no child may start until the run\'s model policy is frozen against exact Cursor picker ids, and only the hook-owned capture command can repair that -> onboarding-cursor-models-required. Its denyTarget is the pre-minted build run id, which is why the snapshot stores denyTarget as a SHAPE (run-id) rather than the value',
    host: 'cursor',
    event: 'PreToolUse',
    project: materializedGreenfield,
    expectGate: 'onboarding-gate',
    workspaceRoot: 'cwd',
    tool: { class: 'shell', rawName: 'Bash', command: 'touch apps/web/src/index.ts' },
  },
  {
    id: 'onboarding.repaired-materialization',
    notes: 'Onboarding complete but `.traffic-one/**` was never materialized: the gate converges it inline and FALLS THROUGH to run-id announce / triage (the tool is allowed; refresh prose may ride along). The write is README.md so later gates do not steal the row — a feature-source write on this new-project fixture would continue into plan-main-agent-gate. Catalog id `repaired-materialization` is unused; incomplete/failed/skipped still deny materialization-not-converged',
    host: 'claude',
    event: 'PreToolUse',
    project: onboardedNotMaterialized,
    expectGate: null,
    tool: { class: 'file-write', rawName: 'Write', filePath: 'README.md', content: '# Fixture\n' },
  },
  {
    id: 'onboarding.team-mode-marker-guard',
    notes: 'The agent hand-writes the internal team.modeChangeApproval marker into committed state -> team-mode-marker-guard. Only the UserPromptSubmit hook may mint that marker; a tool-authored one would let a build downgrade itself out of subagents mode without the user ever being asked',
    host: 'claude',
    event: 'PreToolUse',
    project: materializedGreenfield,
    expectGate: 'onboarding-gate',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: '.traffic-one/.one.json',
      content: '{"onboardingComplete":true,"team":{"mode":"subagents","approved":true,"modeChangeApproval":{"at":"2026-01-01T00:00:00.000Z"}}}\n',
    },
  },
  {
    id: 'onboarding.team-mode-downgrade-guard',
    notes: 'The same state file rewritten to team.mode=main-agent with no fresh approval marker -> team-mode-downgrade-guard. Pairs with the case above: one blocks forging the permission, the other blocks acting without it',
    host: 'claude',
    event: 'PreToolUse',
    project: materializedGreenfield,
    expectGate: 'onboarding-gate',
    tool: {
      class: 'file-write',
      rawName: 'Write',
      filePath: '.traffic-one/.one.json',
      content: '{"onboardingComplete":true,"team":{"mode":"main-agent","approved":true}}\n',
    },
  },
  // ── the role-contract ruling, all three rows ──────────────────────────────
  // A host whose per-role contracts cannot be written blocks FILE-CHANGING work
  // and nothing else. The three rows together are the ruling: without the read
  // row it reads as "the session is blocked", and without the healthy row it
  // reads as a predicate that fires on everything. They also cost one gate
  // outcome each, which is the only place this can be characterized — the
  // shortfall was reported into a return value for a whole round before anyone
  // noticed four of five callers discard it.
  {
    id: 'onboarding.role-contracts-unwritable-write',
    notes: 'A mutating write on a materialized Cursor project whose `.cursor/agents` is a plain file -> host-role-contracts-unwritable. The contracts are what constrain a spawned role, so a build proceeding here runs every role unconstrained while every artifact insists materialization succeeded. Asked of DISK on each call rather than of a materialization result, which is why it still fires in this steady state where convergence short-circuits',
    host: 'cursor',
    event: 'PreToolUse',
    project: roleContractsUnwritable,
    expectGate: 'onboarding-gate',
    tool: { class: 'file-write', rawName: 'Write', filePath: 'apps/web/src/components/Widget.tsx', content: 'export default function Widget() { return null; }\n' },
  },
  {
    id: 'onboarding.role-contracts-unwritable-read-allowed',
    notes: 'Same broken project, a READ -> not denied. This is the half of the ruling that keeps it proportionate: an agent can still look at the codebase, and the user can still be told what to repair. A future widening that costs the whole session reds here rather than at a user',
    host: 'cursor',
    event: 'PreToolUse',
    project: roleContractsUnwritable,
    expectGate: null,
    tool: { class: 'file-read', rawName: 'Read', filePath: 'apps/web/src/components/Widget.tsx' },
  },
  {
    id: 'onboarding.role-contracts-healthy-write-not-denied',
    notes: 'The discriminating control: the SAME write on a healthy Cursor project passes the role-contract check and goes on to be judged by the plan gate (plan-guard.write/plan-gate — this fixture has no plan). If the refusal ever stops depending on the planted file, this row moves to onboarding-gate and names it',
    host: 'cursor',
    event: 'PreToolUse',
    project: cursorReady,
    expectGate: 'plan-guard.write',
    tool: { class: 'file-write', rawName: 'Write', filePath: 'apps/web/src/components/Widget.tsx', content: 'export default function Widget() { return null; }\n' },
  },
];
