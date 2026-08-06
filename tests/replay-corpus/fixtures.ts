// tests/replay-corpus/fixtures.ts
// Cheap, obvious-to-read project-state builders. Every builder returns a
// fresh, isolated project directory (a subdirectory of a per-process mkdtemp
// root — never a temp ROOT itself, so shared/authoring-root.ts's
// isMachineConfigRoot does not mistake it for scratch space) and does its
// real on-disk setup through the SAME source writers production uses
// (preseed.ts's writeState/mergeProjectHostPrefs, recordPluginUseChoice,
// ensureRunAgentClaim) — never a hand-rolled JSON shape that could drift from
// what those writers actually produce.

import './env';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HostId } from '../../src/core/types';
import { preseed } from '../../src/test-environment/core/preseed';
import type { PreSeed } from '../../src/test-environment/core/types';
import { recordPluginUseChoice } from '../../src/shared/state/plugin-use';
import { ensureRunAgentClaim } from '../../src/shared/state/run-agent/claims-store';
import { readEffectiveState, readState, writeState } from '../../src/shared/state';
import { isCompletedTrafficOneMaterialization, materializeIfNeeded } from '../../src/modules/agent-model/converge';
import { captureCursorModels } from '../../src/shared/materialize/cursor-models';
import { detectHostPlan } from '../../src/shared/host/plan';
import { ensureRunModelPolicy } from '../../src/shared/run-model-policy';
import { writeModelChoice } from '../../src/modules/agent-model/model-choice';
import { firstEmitThisSession } from '../../src/shared/once';
import { cleanupIsolatedHome } from './env';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 't1-replay-fixtures-'));
let seq = 0;

export function cleanupFixtures(): void {
  // See env.ts's cleanupIsolatedHome for why maxRetries/retryDelay matter here.
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

// The single teardown every entry point registers with `test.after` (see
// replay.test.ts / coverage.test.ts). Both halves are also registered on
// 'exit' as a backstop and both are idempotent, so calling this early simply
// means the tree is gone sooner — which is the point: a full corpus run holds
// ~100 fixture projects plus a synthetic plugin root, and this machine has run
// out of disk from leaked ones before.
export function cleanupReplayTempTrees(): void {
  cleanupFixtures();
  cleanupIsolatedHome();
}

// See env.ts's identical registration for why this is done here, at module
// load, instead of leaving it to each caller: every fixture builder writes
// real files (preseed, materializeIfNeeded, …) under ROOT, and without this
// every replay run — the harness, rebaseline, or an ad-hoc debug script —
// would leak one more fixture tree into the OS tmpdir forever.
process.once('exit', cleanupFixtures);

// A marker file guarantees shared/paths.ts's projectRoot() resolves to
// EXACTLY this directory (see that file's findUp: with no workspaceRoot, the
// walk ceiling equals the start dir, so it never climbs to an ambient
// parent marker — it only ever needs ONE marker to exist right here).
// `name` is deliberately not "traffic-one" — that string alone would trip
// shared/authoring-root.ts's own-repo detector.
function newProjectDir(label: string): string {
  seq += 1;
  const dir = path.join(ROOT, `${String(seq).padStart(3, '0')}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-project', version: '0.0.0', private: true }, null, 2));
  return dir;
}

// ── the fixture write funnels ───────────────────────────────────────────────
// Every fixture below builds its world through three of them (preseed, the
// onboarding-completion stamp, the state merge) plus materializeIfNeeded, and all
// four used to continue silently over a write the consent/path fence refused —
// eight builders called materializeIfNeeded directly before they were funnelled
// through materializeFixtureProject here, which is why that conversion is one
// call site now rather than eight. A
// fixture that does that measures something other than what it names — the reason
// existingCodebaseUndetectable throws, quoting compileVerificationContract — and
// the failure it produces is the worst shape available: the case still runs, the
// gate under test is never reached, and the snapshot records a verdict belonging
// to whichever earlier gate caught the un-onboarded project.
//
// So each funnel takes an EXPECTATION rather than throwing outright. The three
// pre-consent fence fixtures seed deliberately through a closed fence, where the
// refusal IS the claim; they pass 'refused' and are now checked in that direction
// too, which is stronger than the tree-entry count their comment cites.
type FixtureWrite = 'landed' | 'refused';

function assertFixtureWrite(dir: string, what: string, landed: boolean, expect: FixtureWrite): void {
  const file = path.join(dir, '.traffic-one', '.one.json');
  if (expect === 'landed' && !landed) {
    throw new Error(`${what}: the state write fence refused ${file}, so this fixture is not the project it claims to be`);
  }
  if (expect === 'refused' && landed) {
    throw new Error(`${what}: expected the consent fence to refuse ${file}, but the write LANDED — this fixture no longer detects the fence`);
  }
}

function seedFixture(dir: string, ps: PreSeed, expect: FixtureWrite = 'landed'): void {
  assertFixtureWrite(dir, 'preseed', preseed(dir, ps), expect);
}

// Both signals, for the reason the production consumer keeps both: the boolean
// names a refused STAMP, the read-back answers whether the project is actually
// materialized — and neither implies the other (assets can land without a stamp,
// a stamp can land over incomplete assets). A fixture wants the read-back as its
// verdict, because that is what every case built on it will resolve, and the
// boolean as its cause.
function materializeFixtureProject(dir: string, expect: FixtureWrite = 'landed'): void {
  const stamped = materializeIfNeeded(dir);
  const complete = isCompletedTrafficOneMaterialization(dir, readEffectiveState(dir));
  if (expect === 'landed' && !complete) {
    throw new Error(`materializeIfNeeded: ${dir} did not reach a recorded materialization${stamped ? '' : ' (the state write fence refused the stamp)'}, so every case on this fixture would characterize agent-materialization-missing`);
  }
  if (expect === 'refused' && complete) {
    throw new Error(`materializeIfNeeded: ${dir} materialized despite the consent fence — this fixture no longer detects it`);
  }
}

const FIXTURE_PROJECT_CONTEXT = { originalPrompt: 'Build a small fixture app for the Traffic One replay corpus.' };

const DEFAULT_SEED: PreSeed = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { enabled: false, framework: 'none' },
  performance: 'balanced',
  team: { mode: 'subagents', approved: true },
  openCode: false,
  codeGraphProvider: 'gitnexus',
  projectContext: FIXTURE_PROJECT_CONTEXT,
};

// main-agent/low: an existing-codebase fixture used for ordinary orientation/
// write control cases, not team dynamics — subagents mode would route any
// mutating write through the run-team enforcement gate (a hash-valid runtime
// assignment for the CURRENT run), which no fixture without a live run has.
const EXISTING_SEED: PreSeed = {
  mode: 'existing-codebase',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { enabled: false, framework: 'none' },
  performance: 'low',
  team: { mode: 'main-agent', approved: true },
  openCode: false,
  codeGraphProvider: 'gitnexus',
  projectContext: FIXTURE_PROJECT_CONTEXT,
};

// preseed()'s PreSeed shape (src/test-environment/core/types.ts) predates two
// things every fixture below needs, so this stamps them through the SAME
// real reader/writer preseed itself uses (readState/writeState), merged onto
// whatever preseed already wrote — never a hand-rolled shape for anything
// preseed already owns:
//   - `technologies` (onboarding-completeness: hasTechnologyArrays in
//     shared/state/validate.ts) — without it isNewProjectOnboardingIncomplete
//     stays true forever and onboarding-gate never stands down.
//   - `codeGraphAutoRun: false` — DEFAULT_SEED sets codeGraphProvider:
//     'gitnexus' because onboarding-completeness ALSO requires a recognized
//     provider (hasGraphProvider), but leaving auto-run on means the first
//     SessionStart/materialize call in ANY case triggers a REAL `npm install
//     -g gitnexus` into the isolated XDG_STATE_HOME (runners/gitnexus/
//     bootstrap.ts's tryInstall) — a multi-hundred-MB network+disk operation
//     this corpus must never perform. codeGraphAutoRun:false is the
//     documented opt-out bootstrap() itself checks first.
// Exported for fixture-writes.test.ts: no builder exposes a seam between two of
// its own state writes (each one creates its own directory), so the only way to
// fence a funnel's path and still exercise the funnel is to call one directly.
export function stampFixtureOnboardingCompletion(dir: string, expect: FixtureWrite = 'landed'): void {
  const current = readState(dir);
  assertFixtureWrite(dir, 'onboarding-completion stamp', writeState(dir, {
    ...current,
    technologies: { frontend: [], backend: [], mobile: [] },
    codeGraphAutoRun: false,
  }), expect);
}

// Merge extra committed-state fields (deploy/security stamps, …) through the
// same real writer, preserving everything preseed already wrote. writeState
// replaces the whole document, so the read-merge-write shape is mandatory
// rather than stylistic.
function mergeFixtureState(dir: string, patch: Record<string, unknown>): void {
  assertFixtureWrite(dir, 'fixture state merge', writeState(dir, { ...readState(dir), ...patch }), 'landed');
}

// The session id every fixture that pre-burns a once-per-session marker keys on.
// Cases that use such a fixture MUST send the same id in `raw.session_id`,
// otherwise hookSessionIdentity resolves a different session and the marker the
// fixture burned is invisible.
export const FIXTURE_SESSION_ID = 'replay-corpus-session';

// The captured Cursor picker list that produces the "picked model unavailable"
// pause, derived from config/model-tiers.ts's cursor rows rather than invented:
// each row is `[preferred, ...alternates]` and matching is by FAMILY prefix
// (modelMatchesExpected), so a list holding an ALTERNATE of a tier but not its
// preferred model is exactly the state the pause describes —
//
//   balanced ['gpt-5.6-terra', 'claude-sonnet-5', composer] : preferred absent,
//     'claude-sonnet-5-thinking-high' matches the alternate -> every balanced
//     role is an unavailable pick with a real fallback to offer.
//   cheapest [composer, 'gpt-5.4-mini', 'gpt-5.6-luna'] : 'composer-2.5-fast'
//     matches the floor, so the tier is COVERED and the role is skipped
//     (cursor-eligibility.ts never reports a /^composer/ pick as unavailable).
//
// Both matter: missingCursorPolicyTiers (run-model-policy-schema.ts) refuses to
// freeze a policy while ANY role's tier has no captured match, and without a
// frozen policy onboarding-gate denies `onboarding-cursor-models-required`
// first and the model-choice gate never runs. A list covering NO tier — the
// obvious way to write this — is that unreachable shape.
const CURSOR_MODELS_MISSING_PREFERRED_PICKS = ['claude-sonnet-5-thinking-high', 'composer-2.5-fast'];

// ── project states ──────────────────────────────────────────────────────────

/** Never answered "use Traffic One here?" — the ask-first fence (plugin-use.ts)
 * permits NO writes at all. Every gate must see this project byte-identical. */
export function undecidedProject(_host: HostId): string {
  return newProjectDir('undecided');
}

/** User said "don't use Traffic One for this project" — every gate stands down. */
export function declinedProject(_host: HostId): string {
  const dir = newProjectDir('declined');
  recordPluginUseChoice(dir, false, 'replay-corpus-fixture');
  return dir;
}

/** Consented, but never onboarded — the brand-new project the wizard has not
 * yet touched. */
export function freshProject(_host: HostId): string {
  const dir = newProjectDir('fresh');
  recordPluginUseChoice(dir, true, 'replay-corpus-fixture');
  return dir;
}

// ── the consent write fence, exercised end to end ───────────────────────────
// The three fixtures below all run the SAME production onboarding sequence
// (preseed → onboarding-completion stamp → materializeIfNeeded) BEFORE any
// answer is recorded, and differ only in the answer that arrives afterwards.
// That ordering is the point: with the fence intact every one of those writes
// is refused — measured, the tree is left at exactly ONE entry, the fixture's
// own package.json, versus 141 for the identical sequence run after a `yes` —
// so all three projects reach the gates byte-identical to a project the
// plugin never touched, and the recorded answer alone decides the verdict.
//
// This is what makes them fence detectors rather than duplicates of
// freshProject/undecidedProject/declinedProject: neuter either half of the
// fence (projectWritesPermitted, or the path fence in shared/fsjson.ts) and
// the onboarding state LANDS, so all three stop being bare projects and their
// rows move to a completely different gate. Verified by seeding both breaks —
// see the notes on the cases in cases/consent-fence.cases.ts.
//
// main-agent/low, like greenfieldMainAgent: under a seeded break these become
// live onboarded projects, and main-agent is the mode whose post-onboarding
// deny is a plain plan gate rather than run-team enforcement — so the broken
// row is a readable verdict instead of an artifact of the fixture's team mode.
function preConsentOnboardingAttempt(label: string, answer: boolean | null): string {
  const dir = newProjectDir(label);
  // 'refused' on every step, asserted rather than assumed: that is what makes
  // these three fence DETECTORS. Neuter either half of the fence and a step
  // LANDS, which now fails the fixture here instead of quietly relocating the
  // case's verdict to a different gate.
  seedFixture(dir, { ...DEFAULT_SEED, performance: 'low', team: { mode: 'main-agent', approved: true } }, 'refused');
  stampFixtureOnboardingCompletion(dir, 'refused');
  materializeFixtureProject(dir, 'refused');
  // The answer, recorded AFTER the writes were attempted — never before.
  if (answer !== null) recordPluginUseChoice(dir, answer, 'replay-corpus-fixture');
  return dir;
}

/** Onboarding writes attempted before the answer, then the user said YES.
 * The fence held, so the project is still un-onboarded and the user gets the
 * setup link — not a materialized project it never agreed to. */
export function preConsentWritesThenConsented(_host: HostId): string {
  return preConsentOnboardingAttempt('pre-consent-then-yes', true);
}

/** Onboarding writes attempted while the question is STILL unanswered — the
 * pending half of the contract ("the project must remain byte-identical"). */
export function preConsentWritesStillPending(_host: HostId): string {
  return preConsentOnboardingAttempt('pre-consent-pending', null);
}

/** Onboarding writes attempted before the answer, then the user said NO — the
 * declined half ("the project stays untouched"). */
export function preConsentWritesThenDeclined(_host: HostId): string {
  return preConsentOnboardingAttempt('pre-consent-then-no', false);
}

/** Onboarding complete, new-project mode, no `.traffic-one/plan.md` yet — the
 * state a scaffolder command (create-next-app, …) would be denied in.
 * Materialized (see materializedGreenfield's comment): onboarding-gate's OWN
 * inline `materializeProjectIfNeeded` convergence runs unconditionally for
 * ANY reaching PreToolUse once onboarding is complete (handler.ts's
 * `materialized` branch, priority 10 — before every module gate this fixture
 * feeds), so an unmaterialized fixture's first MUTATING call is swallowed by
 * a generic `repaired-materialization` deny before the case's own target gate
 * ever runs. Real projects are in this same already-materialized state by the
 * time an agent's first tool call lands (SessionStart materializes too). */
export function greenfieldNoPlan(host: HostId): string {
  const dir = newProjectDir('greenfield-no-plan');
  recordPluginUseChoice(dir, true, 'replay-corpus-fixture');
  seedFixture(dir, DEFAULT_SEED);
  stampFixtureOnboardingCompletion(dir);
  materializeFixtureProject(dir);
  return dir;
}

/** Same as greenfieldNoPlan, but team.mode is `main-agent` — the state that
 * routes plan/scaffold denies to their main-agent-specific prose+denyId.
 * performance:'low' is required alongside main-agent: teamModeForLevel ties
 * the two together, and a mismatched pair (e.g. balanced+main-agent) makes
 * isNewProjectOnboardingIncomplete true, so onboarding-gate never stands down
 * and every case here would characterize ITS deny instead of scaffold-gate's. */
export function greenfieldMainAgent(host: HostId, seedOverrides: Partial<PreSeed> = {}): string {
  const dir = newProjectDir('greenfield-main-agent');
  recordPluginUseChoice(dir, true, 'replay-corpus-fixture');
  seedFixture(dir, {
    ...DEFAULT_SEED, performance: 'low', team: { mode: 'main-agent', approved: true }, ...seedOverrides,
  });
  stampFixtureOnboardingCompletion(dir);
  materializeFixtureProject(dir);
  return dir;
}

/** Same as greenfieldNoPlan, with the real materialization step already run
 * (via the SAME materializeIfNeeded the agent-model gate itself calls), so
 * `isCompletedTrafficOneMaterialization` reads true and agent-model cases can
 * characterize what happens AFTER that precondition, deterministically —
 * without depending on a gate's own side effect firing mid-case. Accepts seed
 * overrides (performance level, team mode/approval, …) merged over
 * DEFAULT_SEED. */
export function materializedGreenfield(host: HostId, seedOverrides: Partial<PreSeed> = {}): string {
  const dir = newProjectDir('materialized-greenfield');
  recordPluginUseChoice(dir, true, 'replay-corpus-fixture');
  seedFixture(dir, { ...DEFAULT_SEED, ...seedOverrides });
  stampFixtureOnboardingCompletion(dir);
  materializeFixtureProject(dir);
  return dir;
}

/** Onboarding complete, new-project mode, `.traffic-one/plan.md` already
 * written by the architect — a scaffolded greenfield project mid-build.
 * DEFAULT_SEED is mode:'new-project'/stack:'default', which
 * stateRequiresNewProjectMonorepo (shared/hook/paths.ts) puts under the
 * Turborepo layout: plan-readiness denies ANY root-level `src/**` Vite file
 * unconditionally (monorepo-root-vite) regardless of scaffold state, so the
 * app file this fixture seeds must already live under apps/web/, the one
 * path the monorepo gate itself names as correct. */
export function scaffoldedGreenfield(host: HostId): string {
  const dir = greenfieldNoPlan(host);
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), '# Plan\n\nSeeded by the replay corpus fixture.\n');
  fs.mkdirSync(path.join(dir, 'apps', 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'web', 'src', 'App.tsx'), 'export default function App() { return null; }\n');
  return dir;
}

/** A pre-existing codebase Traffic One did not create: onboarding complete in
 * existing-codebase mode, with source files already on disk. Materialized —
 * see greenfieldNoPlan's comment for why an unmaterialized fixture's first
 * mutating call never reaches its target gate. */
export function existingCodebase(host: HostId): string {
  const dir = newProjectDir('existing-codebase');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); // a second, independent project marker
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const already = true;\n');
  recordPluginUseChoice(dir, true, 'replay-corpus-fixture');
  seedFixture(dir, EXISTING_SEED);
  stampFixtureOnboardingCompletion(dir);
  materializeFixtureProject(dir);
  return dir;
}

/** Consented, declared existing-codebase mode, but never onboarded and with
 * NO detectable stack signal on disk (the bare fixture package.json alone) —
 * the one state where onboarding-gate's `step` is genuinely `tech-detect`
 * (flow.ts: only reachable for mode!=='new-project' when detection finds no
 * stack). A plain freshProject can't reach this: detectMode's own heuristic
 * resolves an unmarked directory to 'new-project', whose tech-detect
 * equivalent is the 'open-code' wizard step instead. */
export function existingCodebaseUndetectable(_host: HostId): string {
  const dir = newProjectDir('existing-undetectable');
  recordPluginUseChoice(dir, true, 'replay-corpus-fixture');
  // The mode IS the fixture: without it on disk, detectMode resolves the bare
  // directory to 'new-project' and every case built on this characterizes the
  // 'open-code' wizard step instead of 'tech-detect'. A throw for the reason
  // compileVerificationContract gives — a fixture that continues over a refused
  // write is measuring something other than what it names.
  if (!writeState(dir, { mode: 'existing-codebase' })) {
    throw new Error(`existingCodebaseUndetectable: the state write fence refused ${dir}/.traffic-one/.one.json`);
  }
  return dir;
}

/** Onboarding complete + `.traffic-one/plan.md` written, but team.mode is
 * `main-agent` — the fixture the plan-static cases need. main-agent (not
 * scaffoldedGreenfield's subagents) because a feature-source write under
 * subagents is routed through run-team enforcement FIRST (a hash-valid runtime
 * assignment for the current run, which no fixture without a live run has), and
 * plan-write reports whichever violation fired first — so under subagents every
 * one of these cases would characterize run-team instead of the static check it
 * names. performance:'low' travels with main-agent (see greenfieldMainAgent). */
export function scaffoldedMainAgent(host: HostId, seedOverrides: Partial<PreSeed> = {}): string {
  const dir = greenfieldMainAgent(host, seedOverrides);
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), '# Plan\n\nSeeded by the replay corpus fixture.\n');
  fs.mkdirSync(path.join(dir, 'apps', 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'web', 'src', 'App.tsx'), 'export default function App() { return null; }\n');
  return dir;
}

/** scaffoldedMainAgent AFTER the user declined — a project Traffic One really
 * did onboard, whose owner has since said "don't use Traffic One here". The
 * decline runs through the real writer, so removeDeclinedProjectArtifacts also
 * performs its production cleanup (once-markers and the debug/ activity log go;
 * `.one.json` and plan.md stay).
 *
 * The stand-down this characterizes is caller-addressed and therefore
 * per-gate: session.auth, onboarding-gate, model-choice-gate and plan-guard's
 * five gates each carry their OWN `pluginUseDeclined` early return, and a gate
 * that loses its copy starts denying a project it has no business judging.
 * Pairing this fixture with plan-static.component-placement's exact payload —
 * same tool, same path, same content, opposite consent — is what turns that
 * into one reviewable snapshot row: the permitted twin denies, this one is
 * allowed, and a dropped stand-down anywhere at priority 0-20 collapses the
 * pair.
 *
 * That one write reaches plan-write and nothing past it, so the same fixture
 * also carries three SHELL cases (scaffold 22, deploy 25, library 30) that
 * each pair it with a command the gate at that priority is the only one to
 * recognize — see cases/consent-fence.cases.ts for why the deeper gates need a
 * payload each rather than sharing this one. */
export function declinedScaffolded(host: HostId): string {
  const dir = scaffoldedMainAgent(host);
  recordPluginUseChoice(dir, false, 'replay-corpus-fixture');
  return dir;
}

/** existingCodebase AFTER the user declined — the declined twin of the one
 * fixture whose onboarded backend is Supabase (EXISTING_SEED), and therefore
 * the only project state in which plan-guard's supabase-local gate has any
 * business denying anything at all. declinedScaffolded cannot stand in for it:
 * DEFAULT_SEED's backend is `none`, so that gate reaches its
 * `state.backend !== 'supabase'` stand-down and returns noop() whether or not
 * it still remembers the decline. */
export function declinedExistingCodebase(host: HostId): string {
  const dir = existingCodebase(host);
  recordPluginUseChoice(dir, false, 'replay-corpus-fixture');
  return dir;
}

/** A React Native project: mobile enabled with the expo framework, which is what
 * isNativeState (shared/state/web.ts) keys on — it selects the NATIVE half of
 * plan-static's style/markup rules (NativeWind + native primitives) instead of
 * the web half. Same main-agent/plan.md setup as scaffoldedMainAgent, for the
 * same two reasons. */
export function nativeGreenfield(host: HostId): string {
  const dir = newProjectDir('native-greenfield');
  recordPluginUseChoice(dir, true, 'replay-corpus-fixture');
  seedFixture(dir, {
    ...DEFAULT_SEED,
    performance: 'low',
    team: { mode: 'main-agent', approved: true },
    mobile: { enabled: true, framework: 'react-native-expo' },
  });
  stampFixtureOnboardingCompletion(dir);
  materializeFixtureProject(dir);
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), '# Plan\n\nSeeded by the replay corpus fixture.\n');
  return dir;
}

/** Onboarding complete, but `.traffic-one/**` was never materialized — the state
 * onboarding-gate's own priority-10 convergence repairs, then denies the
 * triggering mutating call (`repaired-materialization`) so the agent re-issues
 * it against the converged tree. Every other onboarded fixture here
 * materializes deliberately to get PAST this deny; this one exists to
 * characterize it. */
export function onboardedNotMaterialized(host: HostId): string {
  const dir = newProjectDir('onboarded-not-materialized');
  recordPluginUseChoice(dir, true, 'replay-corpus-fixture');
  seedFixture(dir, { ...DEFAULT_SEED, performance: 'low', team: { mode: 'main-agent', approved: true } });
  stampFixtureOnboardingCompletion(dir);
  return dir;
}

/** Consented, never onboarded, and the once-per-session onboarding walkthrough
 * marker ALREADY burned for FIXTURE_SESSION_ID — the second and later gated
 * tool call of a setup session, which repeats only the link + wait command
 * (`onboarding-server-deny-repeat`, `windsurf-server-deny-reason-repeat`).
 * Burned through the same firstEmitThisSession the gate itself calls, so the
 * marker's shape can never drift from what the gate reads; doing it here rather
 * than by ordering two cases keeps each case's verdict independent of corpus
 * order. */
export function freshProjectRecipeDelivered(_host: HostId): string {
  const dir = newProjectDir('fresh-recipe-delivered');
  recordPluginUseChoice(dir, true, 'replay-corpus-fixture');
  firstEmitThisSession(dir, 'onboarding-deny-tool', FIXTURE_SESSION_ID);
  return dir;
}

/** Onboarded Cursor project whose FROZEN run model policy prefers models this
 * Cursor build does not offer — the state that pauses a build on "reply
 * `fallback` or `enable`" (model-choice-gate, and plan-write's own pending
 * check).
 *
 * Built the long way round, with the real writers, because neither shortcut is
 * stable or reachable:
 *   - Without a frozen policy, `modelChoiceReplyPending` MINTS a run id on its
 *     first read and then evaluates availability against the (still missing)
 *     policy — so the same project is "pending" on the first read and not
 *     pending on the second, and which gate sees which depends on handler
 *     order.
 *   - With `team.mode: 'subagents'` (DEFAULT_SEED) onboarding-gate freezes the
 *     policy itself at priority 10 and, if it CANNOT (a tier with no captured
 *     match), denies `onboarding-cursor-models-required` before the
 *     model-choice gate at 15 ever runs.
 * Freezing a VALID policy here, from a capture that covers every tier but omits
 * the preferred pick of the balanced one, is the only shape where the pause is
 * both reachable and identical on every read.
 *
 * Cases using this fixture MUST also carry `env: CURSOR_PAID_PLAN` — see
 * CURSOR_MODELS_MISSING_PREFERRED_PICKS and env.ts (a free Cursor plan pins
 * every tier to the Composer floor, where no pick can be unavailable).
 * `choice`: 'pending' leaves the question open; 'answered' records the user's
 * reply through the real writer, which is the state the pre-spawn model-gate
 * command's own approve/reject prompt (agent-model.model-gate) needs. */
export function cursorModelChoice(host: HostId, choice: 'pending' | 'answered' = 'pending'): string {
  const dir = newProjectDir(`cursor-model-choice-${choice}`);
  recordPluginUseChoice(dir, true, 'replay-corpus-fixture');
  const runId = 'replay-fixture-run';
  seedFixture(dir, { ...DEFAULT_SEED, currentRunId: runId });
  stampFixtureOnboardingCompletion(dir);
  materializeFixtureProject(dir);
  captureCursorModels(dir, CURSOR_MODELS_MISSING_PREFERRED_PICKS, detectHostPlan('cursor'));
  ensureRunModelPolicy(dir, runId, 'cursor', readEffectiveState(dir), { ...process.env, TRAFFIC_ONE_HOST: 'cursor' });
  if (choice === 'answered') writeModelChoice(dir, runId, 'use-fallback');
  return dir;
}

/** The HEALTHY Cursor counterpart of cursorModelChoice: onboarded, subagents
 * mode, with a captured picker list that satisfies every role's PREFERRED model,
 * so neither onboarding-gate's capture deny nor the model-choice pause fires and
 * a case can reach the priority-40 spawn gate on Cursor at all.
 *
 * Runs on the DETECTED (free) plan deliberately: config/model-tiers.ts pins all
 * three Cursor free-plan tiers to the Composer floor, so one captured Composer
 * id covers every role's preferred pick — the shortest real state that clears
 * both gates, and the state a Cursor Hobby user is actually in. */
export function cursorReady(host: HostId): string {
  const dir = newProjectDir('cursor-ready');
  recordPluginUseChoice(dir, true, 'replay-corpus-fixture');
  const runId = 'replay-fixture-run';
  seedFixture(dir, { ...DEFAULT_SEED, currentRunId: runId });
  stampFixtureOnboardingCompletion(dir);
  materializeFixtureProject(dir);
  captureCursorModels(dir, ['composer-2.5-fast'], detectHostPlan('cursor'));
  ensureRunModelPolicy(dir, runId, 'cursor', readEffectiveState(dir), { ...process.env, TRAFFIC_ONE_HOST: 'cursor' });
  return dir;
}

/** cursorModelChoice('pending') with the gate's own once-per-session marker
 * already burned for FIXTURE_SESSION_ID — the second and later gated call of a
 * paused session, which is where the SHORT repeat form and the read-only
 * release (isReadOnlyOrientationToolUse) live. Burned through the same
 * firstEmitThisSession the gate calls, for the reasons in
 * freshProjectRecipeDelivered. */
export function cursorModelChoiceDelivered(host: HostId): string {
  const dir = cursorModelChoice(host, 'pending');
  firstEmitThisSession(dir, 'model-choice-deny-tool', FIXTURE_SESSION_ID);
  return dir;
}

/** Onboarding complete with a deploy-relevant stamp already in committed state.
 * The three `deploy-gate-*` causes form a ladder — shipper approval, then a
 * fresh passing security check, then a fingerprint that matches the worktree —
 * so each variant seeds exactly the rung above the one it characterizes.
 *
 * `Date.now()` at BUILD time is deliberate and safe: both windows are 10
 * minutes wide and a whole corpus run takes ~10 seconds, so a stamp minted here
 * is pinned to the "fresh" side of the window for the entire run, never near
 * the boundary the boolean flips at (see env.ts's wall-clock hazard note). */
export function deployStamped(host: HostId, rung: 'approved' | 'security-passed'): string {
  const dir = greenfieldMainAgent(host);
  const now = new Date().toISOString();
  mergeFixtureState(dir, {
    lastShipperApprovalAt: now,
    ...(rung === 'security-passed'
      ? {
        lastSecurityCheckStatus: 'passed',
        lastSecurityCheckAt: now,
        // A literal that cannot equal computeProjectFingerprint's sha256 hex,
        // so this rung lands on the fingerprint MISMATCH cause rather than
        // depending on the fixture tree's actual hash.
        lastSecurityCheckFingerprint: 'not-the-current-fingerprint',
      }
      : {}),
  });
  return dir;
}

/** Onboarding complete, a build in progress: `currentRunId` set and one role
 * holding a live (pending) claim — the state a spawn/reuse gate inspects. */
export function onboardedMidRun(host: HostId): string {
  const dir = scaffoldedGreenfield(host);
  const runId = 'replay-fixture-run';
  // preseed() writes a FULL replacement state (writeState only ever preserves
  // currentRunId/oneMcpReportId across a call — see normalize.ts), which wipes
  // the materializedStack/materializedAt/materializedVersion stamp
  // scaffoldedGreenfield's own materializeIfNeeded already set. Re-run it
  // after, so this fixture stays materialized like every other onboarded one.
  seedFixture(dir, { ...DEFAULT_SEED, currentRunId: runId });
  materializeFixtureProject(dir);
  const state = readEffectiveState(dir);
  ensureRunAgentClaim(dir, state, 'senior-frontend', { session_id: 'replay-fixture-frontend-session' }, {
    toolName: 'Task',
    agentType: 'senior-frontend',
    roleSource: 'spawn-input',
  });
  return dir;
}

/** onboardedMidRun with the ROLE-KEYED pending-claim slot for `quick-fix`
 * planted as a symlink, so minting that role's claim reports `unavailable` and
 * the spawn gate refuses the spawn (spawn-claim-unavailable).
 *
 * A symlink rather than a held lock, and the choice is not cosmetic: the write
 * chokepoint's symlink fence refuses this path before it opens anything, so the
 * mint answers instantly and the case costs the corpus no wall time. Holding the
 * claims lock would reach the same deny through the other cause, at two lock
 * timeouts (~4s) per replay — the gate retries once — and the pid liveness a live
 * owner sentinel needs makes it the more fragile fixture of the two.
 *
 * It is also a real repo shape: a clone that ships anything under
 * `.traffic-one/runs/**` as a symlink, which is exactly the class the fence was
 * added for. The link target is deliberately outside the project.
 *
 * `quick-fix` and not an implementer, measured rather than assumed: the mint for
 * senior-frontend/senior-backend sits BEHIND the architect-phase ladder
 * (isPlanBatchGatedRole), which denies architect-phase-incomplete on any fixture
 * without a published plan and never reaches the claim. quick-fix returns from
 * the top of modelEnforcementGates with the fewest gates ahead of it. */
export function midRunPendingClaimSlotUnwritable(host: HostId): string {
  const dir = onboardedMidRun(host);
  const pending = path.join(dir, '.traffic-one', 'runs', 'replay-fixture-run', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.symlinkSync(path.join(os.tmpdir(), 'traffic-one-replay-elsewhere.json'), path.join(pending, 'quick-fix.json'));
  return dir;
}
