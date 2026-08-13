// src/runners/model-gate/index.ts
// The pre-spawn model-gate command the Cursor orchestrator runs after capturing models, before
// spawning. Fail closed: it NEVER writes `use-fallback` — only the user's chat reply
// (`fallback` / `enable`, parsed in prompt-submit) or an explicit recorded choice in
// model-choice.json unblocks spawns. When picks are missing, prints STOP and exit 2.
//
//   node model-gate.cjs <cwd> [--host=cursor]

import { markModelGatePrompted, readModelChoice } from '../../modules/agent-model/model-choice';
import { cursorUnavailablePicks, formatModelChoiceRequiredStop } from '../../shared/materialize/cursor-eligibility';
import { captureCursorModels, hasFreshCursorModels } from '../../shared/materialize/cursor-models';
import {
  buildCursorSpawnModelMap,
  cursorSpawnContractWarning,
  formatCursorSpawnMapBlock,
  syncCursorSpawnAgentFiles,
} from '../../shared/materialize/cursor-spawn-map';
import { AGENT_ROLES } from '../../config/performance';
import { detectHostPlan } from '../../shared/host/plan';
import { obj } from '../../shared/obj';
import { ensureCurrentRunId, isNewProjectMode, readEffectiveState } from '../../shared/state';
import { ensureRunModelPolicy, readRunModelPolicy } from '../../shared/run-model-policy';

function cursorModelCaptureStop(): string {
  return (
    'traffic-one model-gate: STOP — Cursor model capture is missing or stale.\n'
    + 'The build is paused before spawning the senior team because the local Cursor model capture '
    + 'is not fresh for your current plan/catalog.\n'
    + 'Enumerate the Cursor Task/Subagent model list, run model-gate with `--capture-models <exact ids...>`, then run model-gate again. '
    + 'Do not spawn subagents yet.'
  );
}

function modelGateFailedStop(): string {
  return (
    'traffic-one model-gate: STOP — could not verify Cursor model availability.\n'
    + 'Failing closed so Traffic One does not silently choose fallback models. Re-run the model capture/model-gate step before spawning subagents.'
  );
}

function writeSpawnReady(cwd: string, state: Record<string, unknown>, headline: string): boolean {
  const map = buildCursorSpawnModelMap(cwd, state);
  if (AGENT_ROLES.some((role) => !map[role])) return false;
  const contracts = syncCursorSpawnAgentFiles(cwd, state);
  process.stdout.write(`${headline}\n`);
  // This map is the authoritative one the orchestrator spawns from, and for a
  // new project the `.cursor/agents/**` contracts were written by the same
  // build — so the role-named type is not in the session's captured type set
  // and recommending it guarantees a "Couldn't start" on the first spawn.
  const block = formatCursorSpawnMapBlock(map, isNewProjectMode(state));
  if (block) process.stdout.write(`${block}\n`);
  // The map's closing instruction is "tell the child to read
  // `.cursor/agents/<role>.md`". When that file could not be written, saying so
  // is the difference between an orchestrator that adapts and one that hands
  // every child a path to nothing — which is what this gate did silently.
  const warning = cursorSpawnContractWarning(contracts);
  if (warning) process.stdout.write(`${warning}\n`);
  return true;
}

export function runModelGate(argv: readonly string[] = process.argv.slice(2)): number {
  const cwd = argv.find((a) => !a.startsWith('--')) || process.cwd();
  try {
    const captureAt = argv.indexOf('--capture-models');
    if (captureAt >= 0) {
      let models: unknown[] = argv.slice(captureAt + 1).filter((value) => !value.startsWith('--host='));
      if (models.length === 1 && typeof models[0] === 'string' && models[0].trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(models[0]);
          if (Array.isArray(parsed)) models = parsed;
        } catch {
          // The normal repeated-argument format below will reject the invalid id.
        }
      }
      if (!captureCursorModels(cwd, models, detectHostPlan('cursor'))) {
        process.stdout.write('traffic-one model-gate: STOP — no valid Cursor model ids were captured.\n');
        return 2;
      }
      process.stdout.write('traffic-one model-gate: Cursor model list saved to local per-user project preferences.\n');
      return 0;
    }

    // This runner is Cursor-only even when the parent process was launched from
    // another installed host. Resolve Cursor's host-scoped Performance target;
    // otherwise immutable policy creation can compare a Codex/Claude target to
    // the Cursor catalog and fail closed for the wrong reason.
    const cursorEnv = { ...process.env, TRAFFIC_ONE_HOST: 'cursor' };
    const state = readEffectiveState(cwd, cursorEnv) as Record<string, unknown> | null;
    if (!state) {
      process.stdout.write(`${modelGateFailedStop()}\n`);
      return 2;
    }

    const team = obj(state.team);
    if (team?.mode === 'subagents') {
      const runId = ensureCurrentRunId(cwd, state);
      const existingPolicy = runId ? readRunModelPolicy(cwd, runId) : null;
      if (!existingPolicy && isNewProjectMode(state) && !hasFreshCursorModels(cwd, detectHostPlan('cursor'))) {
        process.stdout.write(`${cursorModelCaptureStop()}\n`);
        return 2;
      }
      const policy = existingPolicy || (runId
        ? ensureRunModelPolicy(cwd, runId, 'cursor', state, cursorEnv)
        : null);
      if (!policy || policy.host !== 'cursor') {
        process.stdout.write(`${modelGateFailedStop()}\n`);
        return 2;
      }
    }

    const picks = state ? cursorUnavailablePicks(cwd, state) : [];
    if (!picks.length) {
      return writeSpawnReady(cwd, state, 'traffic-one model-gate: all picked models are available — spawn the team now.')
        ? 0
        : 2;
    }

    const runId = state ? ensureCurrentRunId(cwd, state) : '';
    const choice = runId ? readModelChoice(cwd, runId) : null;

    if (choice === 'use-fallback') {
      const list = picks.map((p) => `${p.role} → ${p.fallback}`).join(', ');
      return writeSpawnReady(
        cwd,
        state,
        `traffic-one model-gate: fallback confirmed — ${list}. Spawn the team now (use the spawn map below).`,
      ) ? 0 : 2;
    }

    if (choice === 'enable-retry') {
      const models = Array.from(new Set(picks.map((p) => p.expected))).join(', ');
      process.stdout.write(
        `traffic-one model-gate: STOP — you chose enable/retry. Enable ${models} in Cursor Settings → Models, `
        + 're-run the internal `--capture-models` command, clear model-choice if needed, then re-run.\n',
      );
      return 2;
    }

    if (state) {
      const stop = formatModelChoiceRequiredStop(cwd, state);
      if (stop) {
        markModelGatePrompted(cwd, runId);
        process.stdout.write(`${stop}\n`);
        return 2;
      }
    }

    if (runId) markModelGatePrompted(cwd, runId);
    // No unavailable captured picks → this pause came from a RUNTIME failure
    // (API/usage limit) on a spawned role. Name the recovery inline (A7): the
    // bare "model choice required" line sent agents exploring --help/model-status
    // instead of just relaying the one-word reply to the user.
    process.stdout.write(
      'traffic-one model-gate: STOP — model choice required (build paused).\n'
      + 'A spawned role hit an API/usage-limit or model-availability failure this run. Ask the user to reply in chat with ONE word:\n'
      + '- `fallback` — proceed now on the surfaced fallback/Composer model\n'
      + '- `enable` — after restoring API budget / enabling the model in Cursor Settings → Models; the role retries on it\n'
      + 'Do not re-run model-gate or explore its flags — the chat reply itself unblocks spawning.\n',
    );
    return 2;
  } catch {
    process.stdout.write(`${modelGateFailedStop()}\n`);
    return 2;
  }
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  process.exit(runModelGate(argv));
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.stdout.write(`${modelGateFailedStop()}\n`);
    process.exit(2);
  }
}
