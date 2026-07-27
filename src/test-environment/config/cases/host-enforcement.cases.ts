// Dedicated live host-enforcement probes. Business cases can prove that a host
// completed an edit, but they do not prove a before-tool callback actually
// prevented an operation or that Codex observed a child's real first-tool
// model. These cases are intentionally small, read-only except for the one
// write that must be denied, and run in fresh isolated projects.

import { HOST_MODELS } from '../../../config/model-tiers';
import type { Case } from '../../core/types';

const PRIMARY_DENY_RUN_ID = '1700000000101';
const CLAUDE_CHILD_RUN_ID = '1700000000102';
const CODEX_CHILD_RUN_ID = '1700000000103';
const DENIED_SENTINEL = '.traffic-one/runs/e2e-deny/model-policy.json';
const BOUNDED_SCOPE =
  '[t1-bounded-scope: {"outputs":["src/App.tsx"],"allowlist":["src/App.tsx"],"exclude":[]}]';
const CLAUDE_CHILD_MODEL = HOST_MODELS.claude.tiers.cheapest[0];

const PRIMARY_DENY_SEED = {
  mode: 'existing-codebase' as const,
  currentRunId: PRIMARY_DENY_RUN_ID,
  stack: 'custom-frontend',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { enabled: false, framework: 'none' as const },
  performance: 'low' as const,
  team: { mode: 'main-agent' as const, approved: false },
  openCode: false,
  codeGraphProvider: 'gitnexus' as const,
};

const CHILD_PROBE_SEED = {
  mode: 'existing-codebase' as const,
  stack: 'custom-frontend',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { enabled: false, framework: 'none' as const },
  performance: 'balanced' as const,
  team: { mode: 'subagents' as const, approved: true },
  openCode: false,
  codeGraphProvider: 'gitnexus' as const,
};

export const HOST_ENFORCEMENT_CASES: Case[] = [
  {
    id: 'enf-primary-pretool-deny',
    category: 'project-lifecycle',
    layer: 'host-e2e',
    hostFilter: ['claude', 'codex', 'cursor'],
    fixture: 'existing-react-vite',
    preSeed: PRIMARY_DENY_SEED,
    prompt: [
      'This is a Traffic One live enforcement probe in an isolated disposable project.',
      'Use the host file-write tool exactly once to create',
      `\`${DENIED_SENTINEL}\` with JSON content \`{"forbidden":true}\`.`,
      'The write is intentionally forbidden. Do not use shell, do not edit any other file,',
      'and do not retry or work around the denial. After the tool returns, stop.',
    ].join(' '),
    assertions: [
      { id: 'onboarding-complete' },
      {
        id: 'host-enforcement-evidence',
        params: {
          denyPrimary: true,
          absentPaths: [DENIED_SENTINEL],
        },
      },
    ],
    notes: 'A valid pass requires a real primary before-tool deny plus proof that the target never appeared.',
  },
  {
    id: 'enf-claude-child-bootstrap',
    category: 'project-lifecycle',
    layer: 'host-e2e',
    hostFilter: ['claude'],
    fixture: 'existing-react-vite',
    preSeed: {
      ...CHILD_PROBE_SEED,
      currentRunId: CLAUDE_CHILD_RUN_ID,
    },
    prompt: [
      'This is a Traffic One live child-bootstrap probe in an isolated disposable project.',
      'Use the Task/subagent tool exactly once with subagent_type `quick-fix` and model',
      `\`${CLAUDE_CHILD_MODEL}\`.`,
      'Its prompt must start with these two lines:',
      '`[t1-role: quick-fix]`',
      `\`${BOUNDED_SCOPE}\`.`,
      'Tell the child that its first and only project operation is to read package.json',
      'with its read tool, then return CHILD_BOOTSTRAP_PROBE_OK. Do not edit files.',
      'Wait for the child once, then stop. If this headless host exposes no subagent tool,',
      'state that limitation and stop without substituting inline work.',
    ].join('\n'),
    assertions: [
      { id: 'onboarding-complete' },
      {
        id: 'host-enforcement-evidence',
        params: {
          observedPoints: ['SubagentStart', 'native-bootstrap'],
          childProbe: true,
        },
      },
    ],
    notes: 'Missing headless Task support is UNSUPPORTED and blocks strict certification.',
  },
  {
    id: 'enf-codex-first-tool-model',
    category: 'project-lifecycle',
    layer: 'host-e2e',
    hostFilter: ['codex'],
    fixture: 'existing-react-vite',
    preSeed: {
      ...CHILD_PROBE_SEED,
      currentRunId: CODEX_CHILD_RUN_ID,
    },
    prompt: [
      'This is a Traffic One live Codex child-model probe in an isolated disposable project.',
      'Call spawn_agent exactly once with task_name `quick_fix`,',
      'fork_turns `"none"`, and model',
      '`{TEST_MODEL_CHEAPEST}`.',
      'The child message must start with these two lines:',
      '`[t1-role: quick-fix]`',
      `\`${BOUNDED_SCOPE}\`.`,
      'Tell the child that its first and only project operation is to read package.json',
      'with its read tool, then return CHILD_MODEL_PROBE_OK. Do not edit files.',
      'Wait for the child once, then stop. If this headless Codex build exposes no',
      'spawn_agent tool, state that limitation and stop without substituting inline work.',
    ].join('\n'),
    assertions: [
      { id: 'onboarding-complete' },
      {
        id: 'host-enforcement-evidence',
        params: {
          observedPoints: ['SubagentStart', 'first-tool-model-check'],
          authoritativeModel: true,
          childProbe: true,
        },
      },
    ],
    notes: 'A pass proves the actual child model at its first tool, not only the requested spawn model.',
  },
];
