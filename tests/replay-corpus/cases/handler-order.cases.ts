// tests/replay-corpus/cases/handler-order.cases.ts
// Cases whose only job is to make handler PRIORITY load-bearing.
//
// Every other case in this corpus is designed to reach exactly one gate, with
// the fixture arranged so no other gate has an opinion — which is what makes
// each row readable, and also what makes the whole corpus blind to a reorder:
// if only one handler ever wants to deny, its position in the ladder cannot
// change the verdict. Moving session.authoring-guard from priority 5 to 25 was
// seeded into a scratch copy and the corpus absorbed it silently, because all
// three authoring-guard cases run with the plugin's own repo as `cwd`, where
// every other gate stands down (shared/authoring-root.ts).
//
// So these cases are built the opposite way round: two handlers both want to
// deny, with DIFFERENT verdicts, and the snapshot records whichever one the
// pipeline reaches first. Between them they BRACKET session.authoring-guard
// into 0 < priority < 10 — measured by replaying each case against the real
// handler set with authoring-guard forced to -1, 2, 8, 11, 16, 21 and 25:
//
//   priority   -1     2     5*    8    11    16    21    25
//   boundary   auth  a-g   a-g   a-g   onb   onb   onb   onb
//   pre-tool   a-g   a-g   a-g   a-g   onb   onb   onb   onb
//
// (* the shipped value; `auth` = session.auth, `a-g` = session.authoring-guard,
// `onb` = onboarding-gate.) Nothing is registered between 5 and 10, so this is
// the tightest bracket the current registry admits.
//
// Both cases target the plugin repo from a NORMAL project's cwd, which is the
// shape that creates the contention: authoring-guard fires on the write TARGET
// (an absolute path inside an authoring root) while every other gate judges the
// project the call was made FROM — so both have jurisdiction at once. The
// existing authoring-guard cases in session-guards.cases.ts run inside the
// plugin repo instead and are unaffected by any reorder; these are their
// order-sensitive counterparts, not replacements.

import * as path from 'path';
import type { CaseSpec } from '../run-case';
import { AUTH_ENFORCED } from '../env';
import { freshProject } from '../fixtures';

// tests/replay-corpus/cases/*.ts -> repo root. Named as a TARGET only; the call
// is denied in both cases, so nothing is ever written there.
const PLUGIN_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const STRAY_PLUGIN_STATE_FILE = path.join(PLUGIN_REPO_ROOT, '.traffic-one', 'stray.json');

export const HANDLER_ORDER_CASES: CaseSpec[] = [
  {
    id: 'order.authoring-guard-runs-before-onboarding-gate',
    notes: 'A consented but never-onboarded project whose agent writes into the PLUGIN repo\'s .traffic-one/. Two gates have jurisdiction: session.authoring-guard (5) denies on the target, onboarding-gate (10) denies the same mutating call with the setup link (onboarding-server-deny-first). The snapshot records authoring-guard, so this row is the assertion that authoring-guard runs FIRST — and the guard is correctly ordered: a stray write into the plugin\'s own repo must be named as that, not answered with a setup link for a project that is not the problem. Seeded `session.authoring-guard priority 5 -> 25`: this row becomes onboarding-gate/onboarding-server-deny-first, which also trips the expectGate assertion',
    host: 'claude',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'session.authoring-guard',
    tool: { class: 'file-write', rawName: 'Write', filePath: STRAY_PLUGIN_STATE_FILE, content: '{}' },
  },
  {
    id: 'order.auth-gate-runs-before-authoring-guard',
    notes: 'The same project and the same write, with auth enforcement on — which gives session.auth (0) an opinion too, and it wins. The lower bound of the bracket: authoring-guard must stay BELOW the auth gate, because an unauthenticated session has nothing to say about which file was targeted until the key is in place. Seeded `session.authoring-guard priority 5 -> -1`: this row becomes session.authoring-guard/authoring-guard. Note the denyId is onboarding-server-deny-first under session.auth\'s own gate id — the unauthenticated gate delegates to onboardingGate and returns its verdict, the same attribution split auth.enforced-unauthenticated-mutating-shell freezes',
    host: 'claude',
    event: 'PreToolUse',
    project: freshProject,
    expectGate: 'session.auth',
    env: AUTH_ENFORCED,
    tool: { class: 'file-write', rawName: 'Write', filePath: STRAY_PLUGIN_STATE_FILE, content: '{}' },
  },
];
