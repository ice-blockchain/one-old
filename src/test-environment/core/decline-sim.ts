// src/test-environment/core/decline-sim.ts
// The DECLINE direction of the consent fence, driven at composition level.
//
// The fence has two halves and this tier only ever exercised one. Every case
// here represents an opted-in project, so nothing composed proved the other
// promise: that a user who says "no" gets a project Traffic One never touches.
// shared/state/__tests__/consent-write-fence.test.ts covers it per hook entry
// point, but it says so itself — materializeProjectAssets refuses outright when
// the plugin root is a source checkout, which is what test-preload.mjs pins for
// the whole unit suite. So the write-heaviest thing the product does could not be
// part of that proof. Here the plugin root is the freshly BUILT dist, which is
// the only configuration where materialization is live and therefore the only
// place the decline can be tested against it.
//
// The sequence is deliberate: residue is planted BEFORE the answer (writes that
// beat the question are exactly what removeDeclinedProjectArtifacts exists to
// undo), the answer goes through the runner's own `--decline` handler, and only
// then is the project observed.

import * as fs from 'fs';
import * as path from 'path';

import { STATE_DIR } from '../../config/paths';
import { runClaudeHook } from '../../hooks/claude-entry';
import { materializeProjectFromState } from '../../shared/materialize';
import { planWriteGate } from '../../modules/plan-guard/plan-write';

import { establishCaseConsent, type ConsentFact } from './consent';
import { writeCtx } from './run-sim/write';

const SESSION_ID = 'decline-sim-session';

// Runtime residue a pre-answer turn can leave behind, planted with raw `fs`
// on purpose: the fence would (correctly) refuse to create these through the IO
// chokepoint, and what is being tested is the SWEEP, not the planting. Each one
// is a path DECLINE_ALWAYS_REMOVED names, so a sweep that stops running is
// visible here rather than only in a code review.
const PRE_DECLINE_RESIDUE = [
  path.join('.once', 'setup-link-nudge'),
  path.join('runs', '.once', 'one-mcp-sync-claude'),
  path.join('debug', 'decisions.jsonl'),
] as const;

export interface DeclineProbe {
  consent: ConsentFact;
  /** Residue planted before the answer, and what survived it. */
  residuePlanted: string[];
  residueSurviving: string[];
  /** Every path under `<project>/.traffic-one/` once the hooks have run. */
  stateDirEntries: string[];
  /** Each hook entry point's verdict: it must not throw and must exit 0. */
  hookCalls: Array<{ subcommand: string; exitCode: number; stdoutBytes: number }>;
  /** The real materialization, which a declined project must not get. */
  materialization: { status: string; rules: number; skills: number };
  /**
   * Ordinary development work through the REAL PreToolUse dispatcher. A declined
   * project must be able to keep building: a deny here means the opt-out is a
   * lockout.
   */
  ordinaryWrite: { path: string; allowed: boolean; reason?: string };
  ok: boolean;
  failure?: string;
}

function listStateDir(projectRoot: string): string[] {
  const root = path.join(projectRoot, STATE_DIR);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      out.push(path.relative(projectRoot, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  if (fs.existsSync(root)) out.push(STATE_DIR);
  walk(root);
  return out.sort();
}

function plantPreDeclineResidue(projectRoot: string): string[] {
  const planted: string[] = [];
  for (const rel of PRE_DECLINE_RESIDUE) {
    const target = path.join(projectRoot, STATE_DIR, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'pre-decline runtime residue\n', 'utf8');
    planted.push(path.join(STATE_DIR, rel));
  }
  return planted.sort();
}

// The same entry points shared/state/__tests__/consent-write-fence.test.ts
// drives, so the composed claim and the unit claim are about the same surface.
function hookCalls(projectRoot: string): Array<[string, unknown]> {
  const sourceFile = path.join(projectRoot, 'src', 'login.tsx');
  const preTool = {
    hook_event_name: 'PreToolUse',
    cwd: projectRoot,
    session_id: SESSION_ID,
    tool_name: 'Write',
    tool_input: { file_path: sourceFile, content: 'export const Login = () => null;\n' },
  };
  return [
    ['session-start', { hook_event_name: 'SessionStart', cwd: projectRoot, session_id: SESSION_ID }],
    ['user-prompt-submit', {
      hook_event_name: 'UserPromptSubmit',
      cwd: projectRoot,
      session_id: SESSION_ID,
      prompt: 'add a login page with supabase auth',
    }],
    ['check-onboarding-gate', preTool],
    ['check-plan-write', preTool],
    ['check-library-allowlist', {
      hook_event_name: 'PreToolUse',
      cwd: projectRoot,
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'npm install left-pad' },
    }],
    ['check-agent-model', {
      hook_event_name: 'PreToolUse',
      cwd: projectRoot,
      session_id: SESSION_ID,
      tool_name: 'Task',
      tool_input: { subagent_type: 'senior-backend', prompt: 'do the thing' },
    }],
    // A second SessionStart: once-markers and seq counters behave differently on
    // the second call in one session, and that is where two of the three
    // historical pre-consent writes actually landed.
    ['session-start', { hook_event_name: 'SessionStart', cwd: projectRoot, session_id: SESSION_ID }],
  ];
}

export async function runDeclineProbe(
  projectRoot: string,
  caseFolder: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeclineProbe> {
  const residuePlanted = plantPreDeclineResidue(projectRoot);
  const consent = establishCaseConsent(projectRoot, 'decline', caseFolder, env);

  const calls: DeclineProbe['hookCalls'] = [];
  let failure = '';
  for (const [subcommand, payload] of hookCalls(projectRoot)) {
    try {
      const outcome = await runClaudeHook(subcommand, JSON.stringify(payload), env);
      calls.push({ subcommand, exitCode: outcome.exitCode, stdoutBytes: outcome.stdout.length });
      if (outcome.exitCode !== 0) {
        failure = failure || `${subcommand} exited ${outcome.exitCode}; every host entry must exit 0`;
      }
    } catch (error) {
      calls.push({ subcommand, exitCode: -1, stdoutBytes: 0 });
      failure = failure || `${subcommand} threw: ${String(error)}`;
    }
  }

  // The write-heaviest thing the product does, attempted for real against the
  // built plugin root. A declined project must come away with no rules, no
  // skills and no manifest.
  const materialized = materializeProjectFromState(projectRoot, { trigger: 'decline-sim' });

  // Ordinary development work: an unattributed source write, the shape a user
  // typing in a declined project produces. Verdict only — the gate is PreToolUse
  // and never writes, so nothing lands here either way.
  const ordinaryRel = path.join('src', 'App.tsx');
  const verdict = planWriteGate(writeCtx(
    projectRoot,
    'Write',
    'file-write',
    { file_path: ordinaryRel, content: 'export const App = () => null;\n' },
    { session_id: SESSION_ID },
  ));
  const ordinaryWrite = {
    path: ordinaryRel,
    allowed: verdict.kind !== 'deny',
    ...(verdict.kind === 'deny' ? { reason: (verdict as { reason: string }).reason } : {}),
  };

  const stateDirEntries = listStateDir(projectRoot);
  const residueSurviving = residuePlanted.filter((rel) => fs.existsSync(path.join(projectRoot, rel)));

  return {
    consent,
    residuePlanted,
    residueSurviving,
    stateDirEntries,
    hookCalls: calls,
    materialization: {
      status: materialized.status,
      rules: materialized.result?.rules ?? 0,
      skills: materialized.result?.skills ?? 0,
    },
    ordinaryWrite,
    ok: !failure,
    ...(failure ? { failure } : {}),
  };
}
