// tests/replay-corpus/cases/consent-fence.cases.ts
// The "use Traffic One here?" consent fence — the newest and most invasive
// contract in the codebase, and the one the rest of the corpus could not feel
// break.
//
// The fence has three states and TWO independent implementations, and the
// corpus has to be sensitive to both:
//
//   - caller-addressed: shared/state/plugin-use.ts's projectWritesPermitted,
//     asked by session-start, the materializer and the decision log;
//   - path-addressed:   projectStateWriteAllowed, enforced inside
//     shared/fsjson.ts / shared/fs-text.ts for every write under a project's
//     `.traffic-one/`;
//   - plus the per-gate `pluginUseDeclined` stand-downs, which are neither —
//     eight separate early returns that each have to remember.
//
// Sensitivity is not free: on an ALREADY-onboarded project the fence changes
// no verdict at all (its whole job there is to stop writes, and a PreToolUse
// gate does not write), so a case built on one is decoration. What the fence
// decides is whether the onboarding writes LAND — so every case below is built
// on a fixture that attempted them at a specific point in the consent
// lifecycle, and reads the answer off the gate that then judges the project.
//
// The first three cases share one payload and one fixture recipe and differ
// only in the recorded answer, so the three states sit next to each other in
// the snapshot as three different rows. Proven against both seeded breaks —
// see each case's notes for the row it moves to.
//
// The per-gate stand-downs then need ONE CASE EACH, which is the part that is
// not obvious and was measured rather than assumed. A gate only ever denies
// commands in its OWN domain: the library gate needs an install, the deploy
// gate a publish, the supabase gate a local-stack lifecycle command, the
// scaffold gate an app scaffolder on a host that ignores materialized
// guidance. A payload outside a gate's domain leaves it at a LATER noop()
// whether or not it still remembers the decline, so it detects nothing there.
// Measured with the whole corpus: `npm add mobx` on a declined project —
// replayed on Windsurf, deliberately the host that gives the scaffold gate its
// best chance — moves only under the library break and stays `allow` under the
// scaffold, supabase and deploy breaks. Sharing one payload across four gates
// buys nothing; the four rows below are what the four stand-downs cost.
//
// They also do not mask one another, which the pipeline's first-deny
// short-circuit (core/pipeline.ts) would otherwise make possible: each payload
// falls in exactly ONE of the four domains, so no case ever has a second awake
// gate ahead of its own. Measured by deleting all four stand-downs at once —
// the experiment that used to leave the whole corpus green — which now moves
// all four rows, each still naming the gate its own case exists for.

import type { CaseSpec } from '../run-case';
import {
  declinedExistingCodebase,
  declinedScaffolded,
  preConsentWritesStillPending,
  preConsentWritesThenConsented,
  preConsentWritesThenDeclined,
} from '../fixtures';

// One mutating call, replayed against all three consent states. A shell
// command rather than a file write so the row cannot be confused with a
// plan-guard path verdict: what is under test is which GATE gets to judge the
// project, not what it thinks of the path.
const MUTATING_SHELL = { class: 'shell', rawName: 'Bash', command: 'touch apps/web/src/Feature.tsx' } as const;

export const CONSENT_FENCE_CASES: CaseSpec[] = [
  {
    id: 'consent.pre-consent-writes-fenced-then-yes',
    notes: 'PERMITTED. The onboarding + materialization writes were attempted before the user answered, and the answer was then YES. The fence held, so the project is still un-onboarded and the user is handed the setup link (onboarding-server-deny-first) rather than a project that materialized itself while the question was open. The load-bearing case of the three: the answer here is `true`, so nothing about the ask-first QUESTION is involved and the row can only move if a pre-consent write landed. Seeded `projectWritesPermitted -> true`: moves to plan-guard.write/plan-main-agent-gate',
    host: 'claude',
    event: 'PreToolUse',
    project: preConsentWritesThenConsented,
    expectGate: 'onboarding-gate',
    tool: MUTATING_SHELL,
  },
  {
    id: 'consent.pre-consent-writes-fenced-still-pending',
    notes: 'PENDING. Same attempted writes, no answer yet — the state the contract calls byte-identical. The gate asks the question instead of judging the project (onboarding-use-plugin-question). Distinct from the DECLINED row below on purpose: pending and declined have been conflated before, and here they produce a deny and an allow respectively. Seeded `projectWritesPermitted -> true`: moves to plan-guard.write/plan-main-agent-gate',
    host: 'claude',
    event: 'PreToolUse',
    project: preConsentWritesStillPending,
    expectGate: 'onboarding-gate',
    tool: MUTATING_SHELL,
  },
  {
    id: 'consent.pre-consent-writes-fenced-then-no',
    notes: 'DECLINED. Same attempted writes, answer NO — every gate stands down and the call is the user\'s own business (control case). The third of the three rows: permitted denies with the setup link, pending denies with the question, declined allows. Insensitive to a projectWritesPermitted break by construction (a decline refuses writes through pluginUseDeclined, a different reader) and that is what makes it the control',
    host: 'claude',
    event: 'PreToolUse',
    project: preConsentWritesThenDeclined,
    expectGate: null,
    tool: MUTATING_SHELL,
  },
  {
    id: 'consent.declined-onboarded-project-stands-down',
    notes: 'The per-gate stand-down, isolated. Byte-identical payload to plan-static.component-placement (same tool, same path, same content, same fixture recipe) with the ONE difference that this project\'s owner declined — so the pair reads as one experiment: the permitted twin denies component-placement, this one is allowed. Reaches deeper than the three above, which are all un-onboarded and therefore judged at priority 10: this fixture is onboarded, scaffolded and materialized, so session.auth, onboarding-gate, model-choice-gate and plan-guard.write all run and all have to honour the decline. Seeded: drop the pluginUseDeclined stand-down from plan-guard/plan-write/index.ts and this row becomes deny plan-guard.write/component-placement',
    host: 'claude',
    event: 'PreToolUse',
    project: declinedScaffolded,
    expectGate: null,
    tool: { class: 'file-write', rawName: 'Write', filePath: 'apps/web/src/Widget.tsx', content: 'export const Widget = () => null;\n' },
  },
  {
    id: 'consent.declined-project-scaffold-gate-stands-down',
    notes: 'plan-guard/scaffold-gate.ts\'s stand-down, which nothing else in the corpus could feel. Windsurf, because the gate is host-scoped to the agents that ignore materialized guidance (hostFlags.ignoresMaterializedGuidance) and returns noop() on Claude before consent is ever consulted — so the four declined plan-guard rows cannot all be one host. The fixture already has plan.md, which satisfies the architect-first branch; the branch that fires is the STACK one, create-next-app against the seeded react-vite frontend, the same deny plan-guard.scaffold-stack-gate-windsurf-nextjs pins on a permitted project. Seeded: drop the pluginUseDeclined stand-down from plan-guard/scaffold-gate.ts and this row becomes deny plan-guard.scaffold/scaffold-stack-gate',
    host: 'windsurf',
    event: 'PreToolUse',
    project: declinedScaffolded,
    expectGate: null,
    tool: { class: 'shell', rawName: 'run_command', command: 'npx create-next-app@latest my-app' },
  },
  {
    id: 'consent.declined-project-supabase-gate-stands-down',
    notes: 'plan-guard/supabase-local-gate.ts\'s stand-down. The one case here that cannot use declinedScaffolded: the gate only judges a project whose onboarded backend is Supabase, and DEFAULT_SEED\'s is `none`, so on that fixture the gate stands down a second time for a reason that has nothing to do with consent and the seeded break stays invisible. declinedExistingCodebase is the exact declined twin of the fixture the permitted case already uses — same recipe, same payload, opposite answer — so the pair reads as one experiment. Seeded: drop the pluginUseDeclined stand-down from plan-guard/supabase-local-gate.ts and this row becomes deny plan-guard.supabase-local/supabase-local-stack-gate',
    host: 'claude',
    event: 'PreToolUse',
    project: declinedExistingCodebase,
    expectGate: null,
    tool: { class: 'shell', rawName: 'Bash', command: 'supabase start' },
  },
  {
    id: 'consent.declined-project-deploy-gate-stands-down',
    notes: 'plan-guard/deploy-gate.ts\'s stand-down, and the sharpest of the four: a production publish is the one command whose deny costs nothing to be wrong about in the permitted direction and everything in this one — a declined project is not Traffic One\'s to hold back from shipping. Byte-identical to plan-guard.deploy-shipper-approval-required (same fixture recipe, same command, same host) with the ONE difference that this owner declined. Seeded: drop the pluginUseDeclined stand-down from plan-guard/deploy-gate.ts and this row becomes deny plan-guard.deploy/deploy-gate-shipper-approval-required',
    host: 'claude',
    event: 'PreToolUse',
    project: declinedScaffolded,
    expectGate: null,
    tool: { class: 'shell', rawName: 'Bash', command: 'vercel deploy --prod' },
  },
  {
    id: 'consent.declined-project-library-gate-stands-down',
    notes: 'plan-guard/handler.ts\'s stand-down (the forbidden-library gate). Same `npm add next` as plan-guard.library-allowlist-forbidden-next, on a project whose owner declined: which dependencies a declined project installs is its own business. The command is `next` rather than `mobx` because only the BLOCKING half of that table denies — mobx is advice now — and a stand-down row has to be seeded from a row that would otherwise refuse. Last of the plan-guard gates at priority 30, so it is also the row that shows the decline surviving the whole ladder rather than only its front. Seeded: drop the pluginUseDeclined stand-down from plan-guard/handler.ts and this row becomes deny plan-guard.library/library-allowlist-forbidden',
    host: 'claude',
    event: 'PreToolUse',
    project: declinedScaffolded,
    expectGate: null,
    tool: { class: 'shell', rawName: 'Bash', command: 'npm add next' },
  },
  {
    id: 'consent.declined-onboarded-session-start-silent',
    notes: 'The one place the DECISION column itself carries a consent verdict: SessionStart on a declined project is `noop`, because session-start.ts stands down at its own pluginUseDeclined check before emitting anything — while every onboarded SessionStart row in lifecycle-events is `context`. Delete that one line and this row becomes `context` too (the pending fence below it returns the setup-pending directive), which is the whole point: it is the only case that pins session.session-start\'s stand-down, and the only consent row in the corpus not judged by a PreToolUse gate',
    host: 'claude',
    event: 'SessionStart',
    project: declinedScaffolded,
    expectGate: null,
  },
];
