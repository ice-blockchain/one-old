// src/config/onboarding.ts
// Onboarding + session-choice knobs: the canonical project-context answer keys,
// the wizard's static question catalog (step copy, options, form fields, and the
// senior-team roster), the team-mode-change approval TTL, and the auth-choice
// state version + "continue without Traffic One" TTL. This file is data-only
// (dependency-free). The dynamic assembly — step ordering, the per-host/plan
// team line-up + model resolution, and answer application — reads these from
// shared/onboarding-server/flow.ts; other knobs are read in
// shared/onboarding/** and modules/session/auth-choice.ts.

// Ask "Do you want to use the Traffic One plugin for this development?" IN THE
// HOST CHAT before anything else happens for an undecided project: no wizard
// server is launched and no onboarding URL is shown until the user answers yes
// (the agent records the answer via the runner's --use / --decline commands).
// When false, onboarding opens directly as before, but the onboarding prompts
// still carry a "don't use Traffic One" decline command. A decline is durable
// per project (stored in the per-user prefs, never inside the repo) until the
// user explicitly asks for Traffic One again. Runtime override:
// TRAFFIC_ONE_ASK_USE_PLUGIN=1|0.
export const ASK_USE_PLUGIN_FIRST = true;

export const PROJECT_CONTEXT_ANSWER_KEYS = [
  'audience',
  'coreFlows',
  'v1Features',
  'rolesAuth',
  'businessModel',
  'payments',
  'admin',
  'dataModel',
  'contentSource',
  'integrations',
  'engagement',
  'successMetrics',
  'constraints',
  'domainSpecific',
] as const;

// ── Wizard question catalog ──────────────────────────────────────────────────
// Static display copy for the onboarding wizard. flow.ts imports these and layers
// on the dynamic fields (resolved team line-up, recommended level/tier, host,
// domain questions). Keep this section data-only — no runtime imports.

export interface StepOption {
  id: string;
  label: string;
  hint?: string;
}

export interface FormField {
  key: string;
  label: string;
  hint?: string;
}

export interface TeamRole {
  role: string;
  label: string;
  blurb: string;
}

export type StepKind = 'single_select' | 'form' | 'finalize' | 'done' | 'text_input';

// The steps that carry static copy (excludes the 'finalize'/'done'/null flow
// states, which flow.ts builds inline).
export type WizardStepId =
  | 'api-key'
  | 'open-code'
  | 'performance'
  | 'team-confirmation'
  | 'code-graph'
  | 'mobile'
  | 'project-context';

export interface StepCopy {
  kind: StepKind;
  title: string;
  question: string;
  options?: StepOption[];
  fields?: FormField[];
}

// The senior-engineer roster, in the order it should read on screen. Labels +
// one-line blurbs are display copy (sourced from src/modules/senior-*/agent.md);
// the per-role tier/model is resolved from PERFORMANCE_CONFIG at display time in
// flow.ts.
export const TEAM_ROLES: TeamRole[] = [
  { role: 'senior-architect', label: 'Architect', blurb: 'Plans the build, public contracts & module map' },
  { role: 'senior-frontend', label: 'Frontend', blurb: 'UI — pages, components, design system, accessibility' },
  { role: 'senior-backend', label: 'Backend', blurb: 'APIs, data, auth, migrations, background jobs' },
  { role: 'senior-reviewer', label: 'Reviewer', blurb: 'Read-only audit before every commit' },
  { role: 'senior-tester', label: 'Tester', blurb: 'Unit, integration & end-to-end tests' },
  { role: 'senior-shipper', label: 'Shipper', blurb: 'Deploy & release — only when you ask' },
];

// Human-friendly label + placeholder for each PROJECT_CONTEXT_ANSWER_KEY, so the
// wizard form reads like questions instead of camelCase identifiers.
export const PROJECT_CONTEXT_FIELDS: FormField[] = [
  { key: 'audience', label: 'Who is it for?', hint: 'Primary users / audience' },
  { key: 'coreFlows', label: 'Core user flows', hint: 'The main things a user does, end to end' },
  { key: 'v1Features', label: 'V1 features', hint: 'What must ship in the first version' },
  { key: 'rolesAuth', label: 'Roles & sign-in', hint: 'User roles and how they authenticate' },
  { key: 'businessModel', label: 'Business model', hint: 'How it makes money — or free / internal' },
  { key: 'payments', label: 'Payments', hint: 'Billing, subscriptions, or checkout?' },
  { key: 'admin', label: 'Admin area', hint: 'What an admin needs to manage' },
  { key: 'dataModel', label: 'Data model', hint: 'Key entities and how they relate' },
  { key: 'contentSource', label: 'Content source', hint: 'Where the data / content comes from' },
  { key: 'integrations', label: 'Integrations', hint: 'Third-party services or APIs to connect' },
  { key: 'engagement', label: 'Engagement', hint: 'Notifications, email, retention' },
  { key: 'successMetrics', label: 'Success metrics', hint: 'How you will measure success' },
  { key: 'constraints', label: 'Constraints', hint: 'Deadlines, budget, tech, compliance' },
  { key: 'domainSpecific', label: 'Anything domain-specific', hint: 'Unique rules or details for this domain' },
];

// Static step copy (the questions now live here, not in agent prose). flow.ts
// layers dynamic fields on top per step (team line-up, recommendations, host).
export const STEP_COPY: Record<WizardStepId, StepCopy> = {
  'api-key': {
    kind: 'text_input',
    title: 'Your API key',
    question: 'Paste your Traffic One API key to activate the plugin. It is a data/telemetry key that helps us make Traffic One better — not a password. You only enter it once; we will only ask again if the key stops working.',
  },
  'open-code': {
    kind: 'single_select',
    title: 'OpenCode',
    question: 'Save tokens by delegating bounded coding tasks to OpenCode (a free coding agent — no account or API key needed)? It implements the task in an isolated git worktree and only a clean diff is applied. Enabling authorizes the bounded task prompts and relevant code context for those delegated units.',
    options: [
      { id: 'enable', label: 'Enable OpenCode delegation' },
      { id: 'not_now', label: 'Not now' },
    ],
  },
  performance: {
    kind: 'single_select',
    title: 'Performance',
    question: 'How do you want to run agents for this build?',
    options: [
      { id: 'high', label: 'High', hint: 'A multi-agent senior team' },
      { id: 'balanced', label: 'Balanced', hint: 'Multi-agent team on cheaper tiers' },
      { id: 'low', label: 'Low', hint: 'Single main agent' },
    ],
  },
  'team-confirmation': {
    kind: 'single_select',
    title: 'Your team',
    question: 'Set by your performance choice — this is the senior team that will build. Start when you are ready, or re-pick performance to change it.',
    options: [
      { id: 'approve', label: 'Start the build' },
      { id: 'repick_performance', label: 'Re-pick performance' },
    ],
  },
  'code-graph': {
    kind: 'single_select',
    title: 'Code Graph',
    question: 'Which provider should we use for the codebase graph?',
    options: [
      { id: 'gitnexus', label: 'GitNexus', hint: 'Node CLI' },
      { id: 'graphify', label: 'graphify', hint: 'Python CLI' },
    ],
  },
  mobile: {
    kind: 'single_select',
    title: 'Mobile App',
    question: 'Do you want a mobile app too?',
    options: [
      { id: 'web_only', label: 'Web only', hint: 'Recommended' },
      { id: 'ionic_capacitor', label: 'Ionic + Capacitor' },
      { id: 'react_native_expo', label: 'React Native / Expo' },
    ],
  },
  'project-context': {
    kind: 'form',
    title: 'About the project',
    question: 'Tell me a bit about what you are building. Everything here is optional — fill what is relevant and I will infer the rest from your request.',
    fields: PROJECT_CONTEXT_FIELDS,
  },
};

export const TEAM_MODE_CHANGE_APPROVAL_TTL_MS = 10 * 60 * 1000;

export const AUTH_CHOICE_STATE_VERSION = 3;
export const AUTH_CHOICE_CONTINUE_TTL_MS = 4 * 60 * 60 * 1000;
